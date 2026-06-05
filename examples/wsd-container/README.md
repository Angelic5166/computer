# wsd-container example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.

A Cloudflare Worker + Durable Object that boots a Container running
the `wsd` daemon and exposes a minimal `write` / `read` / `exec`
HTTP surface, modelled on the
[cloudflare/sandbox-sdk](https://github.com/cloudflare/sandbox-sdk)
bridge.

## Architecture

```
client ─► Worker /c/<name>/{file,exec}
             │  (DO RPC calls)
             ▼
       DO (ContainerExample) ──► Container ──► wsd (:8080)
             ▲                                  │
             │      ws://workspace.internal/ws  │
             └────────── capnweb session ◄──────┘
```

1. The DO constructs a `CloudflareContainerBackend` from
   `@cloudflare/workspace` and hands it to a `Workspace` instance.
   That backend owns the entire wsd lifecycle: container start,
   outbound egress interception, port-readiness polling, POST
   `/connect` to wsd, `/ws` upgrade routing, and capnweb session
   attach.
2. wsd reaches the Worker through the container's **outbound
   interception** (`ctx.container.interceptOutboundHttp("workspace.internal",
   …)`, set up by the backend). The DO passes
   `ctx.exports.WorkspaceProxy({ props: { binding, id } })` as the
   egress fetcher; that `WorkerEntrypoint` (re-exported from
   `@cloudflare/workspace`) routes `/ws` upgrades back to the owning DO.
3. When `Workspace.ready()` is called for the first time, the
   backend posts `/connect` into wsd with
   `{ url: "http://workspace.internal" }`. wsd polls
   `workspace.internal/health`, then dials
   `ws://workspace.internal/ws`.
4. `WorkspaceProxy.fetch` forwards the upgrade to the DO's `fetch()`
   via the DO binding looked up from its props. The DO's `fetch()`
   delegates to `backend.handleFetch(req)`, which performs the
   WebSocket upgrade, resolves the in-flight `connect()`, and
   attaches a capnweb client session to the server-side socket.
5. The DO exposes a single `getWorkspace()` RPC method that
   returns a `WorkspaceStub` (an `RpcTarget` wrapping the inner
   `Workspace`). The Worker's fetch handler calls
   `await stub.getWorkspace()` once per request and then drives
   `ws.fs.writeFile(...)` / `ws.fs.readFile(...)` /
   `ws.shell.exec(...)` directly. Promise pipelining keeps the
   nested-property pattern (`ws.fs.writeFile`) at one round trip.

The DO extends the plain `DurableObject` class from
`cloudflare:workers`. The container lifecycle plumbing all lives
in `CloudflareContainerBackend` — the DO is a thin host.

The container mounts wsd's VFS at `MOUNT_POINT` (`/workspace`) so
`exec`'d commands see the same tree the RPC surface reads and
writes. On Cloudflare Containers `/dev/fuse` is exposed and the
real FUSE backend mounts; under `wrangler dev` the same image
transparently falls back to the userspace shim (`FUSE_MOUNT=auto`
in the Dockerfile).

## Paths

The file handler takes the URL path verbatim as an absolute VFS
path and rejects anything outside `/workspace` with `400`. So
`PUT /c/<name>/file/workspace/hello.txt` writes
`/workspace/hello.txt`, and `GET /c/<name>/file/workspace/r2/x`
reads `/workspace/r2/x` — the URL and the on-disk path always
match. `PUT /c/<name>/file/etc/passwd` would be rejected; the
example only exposes the mounted tree.

`exec` is **not** path-restricted. The command runs as PID 1 of
the container with no `cwd` default; it can `cat /etc/os-release`,
touch `/tmp/x`, or anything else the container's userland allows.
Only writes that land under `/workspace` make their way back to
the DO via the FUSE mount.

## R2 mount

The DO mounts the `Bucket` R2 binding at `/workspace/r2` via
`R2Bucket(env.Bucket)`. On the first call into the workspace the
mount indexer pages through the bucket, streams each object into
`vfs_nodes`, and from then on `/workspace/r2/<key>` reads like any
other file. The mount is read-only; writes under `/workspace/r2`
reject with `EROFS`.

Seed the bucket once with the bundled fixture (`./seed/data/hello.txt`,
which contains the bytes `hello world`):

```sh
# Local miniflare bucket — use this with `wrangler dev`.
npm run seed:r2:local --workspace @cloudflare/example-wsd-container

# Real Cloudflare R2 bucket — use this after `wrangler deploy`.
npm run seed:r2 --workspace @cloudflare/example-wsd-container
```

Then:

```sh
curl http://127.0.0.1:8787/c/demo/file/workspace/r2/hello.txt
# => hello world
```

## HTTP surface

```
PUT  /c/<name>/file/workspace/<path>   raw body → writeFile at /workspace/<path>
GET  /c/<name>/file/workspace/<path>   octet-stream of /workspace/<path>
                                       (any path outside /workspace returns 400)
POST /c/<name>/exec                    { command | argv, cwd?, encoding? }
                                       no cwd default; container PID 1 inherits /
                                       → JSON { exitCode, stdout, stderr }
```

`<name>` selects a DO instance; each gets its own container.

## Run it locally

Requires Docker. The Dockerfile pulls
`ghcr.io/cloudflare/workspace-wsd-linux-x64:<version>` from the
public GitHub Container Registry on first build, so no local image
prep is needed.

```sh
npm run dev --workspace @cloudflare/example-wsd-container
```

Smoke test:

```sh
# Trigger the container (first call also boots wsd + the capnweb session).
curl http://127.0.0.1:8787/

# Write a file at /workspace/hello.txt
echo 'hello' | curl -X PUT --data-binary @- \
  http://127.0.0.1:8787/c/demo/file/workspace/hello.txt

# Read it back
curl http://127.0.0.1:8787/c/demo/file/workspace/hello.txt

# Exec sees the same bytes via the absolute path.
curl -X POST http://127.0.0.1:8787/c/demo/exec \
  -H 'content-type: application/json' \
  -d '{"command":"cat /workspace/hello.txt && uname -a","encoding":"utf8"}'
```

## Layout

```
examples/wsd-container/
  Dockerfile                debian + libfuse + wsd binary (ENTRYPOINT)
  wrangler.jsonc            Worker + DO + Container binding
  src/index.ts              Worker handler, DO (ContainerExample)
```

## Known limitations / next steps

- **Exec is run-and-collect, not streamed.** The handler awaits
  `handle.result()` and emits one JSON response. Live streaming needs
  the DO to expose an async-iterable RPC; v1 keeps the surface flat.
- **No auth.** The egress proxy trusts anything the container sends.
  Fine for in-DO traffic (only the owning Worker can address it),
  but the moment we expose `workspace.internal` more broadly we need
  a handshake.
- **One-shot session.** If wsd's WebSocket drops mid-session, the
  cached `BackendHandle` goes stale and the next call throws.
  `Workspace.ready()` will retry on the next call, but in-flight
  operations are lost. Transparent reconnect is Phase 5 R2
  deferred work.
