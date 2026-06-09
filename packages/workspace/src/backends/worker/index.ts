// Public surface of @cloudflare/workspace/backends/worker.
//
// The worker backend pairs a Workspace with a just-bash shell
// running in a Dynamic Worker minted through env.LOADER. Every
// filesystem operation from inside the shell forwards back to
// the host Durable Object through a WorkspaceServiceProxy
// loopback; the DO's SQLite is the single authoritative store.
//
// Imported via:
//
//   import { WorkerBackend } from "@cloudflare/workspace/backends/worker";
//
// The package ships SHELL_BUNDLE — the pre-built ShellWorker
// module string — and SHELL_RUNTIME_MODULES — the module shims
// just-bash's static native imports need to load under workerd.
// The backend uses both internally; consumers don't need to
// touch them unless they construct the Loader callback by hand
// (in which case they pass a `fetcher` factory to WorkerBackend
// instead of `loader` + `workspace` + `ctx`).

export { type WorkspaceFs, WorkspaceFsAdapter } from "./adapter.js";
export { type ExecInput, ShellWorker, type ShellWorkerOptions } from "./entrypoint.js";
export { SHELL_BUNDLE } from "./generated-bundle.js";
export { defineGitCommand, type GitCommandHost } from "./git-command.js";
export { SHELL_RUNTIME_MODULES } from "./runtime-modules.js";
export { WorkerBackend, type WorkerBackendOptions, type WorkerShellFetcher } from "./worker.js";
