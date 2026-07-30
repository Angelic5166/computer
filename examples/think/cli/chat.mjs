#!/usr/bin/env node

/**
 * chat [--worker URL] [--name NAME] [--title TITLE]
 *
 * Connects a terminal UI to the Assistant Think agent and lets you
 * chat with it. This is the "simplest mechanism" the README talks
 * about: the AI SDK v7 terminal UI (`@ai-sdk/tui`) speaks to the agent
 * through the same WebSocket chat transport a browser would use.
 *
 *   AgentClient  — a WebSocket connection to /agents/assistant/<name>
 *                  (from `agents/client`, runs in Node on the built-in
 *                  global WebSocket).
 *   WebSocketChatTransport — adapts that connection to the AI SDK
 *                  `ChatTransport` interface `runAgentTUI` expects.
 *   runAgentTUI    — renders the interactive terminal chat.
 *
 * The worker must be running first (`npm run dev`, default
 * http://127.0.0.1:8787). Point at a deployed worker with --worker
 * (or the THINK_WORKER env var).
 */

import { argv, env, exit, stderr } from "node:process";
import { runAgentTUI } from "@ai-sdk/tui";
import { WebSocketChatTransport } from "agents/chat/react";
import { AgentClient } from "agents/client";

const { workerUrl, name, title } = parseArgs(argv.slice(2));

let base;
try {
  base = new URL(workerUrl);
} catch {
  stderr.write(`invalid --worker URL: ${workerUrl}\n`);
  exit(2);
}

// PartySocket picks ws:// vs wss:// from the host's protocol. Pass the
// scheme through the `host` field so a deployed https worker upgrades
// to a secure socket while localhost stays plain ws.
const secure = base.protocol === "https:" || base.protocol === "wss:";
const host = `${secure ? "https" : "http"}://${base.host}`;

const client = new AgentClient({ agent: "Assistant", name, host });
const transport = new WebSocketChatTransport({ agent: client });

stderr.write(`connecting to ${host} (agent "assistant", instance "${name}")\n`);

await runAgentTUI({
  transport,
  title: title ?? `think · ${name}`,
});

function parseArgs(args) {
  let workerUrl = env.THINK_WORKER ?? "http://127.0.0.1:8787";
  let name = env.THINK_AGENT_NAME ?? "default";
  let title;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--worker") {
      workerUrl = args[++i] ?? workerUrl;
    } else if (a === "--name") {
      name = args[++i] ?? name;
    } else if (a === "--title") {
      title = args[++i] ?? title;
    } else if (a === "-h" || a === "--help") {
      stderr.write("usage: chat [--worker URL] [--name NAME] [--title TITLE]\n");
      exit(0);
    }
  }
  return { workerUrl: workerUrl.replace(/\/+$/, ""), name, title };
}
