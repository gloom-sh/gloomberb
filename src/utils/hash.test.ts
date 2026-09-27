import { expect, test } from "bun:test";
import { fnv1aHashString, fnv1aHex } from "./hash";

// These hashes are persisted as cache keys, remote revisions and layout
// fingerprints, so their output must not drift. The vectors are the published
// 32-bit FNV-1a reference values.
test("matches the reference FNV-1a vectors", () => {
  expect(fnv1aHex("")).toBe("811c9dc5");
  expect(fnv1aHex("a")).toBe("e40c292c");
  expect(fnv1aHex("foobar")).toBe("bf9cf968");
  expect(fnv1aHashString("foobar")).toBe("fnv1a:bf9cf968");
});
