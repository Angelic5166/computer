// Tests for `runGitCli` — the argv-driven dispatcher behind
// `GitClient.cli` and the worker-backend's `git` custom command.
//
// Two layers covered here:
//
//   1. Argv parsing per subcommand. The hand-rolled parser is the
//      bit most likely to drift as new flags land, so every flag
//      mapping for the phase-1 surface has a happy and a sad
//      path. The `GitClient` is faked so the assertions are on
//      which options the dispatcher passes through, not on real
//      git behaviour.
//
//   2. End-to-end `clone` and `diff` against an in-process
//      Workspace + real `isomorphic-git` + the `diff` package, so
//      a future refactor that loses the wiring between `runGitCli`
//      and `GitClient` shows up as a stdout/stderr failure here.
//      The clone phase is faked — same pattern as
//      `clone.test.ts`'s subset-checkout test — because spinning
//      up a real upload-pack server is out of scope.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import git from "isomorphic-git";
import { describe, expect, it, vi } from "vitest";
import { Workspace } from "../workspace.js";
import { runGitCli } from "./cli.js";
import type { GitCloneOptions } from "./clone.js";
import type { GitDiffOptions } from "./diff.js";
import { createGitClient, type GitClient } from "./index.js";

interface FakeCalls {
  clone: GitCloneOptions[];
  diff: GitDiffOptions[];
}

function fakeClient(overrides: Partial<GitClient> = {}): {
  client: GitClient;
  calls: FakeCalls;
} {
  const calls: FakeCalls = { clone: [], diff: [] };
  const client: GitClient = {
    async clone(options) {
      calls.clone.push(options);
    },
    async diff(options = {}) {
      calls.diff.push(options);
      return "";
    },
    async cli() {
      throw new Error("not reached in these tests");
    },
    ...overrides,
  };
  return { client, calls };
}

describe("runGitCli — dispatch", () => {
  it("prints help when argv is empty", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: [] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("usage: git <command>");
    expect(res.stderr).toBe("");
  });

  it("`help`, `--help`, and `-h` all print help", async () => {
    const { client } = fakeClient();
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const res = await runGitCli(client, { argv });
      expect(res.exitCode, JSON.stringify(argv)).toBe(0);
      expect(res.stdout).toContain("usage: git <command>");
    }
  });

  it("`version` prints a self-identifying version string", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["version"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("@cloudflare/workspace");
  });

  it("unknown subcommands exit 1 with a git-shaped stderr line", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["nope"] });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("'nope' is not a supported workspace git command");
  });
});

describe("runGitCli — clone argv parsing", () => {
  it("forwards a bare URL with default options", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["clone", "https://example.test/r.git"],
      cwd: "/work",
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Cloning into '/work'");
    expect(calls.clone).toEqual([
      {
        url: "https://example.test/r.git",
        dir: "/work",
        ref: undefined,
        depth: undefined,
        singleBranch: undefined,
        noTags: undefined,
      },
    ]);
  });

  it("forwards --depth, --branch (-b), --single-branch, --no-tags", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: [
        "clone",
        "--depth",
        "5",
        "-b",
        "develop",
        "--single-branch",
        "--no-tags",
        "https://example.test/r.git",
        "/dst",
      ],
    });
    expect(res.exitCode).toBe(0);
    expect(calls.clone[0]).toMatchObject({
      url: "https://example.test/r.git",
      dir: "/dst",
      ref: "develop",
      depth: 5,
      singleBranch: true,
      noTags: true,
    });
  });

  it("supports --no-single-branch and --tags (the negated forms)", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["clone", "--no-single-branch", "--tags", "https://example.test/r.git"],
    });
    expect(calls.clone[0]).toMatchObject({
      singleBranch: false,
      noTags: false,
    });
  });

  it("supports --flag=value form", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["clone", "--depth=2", "--branch=main", "https://example.test/r.git"],
    });
    expect(calls.clone[0]).toMatchObject({ depth: 2, ref: "main" });
  });

  it("resolves a relative target dir against cwd", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["clone", "https://example.test/r.git", "sub"],
      cwd: "/work",
    });
    expect(calls.clone[0].dir).toBe("/work/sub");
  });

  it("rejects unknown options with exit 129 and a clear stderr", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["clone", "--bogus", "https://example.test/r.git"],
    });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("unknown option '--bogus'");
  });

  it("rejects --depth with a non-numeric value", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["clone", "--depth", "abc", "https://example.test/r.git"],
    });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("--depth");
  });

  it("rejects clone with no URL", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["clone"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("missing <repository>");
  });

  it("rejects unsupported transports (ssh, git://)", async () => {
    const { client } = fakeClient();
    for (const url of [
      "ssh://git@example.test/r.git",
      "git@example.test:r.git",
      "git://example.test/r.git",
    ]) {
      const res = await runGitCli(client, { argv: ["clone", url] });
      expect(res.exitCode, url).toBe(1);
      expect(res.stderr).toContain("unsupported transport");
    }
  });

  it("surfaces a GitClient.clone rejection as exit 1 with the error on stderr", async () => {
    const { client } = fakeClient({
      async clone() {
        throw new Error("upload-pack 502");
      },
    });
    const res = await runGitCli(client, {
      argv: ["clone", "https://example.test/r.git"],
    });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("upload-pack 502");
  });
});

describe("runGitCli — diff argv parsing", () => {
  it("calls diff() with no ref by default", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["diff"], cwd: "/repo" });
    expect(calls.diff).toEqual([{ dir: "/repo", ref: undefined }]);
  });

  it("passes a positional ref through", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["diff", "v1.0"], cwd: "/repo" });
    expect(calls.diff).toEqual([{ dir: "/repo", ref: "v1.0" }]);
  });

  it("rejects extra positional arguments", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["diff", "a", "b"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("unexpected argument 'b'");
  });

  it("returns the diff text on stdout", async () => {
    const { client } = fakeClient({
      async diff() {
        return "--- a.txt\n+++ a.txt\n@@\n-x\n+y\n";
      },
    });
    const res = await runGitCli(client, { argv: ["diff"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--- a.txt");
  });
});

// ---------------------------------------------------------------
// End-to-end: real Workspace + real isomorphic-git/diff, faked
// clone phase. Matches the pattern in clone.test.ts.
// ---------------------------------------------------------------

describe("runGitCli — end-to-end against an in-process Workspace", () => {
  it("diff prints the working-tree delta against HEAD", async () => {
    const ws = new Workspace({ storage: new SQLiteTestStorage() });
    await ws.ready();

    // Seed a repo with one committed file, then mutate the
    // working tree. We drive isomorphic-git directly through the
    // workspace's FsClient adapter to avoid spinning up an HTTP
    // server.
    const { workspaceIsomorphicGitClient } = await import("./adapter.js");
    const fs = await workspaceIsomorphicGitClient(ws.provider());
    const dir = "/";
    await git.init({ fs: fs as unknown as object, dir, defaultBranch: "main" });
    await ws.fs.writeFile("/a.txt", "hello\n");
    await git.add({ fs: fs as unknown as object, dir, filepath: "a.txt" });
    await git.commit({
      fs: fs as unknown as object,
      dir,
      message: "init",
      author: { name: "t", email: "t@example.test" },
    });
    await ws.fs.writeFile("/a.txt", "hello world\n");

    const res = await ws.git.cli({ argv: ["diff"], cwd: "/" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("--- a.txt");
    expect(res.stdout).toContain("+hello world");
    expect(res.stderr).toBe("");
  });

  it("a clone failure surfaces as exit 1 on stderr", async () => {
    // Force the clone path to fail by pointing at an invalid host;
    // we want to pin that the dispatcher's catch arm produces a
    // CLI-shaped result and doesn't propagate the rejection.
    const ws = new Workspace({ storage: new SQLiteTestStorage() });
    await ws.ready();
    // Swap the git client out for one whose clone rejects, so we
    // don't depend on network reachability inside the test runner.
    const failing: GitClient = createGitClient({
      ws,
      adapter: async () => ({
        promises: {
          readFile: vi.fn(async () => new Uint8Array()),
        },
      }),
    });
    // Replace `clone` with a deterministic failure — the real
    // path is exercised by `clone.test.ts`.
    (failing as { clone: GitClient["clone"] }).clone = async () => {
      throw new Error("could not resolve host");
    };
    const res = await failing.cli({ argv: ["clone", "https://invalid.test/x.git"] });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("could not resolve host");
    expect(res.stdout).toBe("");
  });
});
