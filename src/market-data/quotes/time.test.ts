import { describe, expect, test } from "bun:test";
import { formatQuoteAge, formatQuoteAgeWithSource, getMostRecentQuoteUpdate } from "./time";

describe("quote-time", () => {
  test("formats sub-second quote age in milliseconds", () => {
    const now = 1_700_000_030_000;

    expect(formatQuoteAge(now - 999, now)).toBe("999ms");
    expect(formatQuoteAge(now, now)).toBe("0ms");
    expect(formatQuoteAgeWithSource({
      lastUpdated: now - 100,
      dataSource: "delayed",
    }, now)).toBe("◷100ms");
  });

  test("uses stream receipt time for displayed quote age when available", () => {
    const now = 1_700_000_030_000;
    const quote = {
      lastUpdated: 1_700_000_000_000,
      receivedAt: 1_700_000_029_000,
    };

    expect(formatQuoteAgeWithSource(quote, now)).toBe("1s");
    expect(getMostRecentQuoteUpdate([quote], now)).toBe(1_700_000_029_000);
  });

  test("counts whole seconds for a once-a-second clock, never below zero", () => {
    const now = 1_700_000_030_000;
    // Received after the clock last ticked: fresh, not negative and not a stale "0ms".
    expect(formatQuoteAgeWithSource({ lastUpdated: now - 5_000, receivedAt: now + 400 }, now, { seconds: true })).toBe("0s");
    expect(formatQuoteAgeWithSource({ lastUpdated: now - 5_000, receivedAt: now - 1_700 }, now, { seconds: true })).toBe("1s");
  });

  test("keeps delayed source marker while using receipt time for age", () => {
    expect(formatQuoteAgeWithSource({
      lastUpdated: 1_700_000_000_000,
      receivedAt: 1_700_000_029_000,
      dataSource: "delayed",
    }, 1_700_000_030_000)).toBe("◷1s");
  });
});
