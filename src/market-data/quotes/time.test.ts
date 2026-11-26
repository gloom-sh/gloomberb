import { describe, expect, test } from "bun:test";
import { getLanguage, setLanguage } from "../../i18n";
import type { Quote } from "../../types/financials";
import { mergeQuoteContribution, normalizeQuoteContribution } from "./contributions";
import { resolveCanonicalQuote } from "./resolution";
import {
  formatQuoteAge, formatQuoteAgeWithSource, formatQuoteBookCell, formatQuoteBookTime, formatQuoteNavAsOf, QUOTE_BOOK_CELL_MAX_WIDTH,
  QUOTE_BOOK_UNDATED, quoteBookTimeParts,
} from "./time";

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

// PF's BOOK column spelled every book out as the ticket does and took 53 cells for it.
test("a table cell keeps a book's calendar day and clock, with its session and feed as marks that say what the words say, within the widest it can grow", () => {
  const now = Date.parse("2026-11-22T10:00:00Z");
  const book = (overrides: Partial<Quote>): Quote => ({
    symbol: "EWG", price: 40.35, currency: "USD", change: 0, changePercent: 0, bid: 39.17, ask: 41.48, lastUpdated: now,
    listingExchangeName: "ARCA", dataSource: "delayed", marketState: "CLOSED", ...overrides,
  });
  const at = (iso: string) => Date.parse(iso);
  // Each book as the cell writes it beside the words the ticket and DES use for the same book.
  const cases: Array<[Quote, number, string, string]> = [
    [book({ bidAskTime: at("2026-11-20T18:56:00Z") }), at("2026-11-20T23:20:00Z"), "◷20 Nov 18:56", "18:56 UTC · delayed"],
    [book({ bidAskTime: at("2026-11-20T18:56:00Z") }), now, "◷20 Nov 18:56", "Fri 20 Nov 18:56 UTC · regular session · delayed"],
    [book({ bidAskTime: at("2026-11-20T12:10:00Z") }), now, "◷PM 20 Nov 12:10", "Fri 20 Nov 12:10 UTC · pre-market · delayed"],
    [book({ bidAskTime: at("2026-11-21T00:55:21Z"), dataSource: "live" }), now, "AH 21 Nov 00:55", "Sat 21 Nov 00:55 UTC · after-hours · real-time"],
    [book({ bidAskTime: at("2026-11-21T01:30:00Z") }), now, "◷closed 21 Nov 01:30", "Sat 21 Nov 01:30 UTC · last quote · delayed"],
    [book({ bidAskTime: at("2026-11-20T04:30:00Z"), listingExchangeName: "HKEX" }), now, "◷lunch 20 Nov 04:30", "Fri 20 Nov 04:30 UTC · midday break · delayed"],
    // Months back reads as yesterday does: no weekday stands in for a date. In another year, the year leads.
    [book({ bidAskTime: at("2026-09-18T23:30:00Z") }), now, "◷AH 18 Sep 23:30", "Fri 18 Sep 23:30 UTC · after-hours · delayed"],
    [book({ bidAskTime: at("2025-09-19T00:30:00Z"), dataSource: "snapshot" }), now, "snap closed 19 Sep 2025 00:30", "Fri 19 Sep 2025 00:30 UTC · last quote · snapshot"],
    // A source that says nothing of its feed is given no mark, as it is given no word.
    [book({ bidAskTime: at("2026-11-20T18:56:00Z"), dataSource: undefined }), now, "20 Nov 18:56", "Fri 20 Nov 18:56 UTC · regular session"],
    // Undated: the quote's own state names the session, and no time is made up.
    [book({ bidAskTime: undefined }), now, "◷closed not dated", "not dated · last quote · delayed"],
    [book({ bidAskTime: undefined, marketState: "POST", dataSource: "live" }), now, "AH not dated", "not dated · after-hours book · real-time"],
    [book({ bidAskTime: undefined, marketState: "REGULAR", dataSource: "live" }), now, "not dated", "not dated · real-time"],
  ];
  for (const [quote, clock, cell, words] of cases) {
    expect([formatQuoteBookCell(quote, clock)?.text, formatQuoteBookTime(quote, clock)]).toEqual([cell, words]);
    expect(formatQuoteBookCell(quote, clock)!.dated).toBe(quote.bidAskTime != null);
  }
  expect(Math.max(...cases.map(([, , cell]) => cell.length))).toBe(QUOTE_BOOK_CELL_MAX_WIDTH);
  expect(formatQuoteBookCell(book({ bid: undefined, ask: undefined }), now)).toBeNull();
  // The mark is the book's own source's: a delayed book under a real-time price is still a delayed book.
  const mixed = book({ bidAskTime: at("2026-11-20T18:56:00Z"), dataSource: "live", provenance: { fields: { bid: { providerId: "other", dataSource: "delayed" } } } });
  expect(formatQuoteBookCell(mixed, now)!.text).toBe("◷20 Nov 18:56");
});

test("a book is dated by its own quote time, carried and resolved with that book only, and says so when undated", () => {
  // EWG's after-hours book was quoted at 00:55 UTC Saturday; its last trade printed at 23:20 Friday.
  const now = Date.parse("2026-11-22T10:00:00Z");
  const trade = Date.parse("2026-11-20T23:20:59Z");
  const bookAt = Date.parse("2026-11-21T00:55:21Z");
  const cloud = normalizeQuoteContribution({
    symbol: "EWG", price: 40.35, currency: "USD", change: 0, changePercent: 0, priceBasis: "per-unit",
    bid: 39.17, ask: 41.48, bidSize: 200, askSize: 100, bidAskTime: bookAt, lastUpdated: trade,
    listingExchangeName: "ARCA", providerId: "gloomberb-cloud", dataSource: "delayed",
  })!;
  expect(formatQuoteBookTime(cloud, now)).toBe("Sat 21 Nov 00:55 UTC · after-hours · delayed");
  // A book too narrow for the weekday dates it as a table does.
  expect(quoteBookTimeParts(cloud, now, { weekday: false })).toEqual(["21 Nov 00:55 UTC", "after-hours", "delayed"]);
  expect(formatQuoteBookTime(cloud, Date.parse("2026-11-21T09:00:00Z"))).toBe("Sat 21 Nov 00:55 UTC · after-hours · delayed");
  const regular = Date.parse("2026-11-20T18:56:00Z");
  expect(formatQuoteBookTime({ ...cloud, bidAskTime: regular }, trade)).toBe("18:56 UTC · delayed");
  expect(formatQuoteBookTime({ ...cloud, bidAskTime: regular }, now)).toBe("Fri 20 Nov 18:56 UTC · regular session · delayed");
  expect(formatQuoteBookTime({ ...cloud, bidAskTime: undefined }, now)).toBe(`${QUOTE_BOOK_UNDATED} · delayed`);
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
  expect(formatQuoteBookTime(resolved, now)).toBe(`${QUOTE_BOOK_UNDATED} · real-time`);
  const oneSided = resolveCanonicalQuote({ ibkr: { ...broker, ask: undefined }, "gloomberb-cloud": cloud }, now).quote!;
  expect(oneSided.bid).toBe(40.3);
  expect(oneSided.ask).toBeUndefined();
  expect(resolveCanonicalQuote({ "gloomberb-cloud": cloud }, now).quote!.bidAskTime).toBe(bookAt);
});
