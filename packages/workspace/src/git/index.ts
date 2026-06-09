// Public surface of @cloudflare/workspace/git.
//
// `createGitClient({ ws })` is the one entry point. It binds a
// workspace handle once and returns a `GitClient` whose methods
// don't repeat the workspace argument. Today the typed surface is
// `clone` and `diff`; `cli` is the argv-driven door into the same
// implementations, used by the worker-backend's `git` custom
// command in the shell isolate.
//
// Internally each method lazy-loads its optional peer deps
// (`isomorphic-git`, the http transport, and for `diff` the
// `diff` package) and delegates to `cloneWith` / `diffWith`. The
// loaders are memoised on the client so the dynamic imports fire
// once across the lifetime of the client — without that, the CLI
// would multiply the cost (re-importing isomorphic-git on every
// dispatch) and even the existing JS surface re-imported per call.
//
// `cloneWith` and `diffWith` are still exported for callers that
// bring their own FsClient — tests, custom adapters, running
// against node:fs directly — but the workspace-bound path is the
// only one most consumers need.

import type { SQLiteWorkspaceProvider } from "@cloudflare/dofs";

import { type IsomorphicGitFSClient, workspaceIsomorphicGitClient } from "./adapter.js";
import { type GitCliInput, type GitCliResult, runGitCli } from "./cli.js";
import { cloneWith, type GitCloneOptions, type IsomorphicGitClient } from "./clone.js";
import {
  type CommitResult,
  commitWith,
  type GitCommitOptions,
  type IsomorphicGitCommitClient,
} from "./commit.js";
import {
  type CreatePatchFn,
  diffWith,
  type GitDiffOptions,
  type IsomorphicGitDiffClient,
  type ReadFileFn,
} from "./diff.js";
import { type GitInitOptions, type IsomorphicGitInitClient, initWith } from "./init.js";
import {
  addWith,
  type GitAddOptions,
  type GitRmOptions,
  type IsomorphicGitAddClient,
  type IsomorphicGitRmClient,
  rmWith,
} from "./staging.js";
import {
  type GitStatusOptions,
  type IsomorphicGitStatusClient,
  type StatusEntry,
  statusWith,
} from "./status.js";

export type { GitCliInput, GitCliResult } from "./cli.js";
export type { GitCloneOptions, MessageCallback, ProgressCallback } from "./clone.js";
export type { CommitResult, GitCommitOptions } from "./commit.js";
export type { GitDiffOptions, StatusRow } from "./diff.js";
export {
  AlreadyInitializedError,
  GitError,
  MissingIdentityError,
  NotARepositoryError,
  PathOutsideRepoError,
  PathspecNotFoundError,
} from "./errors.js";
export type { GitInitOptions } from "./init.js";
export type { GitAddOptions, GitRmOptions } from "./staging.js";
export type { GitStatusOptions, StatusEntry } from "./status.js";

/** Duck-typed workspace handle. Only `.provider()` is required. */
export interface WorkspaceLike {
  provider(): SQLiteWorkspaceProvider;
}

/**
 * Identity used as the author/committer fallback when a commit-
 * producing subcommand isn't passed one explicitly. Today this
 * is plumbed through but unused — the typed surface doesn't yet
 * expose `commit`; phase 3 wires it up.
 */
export interface GitIdentity {
  name: string;
  email: string;
}

/** Methods returned by `createGitClient`. */
export interface GitClient {
  /** Shallow-clone a remote into the bound workspace. */
  clone(options: GitCloneOptions): Promise<void>;
  /** Unified diff between a ref (default HEAD) and the working tree. */
  diff(options?: GitDiffOptions): Promise<string>;
  /** Initialise a new repository in the bound workspace. */
  init(options?: GitInitOptions): Promise<void>;
  /** Describe the working-tree / index / HEAD delta. */
  status(options?: GitStatusOptions): Promise<StatusEntry[]>;
  /** Stage paths into the index. */
  add(options: GitAddOptions): Promise<void>;
  /** Unstage paths from the index. */
  rm(options: GitRmOptions): Promise<void>;
  /** Write the current index to a new commit on HEAD. */
  commit(options: GitCommitOptions): Promise<CommitResult>;
  /**
   * Argv-driven entry point. The worker-backend's `git` custom
   * command dispatches through this; in-process callers can use
   * it too when they want CLI-shaped output.
   */
  cli(input: GitCliInput): Promise<GitCliResult>;
}

export interface CreateGitClientOptions {
  /** Workspace whose provider backs the git operations. */
  ws: WorkspaceLike;
  /**
   * Default identity used by commit-producing subcommands when
   * the caller hasn't passed one explicitly and the relevant
   * `GIT_AUTHOR_*` / `GIT_COMMITTER_*` env vars are absent. Wired
   * through here in phase 1 even though no current subcommand
   * uses it, so the type doesn't churn when `commit` lands.
   */
  defaultIdentity?: GitIdentity;
  /**
   * Test seam for substituting the @platformatic/vfs adapter.
   * Production callers do not pass this.
   */
  adapter?: (provider: SQLiteWorkspaceProvider) => Promise<IsomorphicGitFSClient>;
}

/**
 * Build a git client bound to a workspace.
 *
 * The FsClient is constructed lazily on first use and reused
 * across subsequent calls — `@platformatic/vfs.create()` is cheap
 * but not free, and the workspace provider is stable for the
 * lifetime of the client.
 *
 * An isomorphic-git pack/index cache is also created per client
 * and threaded into every isogit call. Without this, each
 * `readBlob` / `statusMatrix` / `walk` re-parses the packfile
 * from the SQLite-backed VFS — fine for tiny repos, catastrophic
 * for anything with a real history (the difference between a
 * sub-second `diff` and one that hangs for minutes).
 *
 * The dynamic imports for `isomorphic-git`, its HTTP transport,
 * and the `diff` package are memoised on the client too. The
 * first method call pays the cost; every subsequent call (typed
 * or CLI) reuses the resolved modules.
 */
export function createGitClient({
  ws,
  defaultIdentity,
  adapter = workspaceIsomorphicGitClient,
}: CreateGitClientOptions): GitClient {
  let fsPromise: Promise<IsomorphicGitFSClient> | undefined;
  const fs = () => {
    if (!fsPromise) fsPromise = adapter(ws.provider());
    return fsPromise;
  };
  const cache: Record<string, unknown> = {};

  // Memoised module loaders. Each holds the promise returned by
  // the dynamic import so concurrent first-use callers share one
  // import pass, and subsequent callers reuse the resolved module
  // synchronously through the cached promise.
  let gitPromise: Promise<unknown> | undefined;
  let httpPromise: Promise<object> | undefined;
  let createPatchPromise: Promise<CreatePatchFn> | undefined;
  const loadGit = <T>(): Promise<T> => {
    if (!gitPromise) gitPromise = loadIsomorphicGit();
    return gitPromise as Promise<T>;
  };
  const loadHttp = (): Promise<object> => {
    if (!httpPromise) httpPromise = loadDefaultHTTP();
    return httpPromise;
  };
  const loadDiffPatch = (): Promise<CreatePatchFn> => {
    if (!createPatchPromise) createPatchPromise = loadCreatePatch();
    return createPatchPromise;
  };

  const client: GitClient = {
    async clone(options) {
      await cloneWith({
        ...options,
        fs: await fs(),
        git: await loadGit<IsomorphicGitClient>(),
        http: await loadHttp(),
        cache,
      });
    },
    async diff(options = {}) {
      const f = await fs();
      return diffWith({
        ...options,
        fs: f,
        git: await loadGit<IsomorphicGitDiffClient>(),
        createPatch: await loadDiffPatch(),
        readFile: readFileFrom(f),
        cache,
      });
    },
    async init(options = {}) {
      await initWith({
        ...options,
        fs: await fs(),
        git: await loadGit<IsomorphicGitInitClient>(),
      });
    },
    async status(options = {}) {
      return statusWith({
        ...options,
        fs: await fs(),
        git: await loadGit<IsomorphicGitStatusClient>(),
        cache,
      });
    },
    async add(options) {
      await addWith({
        ...options,
        fs: await fs(),
        git: await loadGit<IsomorphicGitAddClient>(),
        cache,
      });
    },
    async rm(options) {
      await rmWith({
        ...options,
        fs: await fs(),
        git: await loadGit<IsomorphicGitRmClient>(),
        cache,
      });
    },
    async commit(options) {
      return commitWith({
        ...options,
        fs: await fs(),
        git: await loadGit<IsomorphicGitCommitClient>(),
        cache,
        defaultIdentity,
      });
    },
    async cli(input) {
      return runGitCli(client, input, { defaultIdentity });
    },
  };
  return client;
}

// isomorphic-git ships both named exports and a default export
// (CJS interop). Callers pull the subset they need via the generic.
async function loadIsomorphicGit<T = unknown>(): Promise<T> {
  try {
    const mod = await import("isomorphic-git");
    return (mod.default ?? mod) as unknown as T;
  } catch (cause) {
    throw new Error(
      "@cloudflare/workspace/git requires isomorphic-git as an optional peer dependency. " +
        "Install isomorphic-git.",
      { cause },
    );
  }
}

async function loadDefaultHTTP(): Promise<object> {
  try {
    const mod = await import("isomorphic-git/http/web");
    return mod.default;
  } catch (cause) {
    throw new Error("Failed to load isomorphic-git/http/web. Install isomorphic-git.", { cause });
  }
}

async function loadCreatePatch(): Promise<CreatePatchFn> {
  try {
    const mod = await import("diff");
    return mod.createPatch;
  } catch (cause) {
    throw new Error(
      "@cloudflare/workspace/git requires `diff` as an optional peer dependency. " +
        "Install `diff`.",
      { cause },
    );
  }
}

function readFileFrom(fs: IsomorphicGitFSClient): ReadFileFn {
  // `fs.promises` is typed as `object` on the public surface; the
  // underlying @platformatic/vfs handle exposes `readFile`. Narrow
  // locally rather than widening the exported type.
  const promises = fs.promises as { readFile: ReadFileFn };
  return (path) => promises.readFile(path);
}
