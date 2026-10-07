import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  dropUnusableProviderQuote,
  mergeFinancials,
  mergeMissingStatementArrays,
  mergeRefreshedFinancials,
  isProviderQuoteUsableForCurrentSession,
} from "./financials";
import { createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import { createDailyNavQuote } from "../../test-support/daily-nav";

describe("provider-router financial quote usability", () => {
  let clock: ReturnType<typeof spyOn>;
  beforeEach(() => {
    clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-14T18:00:00Z"));
  });
  afterEach(() => clock.mockRestore());

  test("accepts the dated daily NAV in quotes and embedded financials during regular hours", () => {
    clock.mockReturnValue(Date.parse("2026-10-07T15:00:00Z"));
    const quote = createDailyNavQuote();
    expect(isProviderQuoteUsableForCurrentSession(quote, "NASDAQ", "VFIAX")).toBe(true);
    const financials = { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] };
    expect(dropUnusableProviderQuote(financials, "NASDAQ").quote).toEqual(quote);
    expect(isProviderQuoteUsableForCurrentSession(quote, "NYSE", "VFIAX")).toBe(false);
    expect(isProviderQuoteUsableForCurrentSession(quote, "NASDAQ", "FXAIX")).toBe(false);
    expect(isProviderQuoteUsableForCurrentSession({ ...quote, listingExchangeName: undefined,
      exchangeName: undefined }, "NASDAQ", "VFIAX")).toBe(false);
    for (const invalid of [{ stale: true }, { changeSessionDate: "2026-10-05" }, { instrumentType: "ETF" }]) {
      expect(dropUnusableProviderQuote({ ...financials, quote: { ...quote, ...invalid } }, "NASDAQ").quote).toBeUndefined();
    }
    clock.mockReturnValue(Date.parse("2026-10-08T07:59:59.999Z"));
    expect(dropUnusableProviderQuote(financials, "NASDAQ").quote).toEqual(quote);
    clock.mockReturnValue(Date.parse("2026-10-08T08:00:00Z"));
    expect(dropUnusableProviderQuote(financials, "NASDAQ").quote).toBeUndefined();
  });

  test("rejects active-session labels without active-session prices", () => {
    clock.mockReturnValue(Date.parse("2026-09-14T11:00:00Z"));
    expect(isProviderQuoteUsableForCurrentSession(createTestQuote({
      listingExchangeName: "NASDAQ",
      marketState: "PRE",
      lastUpdated: Date.now(),
    }), "NASDAQ")).toBe(false);
  });

  test("keeps the previous close before any pre-market trade, but not an older one", () => {
    // Wednesday 05:30 New York; Tuesday's last print was the 16:00 close.
    clock.mockReturnValue(Date.parse("2026-09-23T09:30:00Z"));
    const close = createTestQuote({ listingExchangeName: "NYSE", marketState: "PRE", dataSource: "delayed",
      lastUpdated: Date.parse("2026-09-22T20:00:00Z") });
    expect(isProviderQuoteUsableForCurrentSession(close, "NYSE")).toBe(true);
    expect(isProviderQuoteUsableForCurrentSession({ ...close, preMarketPrice: 101 }, "NYSE")).toBe(true);
    expect(isProviderQuoteUsableForCurrentSession({ ...close, marketState: "CLOSED" }, "NYSE")).toBe(false);
    expect(isProviderQuoteUsableForCurrentSession({ ...close, lastUpdated: Date.parse("2026-09-21T20:00:00Z") }, "NYSE")).toBe(false);
    // Yesterday's own pre-market print is not a close.
    expect(isProviderQuoteUsableForCurrentSession({ ...close, preMarketPrice: 101,
      lastUpdated: Date.parse("2026-09-22T12:30:00Z") }, "NYSE")).toBe(false);
    // After the Labor Day closure, Friday is the previous session.
    clock.mockReturnValue(Date.parse("2026-09-08T09:30:00Z"));
    expect(isProviderQuoteUsableForCurrentSession({ ...close, lastUpdated: Date.parse("2026-09-04T20:00:00Z") }, "NYSE")).toBe(true);
  });

  test("keeps a Tokyo close through published exchange holidays", () => {
    const toyota = createTestQuote({ symbol: "7203.T", listingExchangeName: "JPX", marketState: "CLOSED",
      dataSource: "delayed", lastUpdated: Date.parse("2026-09-18T06:30:00Z") });
    // Sep 21-23 2026 are JPX holidays; Sep 24 trades again.
    for (const now of ["2026-09-23T02:00:00Z", "2026-09-23T23:30:00Z"]) {
      clock.mockReturnValue(Date.parse(now));
      expect(isProviderQuoteUsableForCurrentSession(toyota, "JPX")).toBe(true);
    }
    clock.mockReturnValue(Date.parse("2026-09-24T23:30:00Z"));
    expect(isProviderQuoteUsableForCurrentSession(toyota, "JPX")).toBe(false);
  });

  test("keeps an NSE close through a published holiday and the weekend after it", () => {
    const nifty = createTestQuote({ symbol: "^NSEI", listingExchangeName: "NSE", marketState: "CLOSED",
      dataSource: "delayed", lastUpdated: Date.parse("2026-10-01T10:00:00Z") });
    // Fri Oct 2 2026 (Gandhi Jayanti) is closed; Mon Oct 5 trades again.
    for (const now of ["2026-10-03T06:00:00Z", "2026-10-05T03:00:00Z"]) {
      clock.mockReturnValue(Date.parse(now));
      expect(isProviderQuoteUsableForCurrentSession(nifty, "NSE")).toBe(true);
    }
    clock.mockReturnValue(Date.parse("2026-10-06T02:00:00Z"));
    expect(isProviderQuoteUsableForCurrentSession(nifty, "NSE")).toBe(false);
  });

  test("keeps Chinese closes through National Day, but rejects older or unusable observations", () => {
    for (const [symbol, exchange] of [["601138.SS", "SSE"], ["301219.SZ", "SZSE"]]) {
      const close = createTestQuote({ symbol, listingExchangeName: exchange, marketState: "CLOSED",
        dataSource: "delayed", lastUpdated: Date.parse("2026-09-30T07:04:07Z") });
      // Oct 1-7 are closed; Oct 8 opens at 09:30 Shanghai.
      for (const now of ["2026-10-04T08:00:00Z", "2026-10-07T08:00:00Z", "2026-10-08T01:00:00Z"]) {
        clock.mockReturnValue(Date.parse(now));
        expect(isProviderQuoteUsableForCurrentSession(close, exchange)).toBe(true);
        expect(isProviderQuoteUsableForCurrentSession({ ...close, stale: true }, exchange)).toBe(false);
        for (const lastUpdated of [Date.parse("2026-09-29T07:04:07Z"), 0, NaN, Date.now() + 60 * 60_000]) {
          expect(isProviderQuoteUsableForCurrentSession({ ...close, lastUpdated }, exchange)).toBe(false);
        }
      }
      // Tuesday 09:35 Shanghai is still before the delayed feed's first session prints.
      clock.mockReturnValue(Date.parse("2026-10-13T01:35:00Z"));
      expect(isProviderQuoteUsableForCurrentSession({ ...close,
        lastUpdated: Date.parse("2026-10-12T07:00:00Z"),
      }, exchange)).toBe(true);
    }
  });

  test("rejects old active-session provider quotes", () => {
    expect(isProviderQuoteUsableForCurrentSession(createTestQuote({
      listingExchangeName: "FWB2",
      marketState: "REGULAR",
      lastUpdated: Date.now() - 20 * 60_000,
    }), "FWB2")).toBe(false);
  });

  test("accepts a streamed 15-minute delayed quote during the active session", () => {
    expect(
      isProviderQuoteUsableForCurrentSession(
        createTestQuote({
          dataSource: "delayed",
          listingExchangeName: "NASDAQ",
          marketState: "REGULAR",
          lastUpdated: Date.now() - 15 * 60_000,
        }),
        "NASDAQ",
      ),
    ).toBe(true);
  });

  test("keeps a delayed quote the server cache has aged past twenty minutes", () => {
    expect(isProviderQuoteUsableForCurrentSession(createTestQuote({
      dataSource: "delayed",
      listingExchangeName: "NASDAQ",
      marketState: "REGULAR",
      lastUpdated: Date.now() - 25 * 60_000,
    }), "NASDAQ")).toBe(true);
  });

  test("still rejects a delayed quote the provider stopped updating", () => {
    expect(isProviderQuoteUsableForCurrentSession(createTestQuote({
      dataSource: "delayed",
      listingExchangeName: "NASDAQ",
      marketState: "REGULAR",
      lastUpdated: Date.now() - 35 * 60_000,
    }), "NASDAQ")).toBe(false);
  });

  test("keeps a closed Asian index that Gloom still labels POST hours after the close", () => {
    expect(isProviderQuoteUsableForCurrentSession(createTestQuote({
      symbol: "^N225",
      dataSource: "delayed",
      listingExchangeName: "OSAKA",
      marketState: "POST",
      lastUpdated: Date.now() - 6 * 60 * 60_000,
    }), "OSAKA")).toBe(true);
  });

  test("still ages out a US after-hours quote the provider stopped updating", () => {
    clock.mockReturnValue(Date.parse("2026-09-14T22:00:00Z"));
    expect(isProviderQuoteUsableForCurrentSession(createTestQuote({
      listingExchangeName: "NASDAQ",
      marketState: "POST",
      postMarketPrice: 101,
      lastUpdated: Date.now() - 15 * 60_000,
    }), "NASDAQ")).toBe(false);
  });

  test("retained US session labels stop the intraday age limit only outside active hours", () => {
    for (const marketState of ["PRE", "REGULAR", "POST"] as const) {
      const quote = createTestQuote({ listingExchangeName: "NASDAQGM", marketState, preMarketPrice: 101, postMarketPrice: 102,
        lastUpdated: Date.parse("2026-09-11T23:58:46Z"), dataSource: "delayed" });
      for (const time of ["2026-09-12T03:01:00Z", "2026-09-12T16:00:00Z", "2026-09-14T07:59:59Z"]) {
        clock.mockReturnValue(Date.parse(time));
        // A retained REGULAR label still follows its existing overnight date
        // policy; PRE/POST closing observations may survive the weekend.
        expect(isProviderQuoteUsableForCurrentSession(quote)).toBe(!(marketState === "REGULAR" && time === "2026-09-12T16:00:00Z"));
        expect(isProviderQuoteUsableForCurrentSession({ ...quote, stale: true })).toBe(false);
      }
      clock.mockReturnValue(Date.parse("2026-09-15T02:00:00Z"));
      expect(isProviderQuoteUsableForCurrentSession(quote)).toBe(false);
    }
    for (const [time, marketState] of [["2026-09-14T11:00:00Z", "PRE"], ["2026-09-14T18:00:00Z", "REGULAR"], ["2026-09-14T22:00:00Z", "POST"]] as const) {
      clock.mockReturnValue(Date.parse(time));
      const quote = createTestQuote({ listingExchangeName: "NASDAQGM", marketState, preMarketPrice: 101, postMarketPrice: 102,
        lastUpdated: Date.now() - 31 * 60_000, dataSource: "delayed" });
      expect(isProviderQuoteUsableForCurrentSession(quote)).toBe(false);
      expect(isProviderQuoteUsableForCurrentSession({ ...quote, lastUpdated: Date.now() - 16 * 60_000 })).toBe(true);
    }
  });

  test("rejects empty zero provider quotes", () => {
    expect(isProviderQuoteUsableForCurrentSession(createTestQuote({
      price: 0,
      change: 0,
      changePercent: 0,
      listingExchangeName: "SFB",
      lastUpdated: Date.now(),
    }), "SFB")).toBe(false);
  });

  test("strips unusable quotes while preserving non-quote financials", () => {
    const value = dropUnusableProviderQuote(createTestFinancials({
      profile: { sector: "Industrials" },
      quote: createTestQuote({
        price: 0,
        change: 0,
        changePercent: 0,
        listingExchangeName: "SFB",
      }),
    }), "SFB");

    expect(value.profile?.sector).toBe("Industrials");
    expect(value.quote).toBeUndefined();
  });
});


test("keeps incompatible and unverified reporting currencies out of merged valuation inputs", () => {
  const primary = createTestFinancials({ fundamentals: { financialCurrency: "USD", revenue: 100 } });
  const fallback = createTestFinancials({ fundamentals: { financialCurrency: "TWD", revenue: 3000, freeCashFlow: 500 } });
  expect(mergeFinancials(primary, fallback)?.fundamentals).toEqual({ financialCurrency: "USD", revenue: 100 });
  primary.fundamentals!.financialCurrency = undefined;
  expect(mergeFinancials(primary, fallback)?.fundamentals?.financialCurrency).toBeUndefined();
});

test("fallback reporting currency does not label unknown primary statement units", () => {
  const primary = createTestFinancials({ annualStatements: [{ date: "2025-12-31", totalRevenue: 100 }] });
  const fallback = createTestFinancials({ financialCurrency: "TWD", annualStatements: [{ date: "2024-12-31", currency: "TWD", totalRevenue: 3000 }] });
  expect(mergeMissingStatementArrays(primary, fallback).financialCurrency).toBeUndefined();
  expect(mergeFinancials(primary, fallback)?.financialCurrency).toBeUndefined();
});

test("yield basis and source stay attached to the selected yield observation", () => {
  const forward = createTestFinancials({ fundamentals: { dividendYield: 0.0399, dividendYieldBasis: "forward", dividendYieldSource: "gloom" } });
  const trailing = createTestFinancials({ fundamentals: { dividendYield: 0.03, dividendYieldBasis: "trailing", dividendYieldSource: "gloom", revenue: 100 } });
  expect(mergeFinancials(forward, trailing)?.fundamentals).toMatchObject({ dividendYield: 0.0399, dividendYieldBasis: "forward", dividendYieldSource: "gloom", revenue: 100 });
  const unknown = createTestFinancials({ fundamentals: { dividendYield: 0.16 } });
  expect(mergeFinancials(unknown, forward)?.fundamentals?.dividendYieldBasis).toBeUndefined();
  expect(mergeFinancials(unknown, forward)?.fundamentals?.dividendYieldSource).toBeUndefined();
  expect(mergeFinancials(createTestFinancials({ fundamentals: { revenue: 200 } }), forward)?.fundamentals).toMatchObject({ dividendYield: 0.0399, dividendYieldBasis: "forward", dividendYieldSource: "gloom" });
});

test("per-share bases that reprice a multiple stay with that multiple's observation", () => {
  // The fresh block withdrew its bases; an older fallback's must not pair with the new multiple and yield.
  const fresh = createTestFinancials({ fundamentals: { forwardPE: 30, dividendYield: 0.01 } });
  const older = createTestFinancials({ fundamentals: { forwardPE: 20, forwardEps: 5, dividendYield: 0.02, dividendRate: 2, revenue: 100 } });
  const merged = mergeFinancials(fresh, older)?.fundamentals;
  expect(merged).toMatchObject({ forwardPE: 30, dividendYield: 0.01, revenue: 100 });
  expect(merged?.forwardEps).toBeUndefined();
  expect(merged?.dividendRate).toBeUndefined();
  expect(mergeFinancials(createTestFinancials({ fundamentals: { revenue: 200 } }), older)?.fundamentals)
    .toMatchObject({ forwardPE: 20, forwardEps: 5, dividendYield: 0.02, dividendRate: 2 });
  // Enrichment keeps the cached multiple and yield, but a base the same source withdrew stops repricing them.
  const enriched = mergeRefreshedFinancials(older, fresh).fundamentals;
  expect(enriched).toMatchObject({ forwardPE: 20, dividendYield: 0.02, revenue: 100 });
  expect(enriched?.forwardEps).toBeUndefined();
  expect(enriched?.dividendRate).toBeUndefined();
  // A response without the multiple or yield withdrew nothing.
  expect(mergeRefreshedFinancials(older, createTestFinancials({ fundamentals: { revenue: 200 } })).fundamentals)
    .toMatchObject({ forwardEps: 5, dividendRate: 2 });
});
