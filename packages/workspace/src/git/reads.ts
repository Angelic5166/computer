// Read-only git operations: log, show, revParse, currentBranch,
// lsFiles, lsTree. Each is a thin wrapper around isomorphic-git;
// the wrapper exists to centralise the dir / cache plumbing and
// to throw the typed NotARepositoryError when the gitdir is
// missing.

import { GitError, isNotARepositoryCause, NotARepositoryError } from "./errors.js";

export interface GitPerson {
  name: string;
  email: string;
  /** Seconds since epoch. */
  timestamp: number;
  /** Minutes east of UTC. */
  timezoneOffset: number;
}

export interface CommitView {
  oid: string;
  message: string;
  tree: string;
  parent: string[];
  author: GitPerson;
  committer: GitPerson;
}

export interface TreeEntryView {
  /** 6-digit hex mode as isomorphic-git emits it ('100644', '040000', ...). */
  mode: string;
  /** Entry name (no leading path). */
  path: string;
  oid: string;
  type: "blob" | "tree" | "commit";
}

/** isomorphic-git's subset used here. */
export interface IsomorphicGitReadsClient {
  log(args: { fs: object; dir: string; ref?: string; depth?: number; cache?: object }): Promise<
    Array<{
      oid: string;
      commit: {
        message: string;
        tree: string;
        parent: string[];
        author: GitPerson;
        committer: GitPerson;
      };
    }>
  >;
  readCommit(args: { fs: object; dir: string; oid: string; cache?: object }): Promise<{
    oid: string;
    commit: {
      message: string;
      tree: string;
      parent: string[];
      author: GitPerson;
      committer: GitPerson;
    };
  }>;
  resolveRef(args: { fs: object; dir: string; ref: string }): Promise<string>;
  // isomorphic-git's declared return type is `string | void`
  // for the detached-HEAD case. The actual runtime value is
  // `undefined`; we declare it that way to keep the structural
  // shape JS-friendly.
  currentBranch(args: { fs: object; dir: string; fullname?: boolean }): Promise<string | undefined>;
  listFiles(args: { fs: object; dir: string; ref?: string; cache?: object }): Promise<string[]>;
  readTree(args: {
    fs: object;
    dir: string;
    oid: string;
    filepath?: string;
    cache?: object;
  }): Promise<{
    oid: string;
    tree: Array<{ mode: string; path: string; oid: string; type: string }>;
  }>;
}

export interface BaseReadOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
}

// ---------------------------------------------------------------
// log
// ---------------------------------------------------------------

export interface GitLogOptions extends BaseReadOptions {
  /** Ref to start the walk at. Defaults to HEAD. */
  ref?: string;
  /** Max commits to return. Defaults to unbounded. */
  depth?: number;
}

export interface LogWithDeps extends GitLogOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
  cache?: object;
}

export async function logWith(opts: LogWithDeps): Promise<CommitView[]> {
  const dir = opts.dir ?? "/";
  let entries: Awaited<ReturnType<IsomorphicGitReadsClient["log"]>>;
  try {
    entries = await opts.git.log({
      fs: opts.fs,
      dir,
      ref: opts.ref ?? "HEAD",
      depth: opts.depth,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ELOGFAIL", `git log failed: ${errorMessage(cause)}`, { cause });
  }
  return entries.map((e) => ({
    oid: e.oid,
    message: e.commit.message,
    tree: e.commit.tree,
    parent: e.commit.parent,
    author: e.commit.author,
    committer: e.commit.committer,
  }));
}

// ---------------------------------------------------------------
// show
// ---------------------------------------------------------------

export interface GitShowOptions extends BaseReadOptions {
  /** Object to show. Today: a commit oid or a ref that resolves to one. */
  ref: string;
}

export interface ShowWithDeps extends GitShowOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
  cache?: object;
}

export async function showWith(opts: ShowWithDeps): Promise<CommitView> {
  const dir = opts.dir ?? "/";
  try {
    const oid = await opts.git.resolveRef({ fs: opts.fs, dir, ref: opts.ref });
    const { commit } = await opts.git.readCommit({
      fs: opts.fs,
      dir,
      oid,
      cache: opts.cache,
    });
    return {
      oid,
      message: commit.message,
      tree: commit.tree,
      parent: commit.parent,
      author: commit.author,
      committer: commit.committer,
    };
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ESHOWFAIL", `git show failed: ${errorMessage(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------
// rev-parse
// ---------------------------------------------------------------

export interface GitRevParseOptions extends BaseReadOptions {
  /** Ref to resolve. */
  ref: string;
}

export interface RevParseWithDeps extends GitRevParseOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
}

export async function revParseWith(opts: RevParseWithDeps): Promise<string> {
  const dir = opts.dir ?? "/";
  try {
    return await opts.git.resolveRef({ fs: opts.fs, dir, ref: opts.ref });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EREVPARSEFAIL", `git rev-parse failed: ${errorMessage(cause)}`, { cause });
  }
}

// ---------------------------------------------------------------
// current-branch
// ---------------------------------------------------------------

export interface GitCurrentBranchOptions extends BaseReadOptions {
  /** Return refs/heads/<name> instead of <name>. */
  fullname?: boolean;
}

export interface CurrentBranchWithDeps extends GitCurrentBranchOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
}

/**
 * Returns the current branch name, or `undefined` for detached
 * HEAD (matching `git symbolic-ref -q HEAD`'s exit-1 case).
 */
export async function currentBranchWith(opts: CurrentBranchWithDeps): Promise<string | undefined> {
  const dir = opts.dir ?? "/";
  try {
    const name = await opts.git.currentBranch({
      fs: opts.fs,
      dir,
      fullname: opts.fullname,
    });
    return name ?? undefined;
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ECURRENTBRANCHFAIL", `git symbolic-ref failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------
// ls-files
// ---------------------------------------------------------------

export interface GitLsFilesOptions extends BaseReadOptions {
  /** List files in this ref's tree instead of the index. */
  ref?: string;
}

export interface LsFilesWithDeps extends GitLsFilesOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
  cache?: object;
}

export async function lsFilesWith(opts: LsFilesWithDeps): Promise<string[]> {
  const dir = opts.dir ?? "/";
  try {
    return await opts.git.listFiles({
      fs: opts.fs,
      dir,
      ref: opts.ref,
      cache: opts.cache,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ELSFILESFAIL", `git ls-files failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

// ---------------------------------------------------------------
// ls-tree
// ---------------------------------------------------------------

export interface GitLsTreeOptions extends BaseReadOptions {
  /** Tree-ish to list. */
  ref: string;
  /** Sub-path within the tree. Defaults to the root. */
  path?: string;
}

export interface LsTreeWithDeps extends GitLsTreeOptions {
  git: IsomorphicGitReadsClient;
  fs: object;
  cache?: object;
}

export async function lsTreeWith(opts: LsTreeWithDeps): Promise<TreeEntryView[]> {
  const dir = opts.dir ?? "/";
  try {
    const oid = await opts.git.resolveRef({ fs: opts.fs, dir, ref: opts.ref });
    const { tree } = await opts.git.readTree({
      fs: opts.fs,
      dir,
      oid,
      filepath: opts.path,
      cache: opts.cache,
    });
    return tree.map((e) => ({
      mode: e.mode,
      path: e.path,
      oid: e.oid,
      type: (e.type ?? inferType(e.mode)) as TreeEntryView["type"],
    }));
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("ELSTREEFAIL", `git ls-tree failed: ${errorMessage(cause)}`, {
      cause,
    });
  }
}

function inferType(mode: string): "blob" | "tree" | "commit" {
  if (mode.startsWith("04")) return "tree";
  if (mode === "160000") return "commit";
  return "blob";
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
