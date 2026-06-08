import { describe, expect, test } from "vitest";

import { buildFuseOptionString, type FuseOptionEnv } from "./options.js";

const empty: FuseOptionEnv = {};

describe("buildFuseOptionString", () => {
  test("emits the default sizing options when no env vars are set", () => {
    expect(buildFuseOptionString(empty)).toBe("big_writes,max_write=131072,max_read=131072");
  });

  test("overrides max_read and max_write from the environment", () => {
    expect(
      buildFuseOptionString({
        WSD_FUSE_MAX_READ: "1048576",
        WSD_FUSE_MAX_WRITE: "1048576",
      }),
    ).toBe("big_writes,max_write=1048576,max_read=1048576");
  });

  test("ignores non-numeric size overrides and falls back to the default", () => {
    expect(buildFuseOptionString({ WSD_FUSE_MAX_READ: "wat" })).toBe(
      "big_writes,max_write=131072,max_read=131072",
    );
  });

  test("rejects non-positive sizes", () => {
    expect(buildFuseOptionString({ WSD_FUSE_MAX_READ: "0" })).toBe(
      "big_writes,max_write=131072,max_read=131072",
    );
    expect(buildFuseOptionString({ WSD_FUSE_MAX_WRITE: "-1" })).toBe(
      "big_writes,max_write=131072,max_read=131072",
    );
  });

  test("adds auto_cache when WSD_FUSE_AUTO_CACHE is truthy", () => {
    expect(buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "1" })).toContain("auto_cache");
    expect(buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "true" })).toContain("auto_cache");
    expect(buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "0" })).not.toContain("auto_cache");
    expect(buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "" })).not.toContain("auto_cache");
  });

  test("adds kernel_cache when WSD_FUSE_KERNEL_CACHE is truthy", () => {
    expect(buildFuseOptionString({ WSD_FUSE_KERNEL_CACHE: "1" })).toContain("kernel_cache");
  });

  test("treats auto_cache and kernel_cache as mutually exclusive, with auto_cache winning", () => {
    // libfuse 2.9 documents kernel_cache and auto_cache as incompatible:
    // auto_cache implies the page cache is valid until invalidated, and
    // kernel_cache implies the page cache is never invalidated. Asking for
    // both is a configuration mistake. We prefer the safer (auto_cache)
    // option and warn-by-fact: the option string will say auto_cache only.
    const out = buildFuseOptionString({
      WSD_FUSE_AUTO_CACHE: "1",
      WSD_FUSE_KERNEL_CACHE: "1",
    });
    expect(out).toContain("auto_cache");
    expect(out).not.toContain("kernel_cache");
  });

  test("emits attr_timeout / entry_timeout / negative_timeout / ac_attr_timeout when set", () => {
    const out = buildFuseOptionString({
      WSD_FUSE_ATTR_TIMEOUT: "1",
      WSD_FUSE_ENTRY_TIMEOUT: "2",
      WSD_FUSE_NEGATIVE_TIMEOUT: "0",
      WSD_FUSE_AC_ATTR_TIMEOUT: "3",
    });
    expect(out).toContain("attr_timeout=1");
    expect(out).toContain("entry_timeout=2");
    expect(out).toContain("negative_timeout=0");
    expect(out).toContain("ac_attr_timeout=3");
  });

  test("accepts fractional timeouts because libfuse documents them that way", () => {
    const out = buildFuseOptionString({ WSD_FUSE_ATTR_TIMEOUT: "0.5" });
    expect(out).toContain("attr_timeout=0.5");
  });

  test("rejects non-numeric timeouts", () => {
    const out = buildFuseOptionString({ WSD_FUSE_ATTR_TIMEOUT: "nope" });
    expect(out).not.toContain("attr_timeout");
  });

  test("rejects negative timeouts", () => {
    const out = buildFuseOptionString({ WSD_FUSE_ATTR_TIMEOUT: "-1" });
    expect(out).not.toContain("attr_timeout");
  });

  test("appends WSD_FUSE_EXTRA_OPTS verbatim for last-resort experimentation", () => {
    const out = buildFuseOptionString({
      WSD_FUSE_EXTRA_OPTS: "use_ino,fsname=wsd",
    });
    expect(out).toContain("use_ino");
    expect(out).toContain("fsname=wsd");
  });

  test("does not emit writeback_cache even with EXTRA_OPTS asking for it", () => {
    // libfuse 2.9 (the version fuse-native links against) does not
    // recognise writeback_cache as a mount option; experiments showed
    // mount failing with "fuse: unknown option `writeback_cache'".
    // Strip it defensively so a typo in EXTRA_OPTS doesn't take the
    // daemon down.
    const out = buildFuseOptionString({
      WSD_FUSE_EXTRA_OPTS: "writeback_cache,use_ino",
    });
    expect(out).not.toContain("writeback_cache");
    expect(out).toContain("use_ino");
  });

  test("returns the same options regardless of env var order", () => {
    const a = buildFuseOptionString({ WSD_FUSE_AUTO_CACHE: "1", WSD_FUSE_ATTR_TIMEOUT: "1" });
    const b = buildFuseOptionString({ WSD_FUSE_ATTR_TIMEOUT: "1", WSD_FUSE_AUTO_CACHE: "1" });
    expect(a).toBe(b);
  });
});
