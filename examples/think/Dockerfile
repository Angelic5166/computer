# Container image for the think example. Identical wiring to
# examples/wsd-container — we pull a wsd binary from the
# cloudflare/workspace-wsd-linux-x64 image staged by the predev /
# predeploy hooks, drop it into a slim debian, and run it as PID 1.
#
# wsd mounts a FUSE filesystem at MOUNT_POINT so exec'd commands
# (git, npm, vitest, …) see the same files the Workspace RPC
# surface reads and writes.

FROM --platform=linux/amd64 cloudflare/workspace-wsd-linux-x64:0.1.0-alpha.1 AS wsd

FROM --platform=linux/amd64 debian:stable-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      fuse3 libfuse2t64 ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

COPY --from=wsd /usr/local/bin/wsd /usr/local/bin/wsd

ENV PORT=8080
ENV MOUNT_POINT=/workspace
# FUSE_MOUNT=auto probes /dev/fuse at startup and uses the real
# kernel FUSE backend when available (Cloudflare Containers in
# production) or transparently falls back to the userspace shim
# (wrangler dev, sandboxes without CAP_SYS_ADMIN). Same image works
# in both environments.
ENV FUSE_MOUNT=auto
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/wsd"]
