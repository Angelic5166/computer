# `@cloudflare/think` chat example

> [!IMPORTANT]
> **PREVIEW ONLY** This package is provided as a preview for feedback only.
> APIs are unstable and the design is subject to change.
>
> Suitable for experiments, exploration and prototypes. It is NOT suitable
> for production use at this time.

A minimal example that puts [`@cloudflare/think`][think] behind a
terminal chat interface. The agent is a Durable Object with a
[`@cloudflare/workspace`][workspace] VFS for a working directory and
the shared file and shell tools from
[`@cloudflare/workspace/tools`][tools]. There is no task workflow: you
open a terminal, type, and talk to the agent, and it uses its tools to
read, write, and run commands in its workspace when a reply calls for
it.

The terminal client is the [AI SDK v7][aisdk7] TUI (`@ai-sdk/tui`). It
talks to the agent over the same WebSocket chat protocol a browser
would use, so no bespoke HTTP route or transport is involved.

[think]: https://www.npmjs.com/package/@cloudflare/think
[workspace]: ../../packages/workspace
[tools]: ../../packages/workspace/src/tools
[aisdk7]: https://vercel.com/blog/ai-sdk-7

## Shape

```
client (npm run chat)                 worker
   │                                     │
   │  AgentClient WebSocket              │
   ├────────────────────────────────────▶  Assistant DO (Think)
   │  /agents/assistant/<name>           │    ├── Workers AI model
   │                                     │    └── @cloudflare/workspace VFS
   │  ◀───────── streamed reply ─────────┤          └── worker backend (env.LOADER)
```

`src/index.ts` hands every request to `routeAgentRequest`, which
resolves the `/agents/assistant/<name>` WebSocket route to the
`Assistant` Durable Object. Anything else gets a short plain-text
usage note. There is no other route.

`src/agent.ts` is the whole agent. `Assistant` extends `Think`, which
supplies the chat protocol, message persistence, resumable streams,
and the agentic tool loop. The example adds three things: a Workers AI
model, a Workspace, and the workspace tools.

## Tools

The tools come from `createAITools()` in
[`@cloudflare/workspace/tools`][tools]. This example enables the file
tools and opts into `exec` by passing a shell backend description; it
does not configure the assets publisher, so `publish` is not offered.

| Tool    | What it does                                              |
| ------- | --------------------------------------------------------- |
| `read`  | Read a file from the workspace.                           |
| `ls`    | List a workspace directory.                               |
| `write` | Create or overwrite a workspace file.                     |
| `edit`  | Apply targeted replacements to a workspace file.          |
| `exec`  | Run a shell command (just-bash) in the worker backend.    |

`exec` runs on a single `"shell"` backend: just-bash in a Dynamic
Worker loaded through `env.LOADER`. It cold-starts fast, needs no
container, and covers the usual text tooling (`grep`, `sed`, `awk`,
`jq`, `sort`, `find`, ...). Its just-bash shell also registers a
built-in `git` command that forwards to the host workspace's typed git
API, so `git clone`, `git status`, `git diff`, and `git log` work from
inside `exec` even though the shell isolate has no public network of
its own. Only `https://` URLs are supported. The shell cannot run
`npm`, `node`, `python`, or any binary outside just-bash's built-in
command set; this example wires no container backend for those. See
[`docs/05_shell_interface.md`](../../docs/05_shell_interface.md) and
[`docs/13_git_interface.md`](../../docs/13_git_interface.md).

The system prompt tells the model to prefer `read`/`ls` over
`exec cat`/`exec ls` and `write`/`edit` over shell text munging, and
to reach for `exec` only when the file tools can't do the job.

## Running it locally

No Docker required. From the repo root:

```sh
npm install

# Two terminals — worker on one, client on the other.
cd examples/think
npm run dev          # terminal 1: wrangler dev on http://127.0.0.1:8787
npm run chat         # terminal 2: the AI SDK v7 terminal UI
```

`npm run chat` opens the terminal UI and connects to the running
worker. Type a message and the agent replies, calling its tools as
needed. Each `--name` is a distinct agent instance with its own
workspace and chat history, so you can keep separate conversations.

Useful flags (also available as environment variables):

- `--worker URL` — worker base URL (`THINK_WORKER`). Default
  `http://127.0.0.1:8787`. An `https://` URL upgrades to a secure
  WebSocket automatically.
- `--name NAME` — agent instance name (`THINK_AGENT_NAME`). Default
  `default`.
- `--title TITLE` — title shown in the terminal UI. Defaults to
  `think · <name>`.

The example also installs a `think-chat` bin pointing at the same
client, so `npx think-chat --worker <url>` works against a deployed
worker.

## Configuration

The worker is configured in [`wrangler.jsonc`](./wrangler.jsonc):

- `AI` — Workers AI binding. The agent uses
  `@cf/moonshotai/kimi-k2.6`; change `MODEL_ID` in `src/agent.ts` to
  pick another model.
- `LOADER` — Worker Loader binding. The Assistant's Workspace uses it
  to mint the Dynamic Worker that hosts the `exec` shell backend.
- `Assistant` — the SQLite-backed Durable Object. Each instance owns
  one Workspace and one Think agent.

No secrets, no external services, no GitHub or R2 configuration.

## Deploying

`wrangler deploy` works against any account with Workers AI and Worker
Loaders enabled. Point the client at the deployed worker with
`npm run chat -- --worker https://<your-worker-url>` (or set
`THINK_WORKER`); the `https://` URL upgrades the connection to a
secure WebSocket.
