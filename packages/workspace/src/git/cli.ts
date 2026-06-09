// Argv-driven git surface.
//
// `runGitCli` is the single dispatcher behind `GitClient.cli` and
// behind the worker-backend's `git` custom command in the shell
// isolate. Each subcommand has its own flag-table-driven parser
// and delegates to the same `GitClient` methods the typed surface
// uses — `cloneWith` / `diffWith` and friends — so the JS API and
// the CLI surface cannot drift in behaviour.
//
// Phase 1 implements only the subcommands the typed surface
// already covers (`clone`, `diff`) plus the trivial `help` and
// `version`. Everything else exits 1 with a stderr line shaped
// like real git's "'<cmd>' is not a git command" so callers can
// match on it.
//
// Identity defaults are threaded through here as a no-op today
// (no commit-producing subcommand yet); they read from
// `input.env.GIT_AUTHOR_*` / `GIT_COMMITTER_*` and fall back to
// the `defaultIdentity` option threaded through `createGitClient`.
// Wiring it up in phase 1 keeps the type stable when phase 3
// lands `commit`.

import type { GitClient, GitIdentity } from "./index.js";

export interface GitCliInput {
  /** Argv as seen by the shell command. `argv[0]` is the subcommand. */
  argv: string[];
  /**
   * Working directory inside the workspace VFS. Subcommands that
   * accept a `dir` flag default to this when the flag is absent.
   * Defaults to `/` if omitted.
   */
  cwd?: string;
  /** Environment variables. Identity defaulting reads from here. */
  env?: Record<string, string>;
  /** Stdin, decoded to UTF-8. Currently unused; reserved for `commit -F -`. */
  stdin?: string;
}

export interface GitCliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunGitCliOptions {
  defaultIdentity?: GitIdentity;
}

// Resolved identity used by commit-producing subcommands. Today
// nothing reads it; phase 3 will. Keeping the resolver in this
// file means env / option precedence lives in one place.
interface ResolvedIdentity {
  author: GitIdentity | undefined;
  committer: GitIdentity | undefined;
}

export async function runGitCli(
  client: GitClient,
  input: GitCliInput,
  options: RunGitCliOptions = {},
): Promise<GitCliResult> {
  // Resolve identity up front so commit-producing subcommands
  // (phase 3) see it through a closure. Unused today; the call
  // keeps `options` live on the dispatcher's surface so the
  // signature doesn't churn when those subcommands land.
  void resolveIdentity(input.env, options.defaultIdentity);
  const argv = input.argv;
  if (argv.length === 0) {
    return printHelp();
  }
  const [sub, ...rest] = argv;
  switch (sub) {
    case "help":
    case "--help":
    case "-h":
      return printHelp();
    case "version":
    case "--version":
      return printVersion();
    case "clone":
      return await runClone(client, rest, input);
    case "diff":
      return await runDiff(client, rest, input);
    default:
      return {
        stdout: "",
        stderr: `git: '${sub}' is not a supported workspace git command\n`,
        exitCode: 1,
      };
  }
}

// ---------------------------------------------------------------
// help / version
// ---------------------------------------------------------------

function printHelp(): GitCliResult {
  const lines = [
    "usage: git <command> [<args>]",
    "",
    "Supported workspace git commands:",
    "   clone    Clone a remote repository into the workspace.",
    "   diff    Show changes between HEAD and the working tree.",
    "   help    Show this help.",
    "   version    Print the workspace git wrapper version.",
    "",
  ];
  return { stdout: `${lines.join("\n")}`, stderr: "", exitCode: 0 };
}

function printVersion(): GitCliResult {
  // Deliberately not impersonating a real git version string.
  // Consumers that fingerprint via `git --version` will see this
  // and can branch on it.
  return {
    stdout: "git version 0.0.0 (@cloudflare/workspace)\n",
    stderr: "",
    exitCode: 0,
  };
}

// ---------------------------------------------------------------
// clone
// ---------------------------------------------------------------

async function runClone(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git clone [--depth N] [--branch B] [--single-branch | --no-single-branch]
  //            [--no-tags] [--bare? rejected] <url> [<dir>]`
  const parsed = parseFlags(args, {
    depth: { kind: "value" },
    branch: { kind: "value", alias: ["b"] },
    "single-branch": { kind: "bool" },
    "no-single-branch": { kind: "bool" },
    "no-tags": { kind: "bool" },
    tags: { kind: "bool" },
  });
  if ("error" in parsed) {
    return { stdout: "", stderr: `git clone: ${parsed.error}\n`, exitCode: 129 };
  }
  const positional = parsed.positional;
  if (positional.length === 0) {
    return { stdout: "", stderr: "git clone: missing <repository>\n", exitCode: 129 };
  }
  if (positional.length > 2) {
    return {
      stdout: "",
      stderr: `git clone: unexpected argument '${positional[2]}'\n`,
      exitCode: 129,
    };
  }
  const [url, dirArg] = positional;
  if (!isSupportedRemoteUrl(url)) {
    return {
      stdout: "",
      stderr: `git clone: unsupported transport for '${url}'. Only https://, http://, and file:// are supported.\n`,
      exitCode: 1,
    };
  }
  const dir = resolveDir(dirArg, input.cwd);

  let depth: number | undefined;
  if (parsed.flags.depth !== undefined) {
    const n = Number.parseInt(parsed.flags.depth as string, 10);
    if (!Number.isFinite(n) || n < 0) {
      return {
        stdout: "",
        stderr: `git clone: --depth requires a non-negative integer (got ${JSON.stringify(parsed.flags.depth)})\n`,
        exitCode: 129,
      };
    }
    depth = n;
  }

  let singleBranch: boolean | undefined;
  if (parsed.flags["single-branch"]) singleBranch = true;
  if (parsed.flags["no-single-branch"]) singleBranch = false;

  let noTags: boolean | undefined;
  if (parsed.flags["no-tags"]) noTags = true;
  if (parsed.flags.tags) noTags = false;

  try {
    await client.clone({
      url,
      dir,
      ref: parsed.flags.branch as string | undefined,
      depth,
      singleBranch,
      noTags,
    });
  } catch (cause) {
    return {
      stdout: "",
      stderr: `git clone: ${errorMessage(cause)}\n`,
      exitCode: 1,
    };
  }
  return {
    stdout: `Cloning into '${dir}'...\n`,
    stderr: "",
    exitCode: 0,
  };
}

// ---------------------------------------------------------------
// diff
// ---------------------------------------------------------------

async function runDiff(
  client: GitClient,
  args: string[],
  input: GitCliInput,
): Promise<GitCliResult> {
  // `git diff [<ref>]`. The wider git diff surface (ref↔ref,
  // paths, etc.) lands in phase 3 alongside the expanded
  // `diffWith`.
  const parsed = parseFlags(args, {});
  if ("error" in parsed) {
    return { stdout: "", stderr: `git diff: ${parsed.error}\n`, exitCode: 129 };
  }
  if (parsed.positional.length > 1) {
    return {
      stdout: "",
      stderr: `git diff: unexpected argument '${parsed.positional[1]}'\n`,
      exitCode: 129,
    };
  }
  const ref = parsed.positional[0];
  const dir = resolveDir(undefined, input.cwd);
  try {
    const output = await client.diff({ dir, ref });
    return { stdout: output, stderr: "", exitCode: 0 };
  } catch (cause) {
    return {
      stdout: "",
      stderr: `git diff: ${errorMessage(cause)}\n`,
      exitCode: 1,
    };
  }
}

// ---------------------------------------------------------------
// argv parser
// ---------------------------------------------------------------

interface FlagSpec {
  kind: "bool" | "value";
  alias?: string[];
}

interface ParsedFlags {
  flags: Record<string, string | boolean>;
  positional: string[];
}

type ParseResult = ParsedFlags | { error: string };

/**
 * Hand-rolled GNU-ish long-option parser.
 *
 *   `--flag` / `--flag=value` / `--flag value` / `-x`
 *   `--` ends flag processing; everything after is positional.
 *
 * Unknown long flags are an error so a typo doesn't silently
 * fall through as a positional. Real git is laxer on this, but
 * the workspace surface is intentionally narrow.
 */
function parseFlags(args: string[], spec: Record<string, FlagSpec>): ParseResult {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const aliasMap = new Map<string, string>();
  for (const [name, s] of Object.entries(spec)) {
    if (s.alias) for (const a of s.alias) aliasMap.set(a, name);
  }

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--") {
      for (i++; i < args.length; i++) positional.push(args[i]);
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
      const s = spec[name];
      if (!s) return { error: `unknown option '--${name}'` };
      if (s.kind === "bool") {
        if (inlineValue !== undefined) {
          return { error: `option '--${name}' does not take a value` };
        }
        flags[name] = true;
        i++;
        continue;
      }
      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
        i++;
        continue;
      }
      const next = args[i + 1];
      if (next === undefined) {
        return { error: `option '--${name}' requires a value` };
      }
      flags[name] = next;
      i += 2;
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const short = arg.slice(1);
      const name = aliasMap.get(short);
      if (!name) return { error: `unknown option '-${short}'` };
      const s = spec[name];
      if (s.kind === "bool") {
        flags[name] = true;
        i++;
        continue;
      }
      const next = args[i + 1];
      if (next === undefined) {
        return { error: `option '-${short}' requires a value` };
      }
      flags[name] = next;
      i += 2;
      continue;
    }
    positional.push(arg);
    i++;
  }
  return { flags, positional };
}

// ---------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------

function resolveDir(dirArg: string | undefined, cwd: string | undefined): string {
  if (dirArg !== undefined && dirArg !== "") {
    return dirArg.startsWith("/") ? dirArg : joinPath(cwd ?? "/", dirArg);
  }
  return cwd ?? "/";
}

function joinPath(base: string, segment: string): string {
  if (base.endsWith("/")) return `${base}${segment}`;
  return `${base}/${segment}`;
}

function isSupportedRemoteUrl(url: string): boolean {
  return url.startsWith("https://") || url.startsWith("http://") || url.startsWith("file://");
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

// Exposed for symmetry with future commit-producing subcommands.
// Unused today but threaded through `runGitCli` so the env / option
// precedence lives in one place.
export function resolveIdentity(
  env: Record<string, string> | undefined,
  fallback: GitIdentity | undefined,
): ResolvedIdentity {
  const e = env ?? {};
  const author = pickIdentity(e.GIT_AUTHOR_NAME, e.GIT_AUTHOR_EMAIL, fallback);
  const committer = pickIdentity(
    e.GIT_COMMITTER_NAME ?? e.GIT_AUTHOR_NAME,
    e.GIT_COMMITTER_EMAIL ?? e.GIT_AUTHOR_EMAIL,
    fallback,
  );
  return { author, committer };
}

function pickIdentity(
  name: string | undefined,
  email: string | undefined,
  fallback: GitIdentity | undefined,
): GitIdentity | undefined {
  if (name && email) return { name, email };
  return fallback;
}
