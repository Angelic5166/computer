/**
 * Assistant — a minimal `@cloudflare/think` chat agent backed by a
 * `@cloudflare/workspace` VFS.
 *
 * Think gives the Durable Object a streaming chat protocol, message
 * persistence, resumable streams, and the agentic tool loop. This
 * example keeps the surface as small as possible: one agent, one
 * Workspace, the shared `@cloudflare/workspace/tools`, and nothing
 * task-specific. You talk to it from a terminal (see `cli/chat.mjs`)
 * and it can read, write, and edit files in its workspace and run
 * shell commands through the worker backend.
 *
 * Wiring:
 *   - `Think` (via the Durable Object base) hands us the message
 *     store, agentic loop, and chat protocol.
 *   - We own a `@cloudflare/workspace.Workspace` whose single backend
 *     is a `WorkerBackend` — just-bash in a Dynamic Worker loaded
 *     through `env.LOADER`. No container, no Docker: instant boot and
 *     broad textual tooling, including a built-in `git` command that
 *     forwards to the host workspace.
 *   - `useThink: true` adds the string-based compatibility surface
 *     Think expects; the cast promotes it from optional to present.
 *     `workspaceBash` is off because `@cloudflare/workspace/tools`
 *     provides the `exec` tool.
 */

import { Think } from "@cloudflare/think";
import {
  type DurableObjectStorageLike,
  type ThinkWorkspaceCompatibility,
  Workspace,
  WorkspaceServiceProxy,
  type WorkspaceStub,
} from "@cloudflare/workspace";
import { WorkerBackend } from "@cloudflare/workspace/backends/worker";
import { createAITools } from "@cloudflare/workspace/tools";
import type { ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";

// Re-export so the runtime can wrap WorkspaceServiceProxy into a
// loopback Fetcher binding. The WorkerBackend reaches the wrapped
// class through `ctx.exports.WorkspaceServiceProxy(...)` so the
// in-isolate shell can call back into the host workspace.
export { WorkspaceServiceProxy };

const MODEL_ID = "@cf/moonshotai/kimi-k2.6";

export class Assistant extends Think<Env> {
  /** We have a dedicated `exec` tool; skip Think's built-in bash. */
  override workspaceBash = false;

  /** Plenty of budget for a chat turn that reads a few files first. */
  override maxSteps = 20;

  /**
   * Think's workspace, owned outright. Its single backend is a
   * Dynamic Worker running just-bash. `useThink: true` adds the
   * string-based filesystem methods Think's baseline expects; the
   * cast promotes them from optional to present.
   */
  override workspace = new Workspace({
    storage: this.ctx.storage as unknown as DurableObjectStorageLike,
    backends: [
      new WorkerBackend({
        id: "shell",
        loader: this.env.LOADER,
        workspace: { binding: "Assistant", id: this.ctx.id.toString() },
        ctx: this.ctx,
      }),
    ],
    useThink: true,
  }) as Workspace & ThinkWorkspaceCompatibility;

  /**
   * Hand out a typed RPC stub to the workspace. The worker backend's
   * WorkspaceServiceProxy dispatches to this so the in-isolate shell
   * can reach back into the host workspace.
   */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
  }

  override getModel() {
    return createWorkersAI({ binding: this.env.AI })(MODEL_ID);
  }

  override getSystemPrompt(): string {
    return [
      "You are a helpful assistant with a Cloudflare Workspace as your",
      "working directory, rooted at /workspace.",
      "",
      "Tools, in preference order:",
      "  - read, ls:    inspect the working tree. Prefer these over",
      "                 `exec cat` / `exec ls`.",
      "  - write, edit: create and modify files. Prefer these over",
      "                 `exec sed` / shell heredocs.",
      "  - exec:        run shell commands (just-bash), including `git`",
      "                 (clone / status / diff / log). Only https:// git",
      "                 URLs are supported. Use this for anything the",
      "                 file tools can't do.",
      "",
      "Keep replies concise. Use the tools instead of guessing about",
      "files you can read.",
    ].join("\n");
  }

  override getTools(): ToolSet {
    return createAITools({
      workspace: this.workspace,
      shell: {
        defaultBackend: "shell",
        backends: {
          shell: {
            description:
              "just-bash in a Dynamic Worker. Cold-start fast, no " +
              "container. Good for cat / grep / sed / awk / jq / head / " +
              "tail / sort / find and for `git` (clone / status / diff / " +
              "log) — the shell registers a built-in `git` command that " +
              "forwards to the host workspace, so `git clone` works even " +
              "though the isolate has no public network of its own. Only " +
              "https:// URLs are supported. Cannot run npm, node, python, " +
              "or any binary outside just-bash's built-in command set.",
          },
        },
      },
    });
  }
}
