import { describe, expect, test } from "bun:test";
import { libcFromLdd, libcFromProcessMaps, selectOpenTuiLibc } from "./linux-libc";

const mapsLine = (path: string) => `7f3c1a200000-7f3c1a228000 r--p 00000000 103:02 1312 ${path}`;

describe("libcFromProcessMaps", () => {
  test.each([
    ["Debian", [mapsLine("/usr/lib/x86_64-linux-gnu/libc.so.6"), mapsLine("/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2")], "glibc"],
    ["Alpine", [mapsLine("/usr/bin/bun"), mapsLine("/lib/ld-musl-x86_64.so.1")], "musl"],
    ["Alpine arm64", [mapsLine("/lib/ld-musl-aarch64.so.1")], "musl"],
    // A glibc build started through gcompat: the loader it names is a link to
    // musl's, so musl is what is mapped, and the musl library is what loads.
    ["Alpine with gcompat", [mapsLine("/lib/libgcompat.so.0"), mapsLine("/lib/ld-musl-x86_64.so.1")], "musl"],
    ["a static process", [mapsLine("/usr/local/bin/gloomberb"), "7ffd2c1d0000-7ffd2c1f1000 rw-p 00000000 00:00 0 [stack]"], null],
  ])("%s", (_name, lines, expected) => {
    expect(libcFromProcessMaps(lines.join("\n"))).toBe(expected as ReturnType<typeof libcFromProcessMaps>);
  });
});

test("libcFromLdd reads musl's and glibc's ldd", () => {
  expect(libcFromLdd('#!/bin/sh\nexec /lib/ld-musl-x86_64.so.1 --list "$@"\n')).toBe("musl");
  expect(libcFromLdd("#! /bin/bash\n# This file is part of the GNU C Library.\n")).toBe("glibc");
  expect(libcFromLdd("")).toBeNull();
});

describe("selectOpenTuiLibc", () => {
  test("points OpenTUI at musl on musl and leaves glibc alone", () => {
    const musl: Record<string, string | undefined> = {};
    selectOpenTuiLibc(musl, "musl");
    expect(musl.OPENTUI_LIBC).toBe("musl");

    const glibc: Record<string, string | undefined> = {};
    selectOpenTuiLibc(glibc, "glibc");
    expect(glibc.OPENTUI_LIBC).toBeUndefined();
  });

  test("keeps an OPENTUI_LIBC the user set", () => {
    const env: Record<string, string | undefined> = { OPENTUI_LIBC: "glibc" };
    selectOpenTuiLibc(env, "musl");
    expect(env.OPENTUI_LIBC).toBe("glibc");
  });
});
