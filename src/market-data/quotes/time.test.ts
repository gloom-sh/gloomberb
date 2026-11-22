import { describe, expect, test } from "bun:test";
import { getLanguage, setLanguage } from "../../i18n";
import type { Quote } from "../../types/financials";
import { mergeQuoteContribution, normalizeQuoteContribution } from "./contributions";
import { resolveCanonicalQuote } from "./resolution";
import { formatQuoteAge, formatQuoteAgeWithSource, formatQuoteBookTime, formatQuoteNavAsOf, QUOTE_BOOK_UNDATED } from "./time";

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
    expect(formatQuoteNavAsOf(quote, now)).toBe("NAV · as of 6 Oct");
    expect(formatQuoteNavAsOf({ ...quote, stale: true }, now)).toBe("NAV · as of 6 Oct");
    setLanguage("ja");
    expect(formatQuoteNavAsOf(quote, now)).toBe("NAV · 10月6日時点");
  } finally {
    setLanguage(language);
  }
});

test("a book is dated by its own quote time, carried and resolved with that book only, and says so when undated", () => {
  // EWG's after-hours book was quoted at 00:55 UTC Saturday; its last trade printed at 23:20 Friday.
  const now = Date.parse("2026-11-22T10:00:00Z");
  const trade = Date.parse("2026-11-20T23:20:59Z");
  const bookAt = Date.parse("2026-11-21T00:55:21Z");
  const cloud = normalizeQuoteContribution({
    symbol: "EWG", price: 40.35, currency: "USD", change: 0, changePercent: 0, priceBasis: "per-unit",
    bid: 39.17, ask: 41.48, bidSize: 200, askSize: 100, bidAskTime: bookAt, lastUpdated: trade,
    providerId: "gloomberb-cloud", dataSource: "delayed",
  })!;
  expect(formatQuoteBookTime(cloud, now)).toBe("Sat 00:55 UTC");
  expect(formatQuoteBookTime({ ...cloud, bidAskTime: undefined }, now)).toBe(QUOTE_BOOK_UNDATED);
  expect(formatQuoteBookTime({ ...cloud, bid: undefined, ask: undefined }, now)).toBeNull();

  // A trade tick with no book keeps the book and its time; a new book sent without a time is undated.
  const { bid: _bid, ask: _ask, bidAskTime: _bookAt, ...tick } = cloud;
  const traded = mergeQuoteContribution(cloud, { ...tick, price: 40.4, lastUpdated: trade + 1000 });
  expect(traded).toMatchObject({ bid: 39.17, bidAskTime: bookAt });
  const rebooked = mergeQuoteContribution(cloud, { ...tick, bid: 39.2, ask: 41.5, lastUpdated: trade + 2000 });
  expect(rebooked.bid).toBe(39.2);
  expect(rebooked.bidAskTime).toBeUndefined();

  // The resolved book's time is the time of the source whose book it shows, never another source's.
  const broker = normalizeQuoteContribution({ ...cloud, bid: 40.3, ask: 40.4, bidAskTime: undefined, providerId: "ibkr", dataSource: "live", lastUpdated: now })!;
  const resolved = resolveCanonicalQuote({ ibkr: broker, "gloomberb-cloud": cloud }, now).quote!;
  expect(resolved.bid).toBe(40.3);
  expect(resolved.bidAskTime).toBeUndefined();
  expect(resolveCanonicalQuote({ "gloomberb-cloud": cloud }, now).quote!.bidAskTime).toBe(bookAt);
});
