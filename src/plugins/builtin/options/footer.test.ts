import { describe, expect, test } from "bun:test";
import { resolveOptionsDelayLabel } from "./footer";

describe("options delay label", () => {
  test("prefers the chain delay and falls back to the cloud default", () => {
    expect(resolveOptionsDelayLabel({
      underlyingSymbol: "AAPL",
      expirationDates: [],
      calls: [],
      puts: [],
      delayMinutes: 20,
    })).toBe("20m");
    // A live chain reports 0, and a cached chain may omit the field entirely.
    expect(resolveOptionsDelayLabel({
      underlyingSymbol: "AAPL",
      expirationDates: [],
      calls: [],
      puts: [],
      delayMinutes: 0,
    })).toBe("15m");
    expect(resolveOptionsDelayLabel(null)).toBe("15m");
  });
});
