import { describe, expect, test } from "bun:test";
import type { Quote } from "../../types/financials";
import { isQuoteStaleForCurrentSession } from "./freshness";
import { createDailyNavQuote } from "../../test-support/daily-nav";

function quote(overrides: Partial<Quote>): Quote {
  return {
    symbol: "2337",
    price: 168,
    currency: "TWD",
    change: 0,
    changePercent: 0,
    lastUpdated: Date.parse("2026-05-08T06:00:00Z"),
    listingExchangeName: "TWSE",
    exchangeName: "TWSE",
    marketState: "CLOSED",
    dataSource: "delayed",
    ...overrides,
  };
}

describe("quote freshness", () => {
  test("keeps the previous daily NAV through the next session until its close settles", () => {
    const nav = createDailyNavQuote();
    for (const time of ["2026-10-07T15:00:00Z", "2026-10-07T09:00:00Z", "2026-10-07T20:29:59Z"]) {
      expect(isQuoteStaleForCurrentSession(nav, Date.parse(time)), time).toBe(false);
    }
    expect(isQuoteStaleForCurrentSession(nav, Date.parse("2026-10-07T20:30:00Z"))).toBe(true);
    expect(isQuoteStaleForCurrentSession(createDailyNavQuote({ changeSessionDate: "2026-10-05",
      lastUpdated: Date.parse("2026-10-05T04:00:00Z") }), Date.parse("2026-10-07T15:00:00Z"))).toBe(true);
  });

  test.each([
    ["2026-07-02", "2026-07-03T15:00:00Z", false],
    ["2026-07-02", "2026-07-05T21:00:00Z", false],
    ["2026-07-02", "2026-07-06T20:29:59Z", false],
    ["2026-07-02", "2026-07-06T20:30:00Z", true],
    ["2026-11-25", "2026-11-27T18:29:59Z", false],
    ["2026-11-25", "2026-11-27T18:30:00Z", true],
    ["2026-11-27", "2026-11-29T21:00:00Z", false],
    ["2026-03-06", "2026-03-09T20:29:59Z", false],
    ["2026-03-06", "2026-03-09T20:30:00Z", true],
    ["2025-01-08", "2025-01-09T22:00:00Z", false],
  ] as const)("dates NAV %s against the published settled session at %s", (date, time, stale) => {
    const nav = createDailyNavQuote({ changeSessionDate: date, lastUpdated: Date.parse(`${date}T12:00:00Z`) });
    for (const listingExchangeName of ["NASDAQ", "NasdaqGM", "NYSE"]) {
      expect(isQuoteStaleForCurrentSession({ ...nav, listingExchangeName }, Date.parse(time))).toBe(stale);
    }
  });

  test("daily NAV validation cannot bypass stale, malformed dates, unknown calendars or price domains", () => {
    const now = Date.parse("2026-10-07T15:00:00Z");
    const invalid: Partial<Quote>[] = [
      { stale: true }, { priceObservation: undefined }, { instrumentType: undefined },
      ...["EQUITY", "ETF", "CLOSEDENDFUND", "MONEYMARKET"].map(instrumentType => ({ instrumentType })),
      { priceBasis: "percent-of-par" }, { priceBasis: "points" },
      ...[0, -1, NaN, Infinity].map(price => ({ price })),
      ...[0, NaN, Infinity, now + 1, Date.parse("2026-10-05T04:00:00Z")].map(lastUpdated => ({ lastUpdated })),
      ...[undefined, "", "2026-10-6", "2026-02-30", "2026-10-04", "2026-10-08", "2026-09-07", "2029-10-05"].map(changeSessionDate => ({ changeSessionDate })),
      { listingExchangeName: "UNKNOWN", exchangeName: "UNKNOWN" },
      { listingExchangeName: "LSE", exchangeName: "LSE" },
      { listingExchangeName: undefined, exchangeName: undefined },
    ];
    for (const fields of invalid) {
      expect(isQuoteStaleForCurrentSession(createDailyNavQuote(fields), now), JSON.stringify(fields)).toBe(true);
    }
    const malformed = { ...createDailyNavQuote(), priceObservation: "intraday" } as unknown as Quote;
    expect(isQuoteStaleForCurrentSession(malformed, now)).toBe(true);
    const uncovered = createDailyNavQuote({ changeSessionDate: "2028-12-29", lastUpdated: Date.parse("2028-12-29T05:00:00Z") });
    expect(isQuoteStaleForCurrentSession(uncovered, Date.parse("2029-01-01T15:00:00Z"))).toBe(true);
    const firstCoveredDay = createDailyNavQuote({ changeSessionDate: "2025-01-02", lastUpdated: Date.parse("2025-01-02T05:00:00Z") });
    expect(isQuoteStaleForCurrentSession(firstCoveredDay, Date.parse("2025-01-02T15:00:00Z"))).toBe(true);
  });

  test.each([
    ["PRE", "2026-09-11T07:59:59Z", false],
    ["PRE", "2026-09-11T08:00:00Z", true],
    ["PRE", "2026-09-11T13:29:59Z", true],
    ["PRE", "2026-09-11T13:30:00Z", false],
    ["POST", "2026-09-11T19:59:59Z", false],
    ["POST", "2026-09-11T20:00:00Z", true],
    ["POST", "2026-09-11T23:59:59Z", true],
    ["POST", "2026-09-12T00:00:00Z", false],
    ["PRE", "2026-09-12T12:00:00Z", false],
    ["POST", "2026-09-13T21:00:00Z", false],
    ["PREPRE", "2026-09-11T07:00:00Z", false],
    ["POSTPOST", "2026-09-12T02:00:00Z", false],
    ["PRE", "2026-01-06T08:59:59Z", false],
    ["PRE", "2026-01-06T09:00:00Z", true],
    ["POST", "2026-01-07T00:59:59Z", true],
    ["POST", "2026-01-07T01:00:00Z", false],
  ] as const)("requires a missing %s price only in its current active session at %s", (marketState, timestamp, expected) => {
    const now = Date.parse(timestamp);
    const input = quote({ currency: "USD", listingExchangeName: "NASDAQ", exchangeName: "NMS", marketState, lastUpdated: now - 1_000 });
    expect(isQuoteStaleForCurrentSession(input, now)).toBe(expected);
    expect(isQuoteStaleForCurrentSession({ ...input, preMarketPrice: 168, postMarketPrice: 168 }, now)).toBe(false);
    expect(isQuoteStaleForCurrentSession({ ...input, stale: true }, now)).toBe(true);
  });

  test("recorded NasdaqGM alias preserves active-session and old-date guards", () => {
    const active = Date.parse("2026-09-11T22:00:00Z");
    for (const listingExchangeName of ["NGM", "NasdaqGM", "NASDAQGM"]) {
      const input = quote({ listingExchangeName, exchangeName: "NGM", currency: "USD", marketState: "POST", lastUpdated: active - 1_000 });
      expect(isQuoteStaleForCurrentSession(input, active)).toBe(true);
      expect(isQuoteStaleForCurrentSession(input, Date.parse("2026-09-12T03:00:00Z"))).toBe(false);
      expect(isQuoteStaleForCurrentSession(input, Date.parse("2026-09-14T14:00:00Z"))).toBe(true);
    }
  });

  test("retained or unknown provider states cannot establish a price for the current extended session", () => {
    const postNow = Date.parse("2026-09-14T22:00:00Z");
    const retained = quote({ currency: "USD", listingExchangeName: "NASDAQ", marketState: "PRE", lastUpdated: Date.parse("2026-09-14T09:00:00Z") });
    expect(isQuoteStaleForCurrentSession(retained, postNow)).toBe(true);
    expect(isQuoteStaleForCurrentSession({ ...retained, preMarketPrice: 168 }, postNow)).toBe(true);
    expect(isQuoteStaleForCurrentSession({ ...retained, marketState: "POST", preMarketPrice: 168 }, postNow)).toBe(true);
    expect(isQuoteStaleForCurrentSession({ ...retained, marketState: "POST", postMarketPrice: 168, lastUpdated: postNow }, postNow)).toBe(false);
    for (const marketState of ["REGULAR", "POSTPOST", "CLOSED", undefined] as const) {
      expect(isQuoteStaleForCurrentSession({ ...retained, marketState, postMarketPrice: 168 }, postNow)).toBe(true);
    }
    const preNow = Date.parse("2026-09-14T09:00:00Z");
    expect(isQuoteStaleForCurrentSession({ ...retained, marketState: "POST", postMarketPrice: 168 }, preNow)).toBe(true);
    expect(isQuoteStaleForCurrentSession({ ...retained, postMarketPrice: 168 }, preNow)).toBe(true);
    expect(isQuoteStaleForCurrentSession({ ...retained, preMarketPrice: 168 }, preNow)).toBe(false);
    expect(isQuoteStaleForCurrentSession({ ...retained, marketState: undefined, preMarketPrice: 168 }, preNow)).toBe(true);
    expect(isQuoteStaleForCurrentSession({ ...retained, marketState: undefined }, Date.parse("2026-09-15T03:00:00Z"))).toBe(false);
  });

  test("overnight labels cannot bypass explicit stale or the existing prior-session date check", () => {
    const input = quote({ listingExchangeName: "ARCA", currency: "USD", marketState: "POSTPOST", lastUpdated: Date.parse("2026-09-11T23:59:52Z") });
    expect(isQuoteStaleForCurrentSession(input, Date.parse("2026-09-12T03:00:00Z"))).toBe(false);
    expect(isQuoteStaleForCurrentSession(input, Date.parse("2026-09-14T14:00:00Z"))).toBe(true);
    expect(isQuoteStaleForCurrentSession(input, Date.parse("2026-09-15T02:00:00Z"))).toBe(true);
    expect(isQuoteStaleForCurrentSession(input, Date.parse("2026-09-14T07:59:59Z"))).toBe(false);
    expect(isQuoteStaleForCurrentSession({ ...input, stale: true }, Date.parse("2026-09-12T03:00:00Z"))).toBe(true);
    expect(isQuoteStaleForCurrentSession({ ...input, marketState: "REGULAR", lastUpdated: Date.parse("2026-09-14T14:00:00Z") }, Date.parse("2026-09-14T14:01:00Z"))).toBe(false);
  });

  test("treats multi-business-day-old non-US closed quotes as stale", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({}),
        Date.parse("2026-05-13T21:00:00Z"),
      ),
    ).toBe(true);
  });

  test("treats stale Paris and Toronto quotes as refreshable", () => {
    const now = Date.parse("2026-05-13T21:00:00Z");

    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "ALRIB",
          currency: "EUR",
          lastUpdated: Date.parse("2026-05-08T15:30:00Z"),
          listingExchangeName: "PAR",
          exchangeName: "PAR",
        }),
        now,
      ),
    ).toBe(true);

    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "HPS-A.TO",
          currency: "CAD",
          lastUpdated: Date.parse("2026-05-08T20:00:00Z"),
          listingExchangeName: "TOR",
          exchangeName: "TOR",
        }),
        now,
      ),
    ).toBe(true);
  });

  test("treats same-day crypto quotes older than two hours as stale", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "BTC-USD",
          currency: "USD",
          lastUpdated: Date.parse("2026-05-13T12:00:00Z"),
          listingExchangeName: "CCC",
          exchangeName: "CCC",
          marketState: "REGULAR",
        }),
        Date.parse("2026-05-13T21:00:00Z"),
      ),
    ).toBe(true);
  });

  test("treats old crypto quotes as stale on the 24/7 venue", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "BTC-USD",
          currency: "USD",
          lastUpdated: Date.parse("2026-05-09T15:29:00Z"),
          listingExchangeName: "CCC",
          exchangeName: "CCC",
          marketState: "REGULAR",
        }),
        Date.parse("2026-05-13T21:00:00Z"),
      ),
    ).toBe(true);
  });

  test("allows the previous local business day before the market reopens", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "1211",
          currency: "HKD",
          lastUpdated: Date.parse("2026-05-13T08:00:00Z"),
          listingExchangeName: "SEHK",
          exchangeName: "SEHK",
        }),
        Date.parse("2026-05-13T21:00:00Z"),
      ),
    ).toBe(false);
  });

  test("rejects previous-day weekday quotes that are older than a normal overnight close", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "285A.T",
          currency: "JPY",
          lastUpdated: Date.parse("2026-05-12T21:00:00Z"),
          listingExchangeName: "JPX",
          exchangeName: "JPX",
        }),
        Date.parse("2026-05-13T21:00:00Z"),
      ),
    ).toBe(true);

    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "285A.T",
          currency: "JPY",
          lastUpdated: Date.parse("2026-05-13T06:24:00Z"),
          listingExchangeName: "JPX",
          exchangeName: "JPX",
        }),
        Date.parse("2026-05-13T21:00:00Z"),
      ),
    ).toBe(false);
  });

  test("allows Friday closes before Monday reopen", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "285A.T",
          currency: "JPY",
          lastUpdated: Date.parse("2026-05-08T06:24:00Z"),
          listingExchangeName: "JPX",
          exchangeName: "JPX",
        }),
        Date.parse("2026-05-10T21:00:00Z"),
      ),
    ).toBe(false);
  });

  test("allows prior-day regular-session quotes before the local exchange reopens", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "NEO.TO",
          currency: "CAD",
          lastUpdated: Date.parse("2026-07-06T20:00:00Z"),
          listingExchangeName: "TOR",
          exchangeName: "TOR",
          marketState: "REGULAR",
        }),
        Date.parse("2026-07-07T12:10:00Z"),
      ),
    ).toBe(false);
  });

  test("allows non-US premarket labels without active-session prices", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "NEO.TO",
          currency: "CAD",
          lastUpdated: Date.parse("2026-07-07T12:10:00Z"),
          listingExchangeName: "TOR",
          exchangeName: "TOR",
          marketState: "PRE",
        }),
        Date.parse("2026-07-07T12:10:30Z"),
      ),
    ).toBe(false);
  });

  test("rejects US premarket labels without active-session prices", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "ALAB",
          currency: "USD",
          lastUpdated: Date.parse("2026-07-07T12:10:00Z"),
          listingExchangeName: "NASDAQ",
          exchangeName: "NASDAQ",
          marketState: "PRE",
        }),
        Date.parse("2026-07-07T12:10:30Z"),
      ),
    ).toBe(true);
  });

  test("treats prior-date regular-session quotes as stale after the local exchange reopens", () => {
    expect(
      isQuoteStaleForCurrentSession(
        quote({
          symbol: "HY9H",
          currency: "EUR",
          lastUpdated: Date.parse("2026-04-07T19:55:00Z"),
          listingExchangeName: "FWB2",
          exchangeName: "FWB2",
          marketState: "REGULAR",
        }),
        Date.parse("2026-04-08T10:49:00Z"),
      ),
    ).toBe(true);
  });
});
