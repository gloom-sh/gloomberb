import { describe, expect, test } from "bun:test";
import { signInEndNote, signInEndOf, signInEndStatus } from "./sign-in-end";

const NOW = Date.parse("2026-10-09T17:00:00.000Z");

describe("sign-in end", () => {
  test("only a sign-in Gloom flags as ending soon has an end to show", () => {
    const expiresAt = "2026-10-10T15:00:00.000Z";
    expect(signInEndOf({ expiresAt, expiresSoon: true })).toBe(Date.parse(expiresAt));
    // A server that predates the flag, a far end, no end, or one that cannot be read.
    expect(signInEndOf({})).toBeNull();
    expect(signInEndOf({ expiresAt })).toBeNull();
    expect(signInEndOf({ expiresAt, expiresSoon: false })).toBeNull();
    expect(signInEndOf({ expiresAt: null, expiresSoon: true })).toBeNull();
    expect(signInEndOf({ expiresAt: "soon", expiresSoon: true })).toBeNull();
  });

  test("an end already past reads as ended, not as still to come", () => {
    const ahead = NOW + 3_600_000;
    const behind = NOW - 3_600_000;
    expect(signInEndStatus(ahead, NOW)).toStartWith("Ends ");
    expect(signInEndStatus(behind, NOW)).toStartWith("Ended ");
    expect(signInEndNote(ahead, NOW)).toStartWith("Sign-in ends ");
    expect(signInEndNote(behind, NOW)).toStartWith("Sign-in ended ");
  });
});
