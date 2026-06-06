// Integration tests for the observer hook on the public Workspace
// surface. Each test wires a recording observer into a Workspace built
// against in-process fakes and asserts on the resulting span names and
// attributes. The recorder lives in `./observe.test.ts` and is shared
// across both files.

import { SQLiteTestStorage } from "@cloudflare/dofs/testing";
import type { SyncRPC, WorkspaceRPC } from "@cloudflare/workspace-rpc";
import { describe, expect, it } from "vitest";

import type { BackendHandle, WorkspaceBackend } from "./backend.js";
import { makeRecorder, type RecordedSpan } from "./observe-recorder.js";
import { WorkspaceFilesystemStub, WorkspaceShellStub } from "./stub.js";
import { Workspace } from "./workspace.js";

function makeStorage(): SQLiteTestStorage {
  return new SQLiteTestStorage();
}

// Minimal fake SyncRPC. push() and pull() succeed with no changes so the
// observer-side tests can focus on span shape rather than apply logic.
function fakeSync(): SyncRPC {
  return {
    async push(input) {
      // Drain the changes stream to satisfy the wire contract; the fake
      // does not persist anything because the assertion is on spans, not
      // on apply behaviour.
      const reader = input.changes.getReader();
      try {
        while (!(await reader.read()).done) {
          // discard
        }
      } finally {
        reader.releaseLock();
      }
      return { rev: 0, appliedPushRev: input.senderRev };
    },
    async fetchChanges() {
      return {
        currentRev: 0,
        appliedPushRev: 0,
        stream: new ReadableStream<import("@cloudflare/dofs").ChangeEntry>({
          start(c) {
            c.close();
          },
        }),
      };
    },
    async readEntry() {
      return null;
    },
    async hasObjects(hashes) {
      return hashes;
    },
    fetchObjects() {
      return new ReadableStream({
        start(c) {
          c.close();
        },
      });
    },
    async watermarks() {
      return { currentRev: 0, pushRev: 0, fetchRev: 0 };
    },
    async pushObjects(objects) {
      const reader = objects.getReader();
      try {
        while (!(await reader.read()).done) {
          // discard
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

function composite(sync: SyncRPC): WorkspaceRPC {
  const notWired = () => Promise.reject(new Error("shell not wired in this test"));
  return {
    sync,
    shell: {
      exec: notWired,
      getExec: notWired,
      killExec: notWired,
      disposeExec: notWired,
    },
  };
}

function backend(id: string, sync?: SyncRPC): WorkspaceBackend {
  return {
    id,
    async connect(): Promise<BackendHandle> {
      return { rpc: composite(sync ?? fakeSync()), close: async () => {} };
    },
  };
}

function failingBackend(id: string, reason: string): WorkspaceBackend {
  return {
    id,
    connect: () => Promise.reject(new Error(reason)),
  };
}

describe("Workspace observer — connection", () => {
  it("opens one workspace.connect span per backend attempt and tags the backend id", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("primary")],
      observer,
    });
    await ws.ready();
    const connectSpans = observer.spans.filter((s) => s.name === "workspace.connect");
    expect(connectSpans).toHaveLength(1);
    expect(connectSpans[0].attributes["workspace.backend.id"]).toBe("primary");
    expect(connectSpans[0].outcome).toBe("ok");
  });

  it("records each failed backend attempt as a failed span", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [failingBackend("first", "no thanks"), backend("second")],
      observer,
    });
    await ws.ready();
    const connectSpans = observer.spans.filter((s) => s.name === "workspace.connect");
    expect(connectSpans).toHaveLength(2);
    expect(connectSpans[0].attributes["workspace.backend.id"]).toBe("first");
    expect(connectSpans[0].outcome).toBe("error");
    expect(connectSpans[0].attributes["error.message"]).toBe("no thanks");
    expect(connectSpans[1].attributes["workspace.backend.id"]).toBe("second");
    expect(connectSpans[1].outcome).toBe("ok");
  });
});

describe("Workspace observer — sync", () => {
  it("emits workspace.sync.push with the entry count attribute", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("only")],
      observer,
    });
    await ws.ready();
    const pushed = await ws.push();
    const pushSpan = findSpan(observer.spans, "workspace.sync.push");
    expect(pushSpan.outcome).toBe("ok");
    expect(pushSpan.attributes["workspace.sync.pushed"]).toBe(pushed);
  });

  it("emits workspace.sync.pull with applied and skipped counts", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("only")],
      observer,
    });
    await ws.ready();
    await ws.pull();
    const pullSpan = findSpan(observer.spans, "workspace.sync.pull");
    expect(pullSpan.attributes["workspace.sync.applied"]).toBe(0);
    expect(pullSpan.attributes["workspace.sync.skipped"]).toBe(0);
  });
});

describe("Workspace observer — filesystem stub", () => {
  it("emits one workspace.fs.<op> span per stub method call", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("only")],
      observer,
    });
    await ws.ready();
    const fs = new WorkspaceFilesystemStub(ws);

    await fs.writeFile("/a.txt", "hello");
    await fs.readFile("/a.txt", "utf8");
    await fs.stat("/a.txt");
    await fs.readdir("/");
    await fs.mkdir("/sub");
    await fs.rm("/a.txt");

    const fsNames = observer.spans
      .filter((s) => s.name.startsWith("workspace.fs."))
      .map((s) => s.name);
    expect(fsNames).toEqual([
      "workspace.fs.writeFile",
      "workspace.fs.readFile",
      "workspace.fs.stat",
      "workspace.fs.readdir",
      "workspace.fs.mkdir",
      "workspace.fs.rm",
    ]);

    const readdirSpan = findSpan(observer.spans, "workspace.fs.readdir");
    expect(readdirSpan.attributes["workspace.fs.path"]).toBe("/");
    expect(typeof readdirSpan.attributes["workspace.fs.entries"]).toBe("number");
  });

  it("records errors thrown by filesystem operations on the span", async () => {
    const observer = makeRecorder();
    const ws = new Workspace({
      storage: makeStorage(),
      backends: [backend("only")],
      observer,
    });
    await ws.ready();
    const fs = new WorkspaceFilesystemStub(ws);
    await expect(fs.readFile("/missing.txt")).rejects.toBeDefined();
    const span = findSpan(observer.spans, "workspace.fs.readFile");
    expect(span.outcome).toBe("error");
    expect(typeof span.attributes["error.message"]).toBe("string");
  });
});

describe("Workspace observer — shell stub", () => {
  it("wraps the exec bracket in a workspace.shell.exec span with the sync nested underneath", async () => {
    const observer = makeRecorder();

    // The stub kicks off exec on construction, so the shell RPC has to
    // resolve right away. A minimal envelope is enough — the test only
    // asserts on span shape, not on stdout content.
    const execed: string[] = [];
    const shellRpc: import("@cloudflare/workspace-rpc").ShellRPC = {
      async exec(input) {
        execed.push(input.command);
        return {
          id: "exec-1",
          events: new ReadableStream<import("@cloudflare/workspace-rpc").ExecEvent>({
            start(c) {
              c.enqueue({ id: "exec-1", seq: 0, name: "exit", value: 0 });
              c.close();
            },
          }),
        };
      },
      async getExec() {
        throw new Error("not used");
      },
      async killExec() {
        // no-op
      },
      async disposeExec() {
        // no-op
      },
    };

    const ws = new Workspace({
      storage: makeStorage(),
      backends: [
        {
          id: "shelled",
          async connect() {
            return { rpc: { sync: fakeSync(), shell: shellRpc }, close: async () => {} };
          },
        },
      ],
      observer,
    });
    await ws.ready();
    const shellStub = new WorkspaceShellStub(ws);

    using handle = await shellStub.exec("echo hi");
    const result = await handle.result();
    expect(result.exitCode).toBe(0);
    expect(execed).toEqual(["echo hi"]);

    const execSpan = findSpan(observer.spans, "workspace.shell.exec");
    expect(execSpan.outcome).toBe("ok");
    expect(execSpan.attributes["workspace.shell.exit_code"]).toBe(0);
    expect(execSpan.attributes["workspace.shell.pushed"]).toBe(0);
    expect(execSpan.attributes["workspace.shell.pulled"]).toBe(0);
    expect(execSpan.attributes["workspace.shell.skipped"]).toBe(0);

    // Nesting: the bracket runs push → spawn → pull inside the exec
    // span's callback, so all three appear as children on the recorder.
    const childNames = execSpan.children.map((c) => c.name);
    expect(childNames).toContain("workspace.sync.push");
    expect(childNames).toContain("workspace.shell.exec.spawn");
    expect(childNames).toContain("workspace.sync.pull");
  });
});

function findSpan(spans: readonly RecordedSpan[], name: string): RecordedSpan {
  const match = spans.find((s) => s.name === name);
  if (!match) throw new Error(`expected a recorded span named ${name}`);
  return match;
}
