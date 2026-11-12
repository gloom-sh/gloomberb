import { describe, expect, test } from "bun:test";
import { signInEndNote, signInEndOf, signInEndStatus } from "./sign-in-end";

const NOW = Date.parse("2026-10-09T17:00:00.000Z");

describe("sign-in end", () => {
  test("a live sign-in with an end always has one to show, flagged once Gloom says to renew", () => {
    const expiresAt = "2026-10-15T15:00:00.000Z";
    const endsAt = Date.parse(expiresAt);
    expect(signInEndOf({ expiresAt, expiresSoon: true })).toEqual({ endsAt, soon: true });
    // Days away, or from a server that sends no flag: shown, not flagged.
    expect(signInEndOf({ expiresAt, expiresSoon: false })).toEqual({ endsAt, soon: false });
    expect(signInEndOf({ expiresAt })).toEqual({ endsAt, soon: false });
    // No end (a broker without a clock, or no live sign-in), or one that cannot be read.
    expect(signInEndOf({})).toBeNull();
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
