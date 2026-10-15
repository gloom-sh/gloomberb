import { describe, expect, test } from "bun:test";

import { compareSemver, formatVersion } from "./semver";

describe("compareSemver", () => {
  test("orders by major, minor, patch and ignores a leading v", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "1.10.0")).toBeLessThan(0);
    expect(compareSemver("2.0", "1.99.99")).toBeGreaterThan(0);
  });

  test("a release outranks its own prerelease", () => {
    expect(compareSemver("1.0.0-beta.2", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0-beta.1", "1.0.0-beta.2")).toBeLessThan(0);
  });

  // Nightly builds are `<next patch>-nightly.<date>.<run>.g<sha7>`; the update
  // channels depend on these orderings.
  test("orders nightly builds between the releases around them", () => {
    const nightly = "0.16.5-nightly.20261015.42.gabc1234";
    expect(compareSemver(nightly, "0.16.5")).toBeLessThan(0);
    expect(compareSemver(nightly, "0.16.4")).toBeGreaterThan(0);
    expect(compareSemver("0.16.5-nightly.20261016.43.g0000000", nightly)).toBeGreaterThan(0);
  });

  test("compares prerelease numbers by value, never by the characters of a sha", () => {
    // Same day: the run number decides, whatever the shas look like.
    expect(compareSemver("0.16.5-nightly.20261015.9.gfff", "0.16.5-nightly.20261015.10.g000")).toBeLessThan(0);
    // A later day wins over a higher run number.
    expect(compareSemver("0.16.5-nightly.20261016.1.g000", "0.16.5-nightly.20261015.99.gfff")).toBeGreaterThan(0);
    // Digits sort below words, and a shorter tag below a longer one that starts the same.
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBeLessThan(0);
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0-rc.1")).toBe(0);
  });

  test("returns null rather than guessing when either side is not a version", () => {
    // Plugins pin to tags like "main" or a commit; comparing those as versions
    // would report an update forever or never.
    expect(compareSemver("main", "1.0.0")).toBeNull();
    expect(compareSemver(undefined, "1.0.0")).toBeNull();
  });
});

describe("formatVersion", () => {
  test("normalizes spelling and passes non-versions through", () => {
    expect(formatVersion("v1.2")).toBe("1.2.0");
    expect(formatVersion("main")).toBe("main");
    expect(formatVersion("")).toBeNull();
  });
});
