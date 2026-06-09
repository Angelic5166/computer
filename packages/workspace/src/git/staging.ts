// `git add` and `git rm` — index manipulation.
//
// Both surface an array of `paths` rather than the single
// `filepath` isomorphic-git takes, because the CLI's positional
// arguments naturally come in plural and a `paths: string[]`
// shape removes the per-call loop from every caller.

import {
  GitError,
  isNotARepositoryCause,
  NotARepositoryError,
  PathspecNotFoundError,
} from "./errors.js";

/** Subset of `isomorphic-git`'s API used for `add`. */
export interface IsomorphicGitAddClient {
  add(args: {
    fs: object;
    dir: string;
    filepath: string | string[];
    cache?: object;
    force?: boolean;
  }): Promise<void>;
}

/** Subset of `isomorphic-git`'s API used for `rm`. */
export interface IsomorphicGitRmClient {
  remove(args: { fs: object; dir: string; filepath: string; cache?: object }): Promise<void>;
}

export interface GitAddOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /**
   * Paths to stage, relative to `dir`. Empty array is a no-op
   * (matching `git add` with no arguments — which exits 0 with a
   * usage message; the CLI catches the no-arg case before
   * calling). Absolute or `..`-bearing paths are rejected at the
   * call site.
   */
  paths: string[];
  /**
   * Stage even paths that match `.gitignore`. isomorphic-git's
   * `add` honours ignore patterns by default; pass `true` to
   * override.
   */
  force?: boolean;
}

export interface AddWithDeps extends GitAddOptions {
  git: IsomorphicGitAddClient;
  fs: object;
  cache?: object;
}

export async function addWith(opts: AddWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  if (opts.paths.length === 0) return;
  try {
    // isomorphic-git 1.27+ accepts an array; older versions only
    // accept a single string. We pass the array and let it fan
    // out; the version pinned by the repo (^1.x) supports this.
    await opts.git.add({
      fs: opts.fs,
      dir,
      filepath: opts.paths,
      cache: opts.cache,
      force: opts.force,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    if (looksLikePathspecMiss(cause)) {
      throw new PathspecNotFoundError(firstPathspec(opts.paths), { cause });
    }
    throw new GitError("EADDFAIL", `git add failed: ${errorMessage(cause)}`, { cause });
  }
}

export interface GitRmOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /** Paths to unstage, relative to `dir`. */
  paths: string[];
}

export interface RmWithDeps extends GitRmOptions {
  git: IsomorphicGitRmClient;
  fs: object;
  cache?: object;
}

export async function rmWith(opts: RmWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  for (const filepath of opts.paths) {
    try {
      await opts.git.remove({ fs: opts.fs, dir, filepath, cache: opts.cache });
    } catch (cause) {
      if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
      if (looksLikePathspecMiss(cause)) {
        throw new PathspecNotFoundError(filepath, { cause });
      }
      throw new GitError("ERMFAIL", `git rm failed: ${errorMessage(cause)}`, { cause });
    }
  }
}

function looksLikePathspecMiss(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const m = cause.message.toLowerCase();
  return m.includes("could not find") || m.includes("not in the index") || m.includes("enoent");
}

function firstPathspec(paths: string[]): string {
  return paths[0] ?? "";
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
