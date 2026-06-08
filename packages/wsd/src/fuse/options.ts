// FUSE mount option assembly.
//
// fuse-native (libfuse 2.9) doesn't expose most of the interesting
// mount options through its constructor, so the driver monkey-patches
// _fuseOptions() to append a comma-separated extra option string.
// Centralizing the assembly here gives us a pure function we can unit
// test, and gives operators a documented set of env vars to flip when
// experimenting.
//
// The defaults match the historical behavior: big_writes plus 128 KiB
// max_read and max_write. Every other option is opt-in.
//
// Disallowed options (writeback_cache) are stripped defensively because
// libfuse 2.9 fails the whole mount with "unknown option" when it sees
// them. A typo in WSD_FUSE_EXTRA_OPTS shouldn't take the daemon down.

const DEFAULT_MAX_READ = 131072;
const DEFAULT_MAX_WRITE = 131072;

// libfuse 2.9 does not understand these. Reject them at assembly time
// so a typo in EXTRA_OPTS doesn't fail the mount on startup.
const DISALLOWED_OPTS = new Set(["writeback_cache"]);

export interface FuseOptionEnv {
  WSD_FUSE_MAX_READ?: string;
  WSD_FUSE_MAX_WRITE?: string;
  WSD_FUSE_AUTO_CACHE?: string;
  WSD_FUSE_KERNEL_CACHE?: string;
  WSD_FUSE_ATTR_TIMEOUT?: string;
  WSD_FUSE_ENTRY_TIMEOUT?: string;
  WSD_FUSE_NEGATIVE_TIMEOUT?: string;
  WSD_FUSE_AC_ATTR_TIMEOUT?: string;
  WSD_FUSE_EXTRA_OPTS?: string;
}

/**
 * Build the comma-separated option string that the driver appends to
 * fuse-native's _fuseOptions() output. Pure function over an env-like
 * object, so tests can drive it directly.
 */
export function buildFuseOptionString(env: FuseOptionEnv): string {
  const opts: string[] = ["big_writes"];

  const maxWrite = parsePositiveInt(env.WSD_FUSE_MAX_WRITE) ?? DEFAULT_MAX_WRITE;
  const maxRead = parsePositiveInt(env.WSD_FUSE_MAX_READ) ?? DEFAULT_MAX_READ;
  opts.push(`max_write=${maxWrite}`);
  opts.push(`max_read=${maxRead}`);

  // libfuse 2.9 treats auto_cache and kernel_cache as alternative
  // strategies for the page cache, not stacking options. auto_cache wins
  // when both are set because it's the safer choice: it invalidates the
  // cache when mtime or size change, where kernel_cache never
  // invalidates. The driver could warn here, but the option string
  // itself is the durable artifact operators inspect when chasing
  // misconfiguration, so just emit the safer one and move on.
  const autoCache = parseBool(env.WSD_FUSE_AUTO_CACHE);
  const kernelCache = parseBool(env.WSD_FUSE_KERNEL_CACHE);
  if (autoCache) {
    opts.push("auto_cache");
  } else if (kernelCache) {
    opts.push("kernel_cache");
  }

  pushTimeout(opts, "attr_timeout", env.WSD_FUSE_ATTR_TIMEOUT);
  pushTimeout(opts, "entry_timeout", env.WSD_FUSE_ENTRY_TIMEOUT);
  pushTimeout(opts, "negative_timeout", env.WSD_FUSE_NEGATIVE_TIMEOUT);
  pushTimeout(opts, "ac_attr_timeout", env.WSD_FUSE_AC_ATTR_TIMEOUT);

  const extra = env.WSD_FUSE_EXTRA_OPTS;
  if (extra !== undefined && extra !== "") {
    for (const part of extra.split(",")) {
      const trimmed = part.trim();
      if (trimmed === "") continue;
      const head = trimmed.split("=")[0];
      if (DISALLOWED_OPTS.has(head)) continue;
      opts.push(trimmed);
    }
  }

  return opts.join(",");
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function parseNonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

function parseBool(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function pushTimeout(opts: string[], name: string, raw: string | undefined): void {
  const n = parseNonNegativeNumber(raw);
  if (n === undefined) return;
  // libfuse accepts integers and fractional seconds. Preserve the
  // operator's literal where it parses cleanly so "0.5" stays as
  // "0.5" rather than dropping precision through Number formatting.
  const formatted = raw !== undefined && Number(raw) === n ? raw : String(n);
  opts.push(`${name}=${formatted}`);
}
