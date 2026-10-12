import { describe, expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../types/financials";
import { createTestQuote } from "../test-support/data-provider";
import { fundamentalsFreshness, quotesFreshness } from "./freshness";
import { formatFreshnessLine, formatStatusLine } from "./pane-functions/freshness";

const NOW = Date.parse("2026-10-09T13:30:00Z");

test("fundamentals are dated by their observation and name the period they run through", () => {
  const financials: TickerFinancials = {
    priceHistory: [],
    annualStatements: [{ date: "2025-12-31" }],
    quarterlyStatements: [{ date: "2026-03-31" }, { date: "2026-06-30" }],
    fundamentals: { fetchedAt: "2026-10-09T10:35:52.308Z", eps: -99.08 },
  };
  expect(fundamentalsFreshness(financials, NOW)).toMatchObject({
    asOf: "2026-10-09T10:35:52.308Z", status: "not-a-feed", basis: "reported through 2026-06-30",
  });
  // Old reported figures are not stale by age; the block's own flag makes them so.
  expect(fundamentalsFreshness({ ...financials, fundamentals: { ...financials.fundamentals, stale: true } }, NOW).status).toBe("stale");
  // Nothing dated: the line says when it was retrieved instead.
  expect(fundamentalsFreshness({ priceHistory: [], annualStatements: [], quarterlyStatements: [] }, NOW)).toMatchObject({
    asOf: null, basis: "reported data",
  });
});

describe("quote status line", () => {
  const cloudQuote = (overrides: Partial<Quote>): Quote => createTestQuote({
    providerId: "gloomberb-cloud", dataSource: "delayed", listingExchangeName: "NASDAQ", marketState: "CLOSED", ...overrides,
  });
  const status = (quotes: Quote[], now: string) => formatStatusLine(quotesFreshness(quotes, undefined, Date.parse(now))!);
  // Friday's last after-hours print, 19:59 New York.
  const fridayClose = Date.parse("2026-10-09T23:59:00Z");

  test("a delayed US quote over the weekend is Friday's close, reopening Monday", () => {
    const freshness = quotesFreshness([cloudQuote({ lastUpdated: fridayClose })], undefined, Date.parse("2026-10-10T13:00:00Z"))!;
    expect(formatFreshnessLine(freshness)).toBe("Source: Gloom Cloud · US trading day Fri 9 Oct 2026 close · 15 min delayed · markets closed until Mon");
    expect(freshness).toMatchObject({ delayMinutes: 15, asOfClose: "2026-10-09", tradingDayMarket: "US", market: { state: "closed", reopensAt: "2026-10-12T13:30:00.000Z", reopensOn: "2026-10-12" } });
  });

  test("an exchange holiday is not a session", () => {
    // Good Friday 2026: Thursday's close is still the latest on Saturday.
    expect(status([cloudQuote({ lastUpdated: Date.parse("2026-04-02T20:00:00Z") })], "2026-04-04T15:00:00Z"))
      .toBe("US trading day Thu 2 Apr 2026 close · 15 min delayed · markets closed until Mon");
    // Thanksgiving 2026: closed Thursday, open Friday.
    expect(status([cloudQuote({ lastUpdated: Date.parse("2026-11-25T21:00:00Z") })], "2026-11-26T03:00:00Z"))
      .toBe("US trading day Wed 25 Nov 2026 close · 15 min delayed · markets closed until Fri");
  });

  test("on a weeknight the reopen is a UTC time, and in session the as-of is the print's time", () => {
    expect(status([cloudQuote({ lastUpdated: Date.parse("2026-10-12T23:59:00Z") })], "2026-10-13T02:00:00Z"))
      .toBe("US trading day Mon 12 Oct 2026 close · 15 min delayed · markets closed until 13:30 UTC");
    expect(status([cloudQuote({ lastUpdated: Date.parse("2026-10-12T14:45:00Z"), marketState: "REGULAR" })], "2026-10-12T15:00:00Z"))
      .toBe("Mon 12 Oct 2026 14:45 UTC · 15 min delayed · markets open");
  });

  test("a foreign listing takes its venue's lag and calendar", () => {
    const bhp = cloudQuote({ symbol: "BHP", listingExchangeName: "ASX", lastUpdated: Date.parse("2026-10-09T05:20:00Z") });
    expect(status([bhp], "2026-10-10T13:00:00Z")).toBe("ASX trading day Fri 9 Oct 2026 close · 20 min delayed · markets closed until Mon");
    expect(status([bhp, cloudQuote({ lastUpdated: fridayClose })], "2026-10-10T13:00:00Z"))
      .toBe("US trading day Fri 9 Oct 2026 close · 15-20 min delayed · markets closed until Mon");
  });

  test("crypto trades around the clock, so it is never closed", () => {
    const now = "2026-10-10T13:00:00Z";
    const bitcoin = (dataSource: "live" | "delayed", minutesAgo: number) => cloudQuote({
      symbol: "BTC-USD", listingExchangeName: "CCC", marketState: "REGULAR", dataSource, lastUpdated: Date.parse(now) - minutesAgo * 60_000,
    });
    expect(status([bitcoin("live", 1)], now)).toBe("Sat 10 Oct 2026 12:59 UTC · live");
    expect(status([bitcoin("delayed", 16)], now)).toBe("Sat 10 Oct 2026 12:44 UTC · 15 min delayed");
  });
});
