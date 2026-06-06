# `@cloudflare/workspace`

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.
>
> The specification under [`docs/`](docs/) is forward-looking — read it for
> intent, not as description of the code today.

Durable Object-side facade for a Cloudflare Workspace. Pairs a local
SQLite-backed VFS (via `@cloudflare/dofs`) with a sync connection to
a `wsd` instance through a pluggable backend.

The public surface lives on three classes:

- `Workspace` — the host-side facade. Owns the local store, the
  backend handle, and the push/pull bracket.
- `WorkspaceStub` — what `workspace.stub()` returns, designed to
  cross the Workers-RPC boundary into another Worker or DO.
- `WorkspaceShell` / `ExecHandle` — the command-execution half of
  the API.

Typical DO-side usage:

```ts
import { Workspace, CloudflareContainerBackend } from "@cloudflare/workspace";
import { DurableObject } from "cloudflare:workers";

export class WsdContainer extends DurableObject<Env> {
  #workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [
      new CloudflareContainerBackend({
        container: () => this.ctx.container!,
        egress: this.ctx.exports.WsdEgress({ props: { id: this.ctx.id.toString() } }),
      }),
    ],
  });

  async getWorkspace(): Promise<WorkspaceStub> {
    await this.#workspace.ready();
    return this.#workspace.stub();
  }
}
```

Worker-side consumption:

```ts
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.WSD.idFromName("user-123");
    using ws = await env.WSD.get(id).getWorkspace();

    await ws.fs.writeFile("/notes.md", "hello");
    using handle = await ws.shell.exec("ls /workspace");
    const { exitCode, stdout } = await handle.result();

    return new Response(stdout, { status: exitCode === 0 ? 200 : 500 });
  },
} satisfies ExportedHandler<Env>;
```

## Observability

The package emits one span per documented operation through an optional
observer hook. Pass an observer to the `Workspace` constructor:

```ts
import { Workspace, type WorkspaceObserver } from "@cloudflare/workspace";

const observer: WorkspaceObserver = {
  async span(name, attributes, run) {
    // Wrap `run` however your tracing backend wants. The Cloudflare
    // runtime, OpenTelemetry, and a plain console.log adapter all fit
    // the same shape.
    return run({ setAttribute: () => {} });
  },
};

const ws = new Workspace({
  storage: this.ctx.storage,
  backends: [...],
  observer,
});
```

The observer's `span(name, attributes, run)` wraps each operation. It
starts a span, runs the callback, and ends the span when the callback
returns or its promise settles. Errors thrown by the work record
`error.name` and `error.message` and propagate.

The span names the package emits today:

- `workspace.connect` — one per `connect()` attempt against a single
  backend. Tagged with `workspace.backend.id`.
- `workspace.sync.push` / `workspace.sync.pull` — one per sync call.
  Tagged with the entry counts (`workspace.sync.pushed`,
  `workspace.sync.applied`, `workspace.sync.skipped`).
- `workspace.shell.exec` — the full exec bracket from the
  `WorkspaceStub`. Contains `workspace.sync.push`,
  `workspace.shell.exec.spawn`, and `workspace.sync.pull` as nested
  children. Tagged with `workspace.shell.exit_code`,
  `workspace.shell.pushed`, `workspace.shell.pulled`, and
  `workspace.shell.skipped`.
- `workspace.fs.<op>` — one per filesystem call routed through the
  stub (`readFile`, `writeFile`, `stat`, `readdir`, `find`, `ls`,
  `grep`, `mkdir`, `rm`). Tagged with `workspace.fs.path` and, where
  meaningful, `workspace.fs.entries` or `workspace.fs.matches`.

Attribute values are restricted to `boolean | number | string` so the
same observer shape works against the Cloudflare runtime's built-in
`ctx.tracing.enterSpan(...)` API, OpenTelemetry, or a recording test
observer. Adapter packages for the Cloudflare runtime and for
OpenTelemetry are forthcoming.

The default is a no-op observer with no allocation or async overhead
beyond what the callback itself does, so the package has no
observability cost when callers do not opt in.

## Stub disposal

capnweb does not garbage-collect remote stubs. On the long-lived
sessions this package depends on (Worker ↔ DO over Workers RPC,
DO ↔ wsd over capnweb), undisposed stubs accumulate on the peer
side until the session ends.

The minimum a caller needs to know:

- `using` the value returned from `env.WSD.get(id).getWorkspace()`.
- `using` the handle returned from `ws.shell.exec(...)`.
- Don't worry about `ws.fs` / `ws.shell` — those are property
  accessors that ride with the parent.
- Pure-value returns (`readFile` as a string, `stat`, `readdir`,
  etc.) carry no stubs; nothing to dispose.

Short-lived single-shot Workers (one `getWorkspace()`, a few calls,
return a response) tear the session down with the request, so the
discipline matters most on long-lived isolates that keep grabbing
fresh `WorkspaceStub`s or on busy `exec` workloads inside a single
request.

The full contract — including the boundary between the driver code
and direct streaming callers, and how it interacts with hibernation
and reconnect — is in [`docs/11_lifecycle.md`](../../docs/11_lifecycle.md#stub-disposal-contract).

Leak discovery: set `CAPNWEB_TRACK_STUBS=1` and read the snapshot
via `stubSnapshot()` from `@cloudflare/workspace-rpc/debug`, or
hit `GET /__wsd/stubs` on a wsd instance. The soak scripts at
[`script/wsd-stub-soak.mjs`](../../script/wsd-stub-soak.mjs) and
[`tests/stub-soak.test.ts`](./tests/stub-soak.test.ts) exercise both
boundaries.
