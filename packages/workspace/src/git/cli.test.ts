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
import type { CommitResult, GitCommitOptions } from "./commit.js";
import type { GitDiffOptions } from "./diff.js";
import {
  AlreadyInitializedError,
  MissingIdentityError,
  NotARepositoryError,
  PathspecNotFoundError,
} from "./errors.js";
import { createGitClient, type GitClient } from "./index.js";
import type { GitInitOptions } from "./init.js";
import type { GitAddOptions, GitRmOptions } from "./staging.js";
import type { GitStatusOptions, StatusEntry } from "./status.js";

interface FakeCalls {
  clone: GitCloneOptions[];
  diff: GitDiffOptions[];
  init: GitInitOptions[];
  status: GitStatusOptions[];
  add: GitAddOptions[];
  rm: GitRmOptions[];
  commit: GitCommitOptions[];
}

function fakeClient(
  overrides: Partial<GitClient> = {},
  fakes: {
    status?: () => StatusEntry[];
  } = {},
): {
  client: GitClient;
  calls: FakeCalls;
} {
  const calls: FakeCalls = {
    clone: [],
    diff: [],
    init: [],
    status: [],
    add: [],
    rm: [],
    commit: [],
  };
  const client: GitClient = {
    async clone(options) {
      calls.clone.push(options);
    },
    async diff(options = {}) {
      calls.diff.push(options);
      return "";
    },
    async init(options = {}) {
      calls.init.push(options);
    },
    async status(options = {}) {
      calls.status.push(options);
      return fakes.status?.() ?? [];
    },
    async add(options) {
      calls.add.push(options);
    },
    async rm(options) {
      calls.rm.push(options);
    },
    async commit(options): Promise<CommitResult> {
      calls.commit.push(options);
      return { oid: "a".repeat(40) };
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

describe("runGitCli — init argv parsing", () => {
  it("calls init() with cwd as the default dir", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, { argv: ["init"], cwd: "/work" });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Initialized empty Git repository in /work/.git/");
    expect(calls.init).toEqual([{ dir: "/work", defaultBranch: undefined, bare: false }]);
  });

  it("passes --initial-branch / -b through", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["init", "--initial-branch", "trunk"],
      cwd: "/work",
    });
    expect(calls.init[0].defaultBranch).toBe("trunk");
  });

  it("--bare flips the option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["init", "--bare", "/bare"] });
    expect(calls.init[0]).toMatchObject({ dir: "/bare", bare: true });
  });

  it("AlreadyInitializedError maps to exit 128 with a stderr line", async () => {
    const { client } = fakeClient({
      async init() {
        throw new AlreadyInitializedError("/work");
      },
    });
    const res = await runGitCli(client, { argv: ["init"], cwd: "/work" });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("already exists");
  });
});

describe("runGitCli — status argv parsing", () => {
  it("calls status() with cwd as dir and emits porcelain v2 by default", async () => {
    const { client, calls } = fakeClient(
      {},
      {
        status: () => [
          { path: "a.txt", index: "M", worktree: " " },
          { path: "b.txt", index: " ", worktree: "?" },
        ],
      },
    );
    const res = await runGitCli(client, { argv: ["status"], cwd: "/r" });
    expect(res.exitCode).toBe(0);
    expect(calls.status).toEqual([{ dir: "/r" }]);
    expect(res.stdout).toBe("1 M  a.txt\n? b.txt\n");
  });

  it("--short flips to the short format", async () => {
    const { client } = fakeClient(
      {},
      {
        status: () => [{ path: "a.txt", index: "M", worktree: " " }],
      },
    );
    const res = await runGitCli(client, { argv: ["status", "--short"] });
    expect(res.stdout).toBe("M  a.txt\n");
  });

  it("-s is an alias for --short", async () => {
    const { client } = fakeClient(
      {},
      {
        status: () => [{ path: "a.txt", index: "M", worktree: " " }],
      },
    );
    const res = await runGitCli(client, { argv: ["status", "-s"] });
    expect(res.stdout).toBe("M  a.txt\n");
  });

  it("--porcelain=v2 explicitly selects v2", async () => {
    const { client } = fakeClient(
      {},
      {
        status: () => [{ path: "a.txt", index: "M", worktree: " " }],
      },
    );
    const res = await runGitCli(client, { argv: ["status", "--porcelain=v2"] });
    expect(res.stdout).toBe("1 M  a.txt\n");
  });

  it("--porcelain with an unknown value is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["status", "--porcelain=v3"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("unsupported --porcelain value");
  });

  it("NotARepositoryError maps to exit 128", async () => {
    const { client } = fakeClient({
      async status() {
        throw new NotARepositoryError("/no");
      },
    });
    const res = await runGitCli(client, { argv: ["status"], cwd: "/no" });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("not a git repository");
  });

  it("empty status produces empty stdout", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["status"] });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("");
  });
});

describe("runGitCli — add argv parsing", () => {
  it("passes positional pathspecs through", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["add", "a.txt", "b.txt"], cwd: "/r" });
    expect(calls.add).toEqual([{ dir: "/r", paths: ["a.txt", "b.txt"], force: false }]);
  });

  it("--force / -f flips the option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["add", "-f", "a.txt"] });
    expect(calls.add[0].force).toBe(true);
  });

  it("empty argv is an error (matching real git)", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["add"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("nothing specified");
  });

  it("PathspecNotFoundError maps to exit 128", async () => {
    const { client } = fakeClient({
      async add() {
        throw new PathspecNotFoundError("missing.txt");
      },
    });
    const res = await runGitCli(client, { argv: ["add", "missing.txt"] });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("pathspec 'missing.txt'");
  });
});

describe("runGitCli — rm argv parsing", () => {
  it("passes positional pathspecs through", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["rm", "a.txt"], cwd: "/r" });
    expect(calls.rm).toEqual([{ dir: "/r", paths: ["a.txt"] }]);
  });

  it("empty argv is an error", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["rm"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("no pathspec");
  });
});

describe("runGitCli — commit argv parsing", () => {
  it("requires -m <message>", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, { argv: ["commit"] });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("-m <message> is required");
  });

  it("calls commit() with the resolved message and forwards env", async () => {
    const { client, calls } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["commit", "-m", "first"],
      cwd: "/r",
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x" },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("[aaaaaaa] first");
    expect(calls.commit[0]).toMatchObject({
      dir: "/r",
      message: "first",
      env: { GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x" },
    });
  });

  it("--author='Name <email>' parses into author", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, {
      argv: ["commit", "-m", "x", "--author", "Alice <a@x>"],
    });
    expect(calls.commit[0].author).toEqual({ name: "Alice", email: "a@x" });
  });

  it("malformed --author is rejected with exit 129", async () => {
    const { client } = fakeClient();
    const res = await runGitCli(client, {
      argv: ["commit", "-m", "x", "--author", "no-email-here"],
    });
    expect(res.exitCode).toBe(129);
    expect(res.stderr).toContain("malformed --author");
  });

  it("--amend flips the option", async () => {
    const { client, calls } = fakeClient();
    await runGitCli(client, { argv: ["commit", "-m", "x", "--amend"] });
    expect(calls.commit[0].amend).toBe(true);
  });

  it("MissingIdentityError maps to exit 128", async () => {
    const { client } = fakeClient({
      async commit() {
        throw new MissingIdentityError();
      },
    });
    const res = await runGitCli(client, { argv: ["commit", "-m", "x"] });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("author identity unknown");
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

  it("init -> add -> commit -> status round-trip", async () => {
    // Drives the full family-1 surface through a real Workspace,
    // observing the side effects via subsequent CLI calls. If
    // any subcommand drifts from the typed surface, the chain
    // breaks here rather than in a downstream consumer.
    const ws = new Workspace({
      storage: new SQLiteTestStorage(),
      defaultGitIdentity: { name: "Test", email: "test@example.test" },
    });
    await ws.ready();
    const cli = (argv: string[]) => ws.git.cli({ argv, cwd: "/" });

    const initRes = await cli(["init"]);
    expect(initRes.exitCode).toBe(0);
    expect(initRes.stdout).toContain("Initialized empty Git repository");

    await ws.fs.writeFile("/a.txt", "hello\n");
    // status before staging: one untracked entry.
    const status1 = await cli(["status", "--short"]);
    expect(status1.exitCode).toBe(0);
    expect(status1.stdout).toBe(" ? a.txt\n");

    const addRes = await cli(["add", "a.txt"]);
    expect(addRes.exitCode).toBe(0);
    const status2 = await cli(["status", "--short"]);
    // After `add`, isomorphic-git's statusMatrix reports the
    // workdir column as differs-from-HEAD (status 2) rather
    // than equal-to-stage, so the Y column reads 'M'. Real git
    // would refresh and produce 'A '. The XY pair is
    // deterministic; pin it.
    expect(status2.stdout).toBe("AM a.txt\n");

    const commitRes = await cli(["commit", "-m", "init"]);
    expect(commitRes.exitCode).toBe(0);
    expect(commitRes.stdout).toMatch(/^\[[0-9a-f]{7}\] init\n$/);

    // Working tree clean now.
    const status3 = await cli(["status"]);
    expect(status3.exitCode).toBe(0);
    expect(status3.stdout).toBe("");

    // A subsequent init fails with exit 128.
    const initAgain = await cli(["init"]);
    expect(initAgain.exitCode).toBe(128);
    expect(initAgain.stderr).toContain("already exists");
  });

  it("commit without identity surfaces as exit 128", async () => {
    const ws = new Workspace({ storage: new SQLiteTestStorage() });
    await ws.ready();
    await ws.git.cli({ argv: ["init"], cwd: "/" });
    await ws.fs.writeFile("/a.txt", "x\n");
    await ws.git.cli({ argv: ["add", "a.txt"], cwd: "/" });
    const res = await ws.git.cli({ argv: ["commit", "-m", "x"], cwd: "/" });
    expect(res.exitCode).toBe(128);
    expect(res.stderr).toContain("author identity unknown");
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
