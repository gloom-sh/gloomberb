import { describe, expect, test } from "bun:test";

import { parseRemoteHead } from "./plugins";

/**
 * `git ls-remote` is the only way to know whether a plugin the registry does
 * not list has moved, and its output is a tab-separated line per ref. Anything
 * else, including the empty answer a repository we cannot reach gives, has to
 * read as "no answer" rather than as a commit.
 */
describe("parseRemoteHead", () => {
  test("takes the sha from the HEAD line", () => {
    expect(parseRemoteHead("abfdcf0aa3e4a0f6f0d2c8ab2cf4b0a0d9e1f234\tHEAD\n"))
      .toBe("abfdcf0aa3e4a0f6f0d2c8ab2cf4b0a0d9e1f234");
  });

  test("ignores surrounding whitespace", () => {
    expect(parseRemoteHead("  2222222bbb3333333ccc4444444ddd5555555eee  \tHEAD  "))
      .toBe("2222222bbb3333333ccc4444444ddd5555555eee");
  });

  test("returns null for an empty or non-sha answer", () => {
    expect(parseRemoteHead("")).toBeNull();
    expect(parseRemoteHead("\n")).toBeNull();
    expect(parseRemoteHead("fatal: could not read Username for 'https://github.com'")).toBeNull();
    // Too short to be a commit, so it is something else that happened to be printed.
    expect(parseRemoteHead("abc123\tHEAD")).toBeNull();
  });
});
