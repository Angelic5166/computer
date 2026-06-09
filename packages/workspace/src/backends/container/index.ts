// Public surface of @cloudflare/workspace/backends/container.
//
// The container backend pairs a Workspace with a wsd daemon
// running inside a Cloudflare Container. wsd owns its own
// SQLite-backed VFS; the package syncs the two stores across a
// capnweb WebSocket.
//
// Imported via:
//
//   import {
//     CloudflareContainerBackend,
//     withWorkspaceContainer,
//   } from "@cloudflare/workspace/backends/container";

export {
  CloudflareContainerBackend,
  type CloudflareContainerBackendOptions,
} from "./cloudflare-container.js";
export {
  type IWorkspaceContainerAPI,
  WorkspaceContainerAPI,
  type WorkspaceRef,
  withWorkspaceContainer,
} from "./container-host.js";
