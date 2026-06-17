#!/usr/bin/env bash
# Inner entrypoint for the npm-bench Docker container; not called directly. Installs
# dependencies, starts wsd, and runs npm-bench.sh. Not meant to be
# called directly — run-npm-bench.sh is the user-facing entry point.
set -u

apt-get update >/dev/null 2>&1
apt-get install -y --no-install-recommends \
  fuse3 libfuse2t64 attr util-linux coreutils findutils \
  ca-certificates curl nodejs npm >/dev/null 2>&1

mkdir -p /tmp/workspace /tmp/baseline

WSD_FUSE_TRACE="${WSD_FUSE_TRACE:-}" \
  WSD_FUSE_TRACE_FILE="${WSD_FUSE_TRACE_FILE:-}" \
  PORT=45678 MOUNT_POINT=/tmp/workspace /usr/local/bin/wsd >/tmp/wsd.log 2>&1 &
WSD_PID=$!

for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:45678/health >/dev/null 2>&1; then
    echo "wsd ready after ${i}s"
    break
  fi
  sleep 1
done

if ! kill -0 "$WSD_PID" 2>/dev/null; then
  echo "wsd died:"
  cat /tmp/wsd.log
  exit 1
fi

MOUNT=/tmp/workspace BASE=/tmp/baseline /usr/local/bin/npm-bench
status=$?

kill -USR2 "$WSD_PID" 2>/dev/null && sleep 1
kill "$WSD_PID" 2>/dev/null
wait "$WSD_PID" 2>/dev/null
exit $status
