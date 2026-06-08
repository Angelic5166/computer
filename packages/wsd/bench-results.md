# FUSE mount option benchmarks

Numbers from running `script/run-fs-bench.sh` against the linux-x64
`wsd` binary in a privileged docker container, with the bench's pure
large-file scenarios. Measurements were taken on Apple Silicon under
qemu/x86 emulation, which inflates the absolute numbers but the
relative comparisons hold. Re-run the harness on a native Linux host
before drawing tuning conclusions for production.

The harness creates a fresh subdirectory per repetition, so every
scenario reads its target file exactly once per timed sample. That
shape exercises the FUSE per-op path and the dirty-buffer spill, but
does not exercise cross-open kernel page-cache reuse.

## Setup

```bash
# Build the linux-x64 wsd binary.
npm run build:bin --workspace @cloudflare/workspace-wsd

# Boot wsd in a docker container, run the bench inside it, drop the
# JSON output on the host.
docker run --rm --platform linux/amd64 --privileged \
  --device /dev/fuse --cap-add SYS_ADMIN --cap-add MKNOD \
  -v $PWD/artifacts/wsd/wsd-linux-x64:/usr/local/bin/wsd:ro \
  -v $PWD/script/fs-bench.sh:/usr/local/bin/fs-bench:ro \
  -v $PWD/script/run-fs-bench.sh:/run-bench.sh:ro \
  -v $PWD/bench-out:/out \
  -e REPS=3 -e WARMUP=1 \
  -e OUTPUT_JSON=/out/results.json \
  -e SCENARIOS='pure read,pure copy,overwrite,write 64' \
  -e WSD_FUSE_AUTO_CACHE=1 \
  debian:stable-slim bash /run-bench.sh
```

## Results

Mean over three reps with one warmup. All times in milliseconds.

| Scenario          | native baseline | default | auto_cache | kernel_cache |
|-------------------|----------------:|--------:|-----------:|-------------:|
| write 64 MiB      |            32.3 |   214.9 |      213.7 |            — |
| pure read 64 MiB  |            26.0 |    44.1 |       45.3 |         28.4 |
| pure copy 64 MiB  |            32.3 |   253.2 |      252.3 |        245.4 |
| overwrite 64 MiB  |            28.9 |   191.2 |      185.9 |        185.4 |

## What the numbers say

`kernel_cache` brings pure-read latency from 44 ms down to 28 ms, very
close to the native 26 ms baseline. The win lines up with the
expectation: with the cache option enabled the kernel reuses page-
cache contents across reads of the same offsets within one open
instead of issuing a fresh FUSE round-trip per `read` call.

`auto_cache` showed no change in this run. The benchmark reads each
target file exactly once per rep in a fresh directory, so there is
nothing in the page cache for `auto_cache` to invalidate or reuse on
open. A read-heavy workload that reopens the same file repeatedly is
the right shape to measure `auto_cache`. Treat the unchanged numbers
here as the absence of regression, not as evidence that `auto_cache`
is a no-op in production.

Copy, overwrite, and write are all dominated by the write side of the
operation. The driver buffers writes in memory and spills the whole
file through `vfs.writeFileSync` on `flush`, which goes through
SQLite-backed chunking in `@cloudflare/dofs`. None of the cache
options touch that path, so they don't move the numbers. Chunk-aware
or streaming spill is the next lever for these scenarios, as called
out in the handoff under "larger future optimization".

## Notes on safety

`kernel_cache` is unsafe as a default. It tells the kernel that the
page cache is never invalidated, so a sync push that lands new bytes
in the VFS does not propagate to a container that already has the
file open. Reserve it for fast / single-writer profiles where the
container is the only writer.

`auto_cache` is the production-safe candidate. It invalidates the
page cache on open when mtime or size changed. Two driver tests in
`packages/wsd/src/fuse/driver.test.ts` pin the contract that the FUSE
driver's `getattr` surfaces fresh mtime and size after an external
VFS write and after a buffered local write. Don't enable
`WSD_FUSE_AUTO_CACHE` in deployments until a sync-side correctness
test confirms that the apply path bumps mtime on every change,
including chunk-only changes that leave the file's size constant.
