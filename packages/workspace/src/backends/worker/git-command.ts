// `git` custom command for the worker-backend's shell isolate.
//
// The shell runs in a Dynamic Worker that has no network access of
// its own (the loader sets `globalOutbound: null` — see worker.ts).
// Every `git` invocation here forwards across the loopback to the
// host DO's `workspace.git.cli(...)`. The actual fetch happens on
// the DO side, which is fine: network-bound subcommands (`clone`,
// `fetch`, `pull`, `push`) work even though the shell isolate
// cannot itself reach the wire.
//
// Keeping this file dumb is deliberate. Argv parsing and every
// behavioural choice for the CLI lives in `git/cli.ts`; this
// file only adapts the just-bash `Command` signature to the
// `GitCliInput` / `GitCliResult` shape the host stub exposes. If
// the JS API and the CLI ever drift, it is because someone
// changed `git/cli.ts`, not because they touched this shim.

import { type CustomCommand, decodeBytesToUtf8, defineCommand } from "just-bash";

import type { GitCliInput, GitCliResult } from "../../git/index.js";

/** Structural subset of the host stub the command needs. */
export interface GitCommandHost {
  git: {
    cli(input: GitCliInput): Promise<GitCliResult>;
  };
}

/**
 * Build a `git` custom command bound to a host workspace stub.
 *
 * Forwards argv, cwd, env, and stdin to the host's
 * `workspace.git.cli(...)`. The env Map from `CommandContext` is
 * flattened into a plain object on the way through — the wire
 * carries JSON, and the CLI dispatcher only reads `GIT_AUTHOR_*` /
 * `GIT_COMMITTER_*` from it today.
 *
 * The closure captures `ws` for the duration of `bash.exec`. The
 * caller (`ShellWorker.exec`) keeps `ws` alive until Bash settles
 * via the existing `finally` block; there's no new disposal
 * contract here.
 */
export function defineGitCommand(ws: GitCommandHost): CustomCommand {
  return defineCommand("git", async (args, ctx) => {
    // Bash gives us the env as a Map<string, string>. The CLI
    // dispatcher takes a plain Record<string, string>; flatten
    // once here so the CLI doesn't have to care.
    const env: Record<string, string> = {};
    for (const [k, v] of ctx.env) env[k] = v;

    try {
      const result = await ws.git.cli({
        argv: args,
        cwd: ctx.cwd,
        env,
        stdin: decodeBytesToUtf8(ctx.stdin),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    } catch (cause) {
      // The CLI dispatcher catches its own subcommand failures and
      // returns them as { exitCode: 1 } results. A throw here means
      // the RPC itself failed (transport hiccup, host stub gone) —
      // surface that as exit 1 with the message on stderr so the
      // shell sees a normal command failure rather than crashing
      // the whole pipeline.
      const message = cause instanceof Error ? cause.message : String(cause);
      return { stdout: "", stderr: `git: ${message}\n`, exitCode: 1 };
    }
  });
}
