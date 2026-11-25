import { dlopen } from "bun:ffi";
import { expect, test } from "bun:test";
import { toCString } from "../.hutch/devkit/api/sdks/main/proc/ffiCString";

/** The C library's strcmp: a native call that reads both strings when it runs. */
function libcStrcmp() {
  const library = process.platform === "win32" ? "msvcrt.dll" : process.platform === "darwin" ? "libc.dylib" : "libc.so.6";
  return dlopen(library, { strcmp: { args: ["cstring", "cstring"], returns: "i32" } }).symbols.strcmp;
}

// Electrobun's createWebview takes the webview's key as a C string, followed by
// more strings. Handed over as a bare pointer, the key's buffer could be
// collected while those were made, and the native side read freed memory: the
// app closed on launch with "Failed to parse webview secret key byte".
test("a C string from the patched SDK stays intact while later arguments allocate and collect", () => {
  const strcmp = libcStrcmp();
  const key = Array.from({ length: 32 }, (_, index) => (index * 37 + 11) % 256).join(",");
  const expected = Buffer.from(`${key}\0`, "utf8");
  const laterArgument = () => {
    for (let index = 0; index < 200; index++) toCString(`${key},${index}`);
    Bun.gc(true);
    return expected;
  };
  for (let run = 0; run < 5; run++) {
    expect(strcmp(toCString(key), laterArgument())).toBe(0);
  }
});
