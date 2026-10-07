import { describe, expect, test } from "bun:test";
import { getLanguage, setLanguage } from "../../i18n";
import type { Quote } from "../../types/financials";
import { formatQuoteAge, formatQuoteAgeWithSource, formatQuoteNavAsOf, getMostRecentQuoteUpdate } from "./time";

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
      dataSource: "delayed" as const,
    };

    expect(formatQuoteAgeWithSource(quote, now)).toBe("◷1s");
    expect(getMostRecentQuoteUpdate([quote], now)).toBe(1_700_000_029_000);
  });

  test("counts whole seconds for a once-a-second clock, never below zero", () => {
    const now = 1_700_000_030_000;
    // Received after the clock last ticked: fresh, not negative and not a stale "0ms".
    expect(formatQuoteAgeWithSource({ lastUpdated: now - 5_000, receivedAt: now + 400 }, now, { seconds: true })).toBe("0s");
    expect(formatQuoteAgeWithSource({ lastUpdated: now - 5_000, receivedAt: now - 1_700 }, now, { seconds: true })).toBe("1s");
  });

});

test("NAV freshness labels keep the source session date after receipt and when localized or stale", () => {
  const now = Date.parse("2026-10-07T15:00:00Z");
  const quote: Quote = {
    symbol: "VFIAX", currency: "USD", instrumentType: "MUTUALFUND", listingExchangeName: "NASDAQ",
    price: 721.63, priceBasis: "per-unit", priceObservation: "nav", changeSessionDate: "2026-10-06",
    lastUpdated: Date.parse("2026-10-06T04:00:00Z"), receivedAt: now, dataSource: "delayed",
  };
  const language = getLanguage();
  try {
    setLanguage("en");
    expect(formatQuoteNavAsOf(quote, now)).toBe("NAV · as of Oct 6");
    expect(formatQuoteNavAsOf({ ...quote, stale: true }, now)).toBe("NAV · as of Oct 6");
    setLanguage("ja");
    expect(formatQuoteNavAsOf(quote, now)).toBe("NAV · 10月6日時点");
  } finally {
    setLanguage(language);
  }
});
