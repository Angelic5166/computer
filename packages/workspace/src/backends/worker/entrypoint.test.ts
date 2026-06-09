// Tests for ShellWorker.
//
// The class is a thin shell over Bash. Its job per call:
//   1. Reach the host Workspace through the DO binding wired
//      into env, by id (also wired into env). Both come from
//      the Worker Loader callback the host DO supplied.
//   2. Build a fresh Bash around a WorkspaceFsAdapter wrapping
//      the workspace's fs surface.
//   3. Run the command and frame the result into the NDJSON
//      event stream the WorkerBackend's decoder consumes.
//
// No state survives across exec calls. The same workspace stub
// is fetched per call so concurrent execs can't share an
// out-of-date reference and an OOM in Bash takes nothing else
// with it.

import { describe, expect, it } from "vitest";

import { ShellWorker } from "./entrypoint.js";

// In-isolate harness. ShellWorker is constructed without going
// through workerd; the cloudflare-workers-stub aliases handle
// the WorkerEntrypoint base class.
class TestShellWorker extends ShellWorker {
  // Expose Bash class injection so tests don't need just-bash.
  static withFakeBash<E>(
    env: E,
    bashFactory: (
      command: string,
      options: { cwd?: string; signal?: AbortSignal },
    ) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
  ): TestShellWorker {
    const w = new TestShellWorker(undefined as never, env as never);
    w.bashFactoryOverride = bashFactory;
    return w;
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((acc, c) => acc + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder().decode(buf);
  if (text === "") return [];
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

interface FakeWorkspace {
  fs: {
    readFile: (path: string, encoding: "utf8") => Promise<string>;
    writeFile: (path: string, body: string | Uint8Array) => Promise<void>;
  };
  [Symbol.dispose]?: () => void;
}

interface FakeEnv {
  HOST: {
    getWorkspace(): Promise<FakeWorkspace>;
  };
}

function fakeEnv(opts: { onGetWorkspace?: () => FakeWorkspace } = {}): FakeEnv {
  return {
    HOST: {
      async getWorkspace(): Promise<FakeWorkspace> {
        return (
          opts.onGetWorkspace?.() ?? {
            fs: {
              async readFile() {
                return "";
              },
              async writeFile() {},
            },
          }
        );
      },
    },
  };
}

describe("ShellWorker", () => {
  it("exec returns an envelope with id and a framed event stream", async () => {
    const env = fakeEnv();
    const worker = TestShellWorker.withFakeBash(env, async () => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
    }));
    const envelope = await worker.exec({ command: "echo hello", id: "run-1" });
    expect(envelope.id).toBe("run-1");
    const events = await drain(envelope.events);
    expect(events).toEqual([
      { id: "run-1", seq: 1, name: "stdout", value: "hello\n" },
      { id: "run-1", seq: 2, name: "exit", value: 0 },
    ]);
  });

  it("emits stderr alongside stdout when both are produced", async () => {
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async () => ({
      stdout: "out\n",
      stderr: "err\n",
      exitCode: 2,
    }));
    const events = await drain((await worker.exec({ command: "x" })).events);
    expect((events[0] as { name: string }).name).toBe("stdout");
    expect((events[1] as { name: string }).name).toBe("stderr");
    expect(events[2]).toMatchObject({ name: "exit", value: 2 });
  });

  it("skips empty stdout/stderr events", async () => {
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const events = await drain((await worker.exec({ command: "true" })).events);
    expect(events).toEqual([{ id: expect.any(String), seq: 1, name: "exit", value: 0 }]);
  });

  it("looks up the workspace through env.HOST per call", async () => {
    let getWorkspaceCalls = 0;
    const env = fakeEnv({
      onGetWorkspace: () => {
        getWorkspaceCalls += 1;
        return {
          fs: {
            async readFile() {
              return "";
            },
            async writeFile() {},
          },
        };
      },
    });
    // Concurrent execs in the same isolate get their own stubs;
    // pin this behaviour because it's the property that made us
    // pick the per-call lookup over a stored fs reference.
    const worker = TestShellWorker.withFakeBash(env, async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    await drain((await worker.exec({ command: "a" })).events);
    await drain((await worker.exec({ command: "b" })).events);
    expect(getWorkspaceCalls).toBe(2);
  });

  it("forwards cwd to the Bash factory", async () => {
    let observedCwd: string | undefined;
    const worker = TestShellWorker.withFakeBash(fakeEnv(), async (_command, options) => {
      observedCwd = options.cwd;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    await drain((await worker.exec({ command: "x", cwd: "/workspace/src" })).events);
    expect(observedCwd).toBe("/workspace/src");
  });

  it("getExec without a prior exec throws ENOENT", async () => {
    const worker = new TestShellWorker(undefined as never, fakeEnv() as never);
    await expect(worker.getExec({ id: "missing" })).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("killExec without a prior exec is a no-op", async () => {
    const worker = new TestShellWorker(undefined as never, fakeEnv() as never);
    await expect(worker.killExec({ id: "missing" })).resolves.toBeUndefined();
  });

  it("fetch() rejects plain HTTP with a clear error", async () => {
    const worker = new TestShellWorker(undefined as never, fakeEnv() as never);
    const response = await worker.fetch(new Request("http://shell/", { method: "GET" }));
    expect(response.status).toBe(426);
    expect(await response.text()).toMatch(/Workers RPC/);
  });
});
