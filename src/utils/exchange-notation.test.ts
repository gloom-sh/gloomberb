import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { EXCHANGE_NOTATION, EXCHANGE_NOTATION_VERSION } from "./exchange-notation.generated";
import {
  CANONICAL_EXCHANGE_ALIASES,
  canonicalExchange,
  exchangeCodeVenues,
  exchangeLabel,
  publicExchange,
  publicTickerKey,
} from "./exchanges";

// The exchange-notation table is Gloom Cloud's; the phone keeps the same copy.
// These fail when the copy is edited by hand or the terminal reads a spelling
// of its own, either of which lets the three read one listing differently.
describe("exchange-notation copy", () => {
  test("is the version it says, unedited", () => {
    const version = createHash("sha256").update(JSON.stringify(EXCHANGE_NOTATION)).digest("hex").slice(0, 16);
    expect(version).toBe(EXCHANGE_NOTATION_VERSION);
  });

  test("is every spelling, key code, name and shared code the terminal reads", () => {
    expect(CANONICAL_EXCHANGE_ALIASES).toBe(EXCHANGE_NOTATION.aliases);
    for (const [spelling, venue] of Object.entries(EXCHANGE_NOTATION.aliases)) {
      expect([spelling, canonicalExchange(spelling)]).toEqual([spelling, venue]);
    }
    for (const [venue, code] of Object.entries(EXCHANGE_NOTATION.keyCodes)) {
      expect([venue, publicExchange(venue)]).toEqual([venue, code]);
    }
    for (const [venue, name] of Object.entries(EXCHANGE_NOTATION.names)) {
      expect(exchangeLabel(venue)).toBe(`${name} (${venue})`);
    }
    for (const [code, shared] of Object.entries(EXCHANGE_NOTATION.sharedCodes)) {
      expect(exchangeCodeVenues(code)).toEqual([...shared.venues]);
    }
  });

  test("reads every Saudi spelling as one listing", () => {
    const keys = ["TADAWUL", "XSAU", "SAU", "SAUDI"].map((exchange) => publicTickerKey("2222", exchange));
    expect(new Set(keys)).toEqual(new Set(["2222:TADAWUL"]));
  });
});
