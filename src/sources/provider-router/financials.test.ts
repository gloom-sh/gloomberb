import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  dropUnusableProviderQuote,
  mergeFinancials,
  mergeMissingStatementArrays,
  mergeRefreshedFinancials,
  providerFinancialsMatchTarget,
  isProviderQuoteUsableForCurrentSession,
} from "./financials";
import { createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import { createDailyNavQuote } from "../../test-support/daily-nav";
import { isQuoteStaleForCurrentSession } from "../../market-data/quotes/freshness";
import { mapCloudFinancials } from "../gloomberb-cloud/normalizers";
import { withFiledTrailingEps } from "../../time-series/filed-trailing-eps";
import { createValuationCurrencyContext } from "../../time-series/valuation-currency";

test("a filed predecessor series survives cloud normalization and cache merges without becoming the listed share's earnings", () => {
  const statementScope = { registrant: "0002128626", basis: "predecessor" as const, label: "Corteva consolidated (accounting predecessor)" };
  const quarter = { date: "2026-09-30", currency: "USD", totalRevenue: 2458e6, eps: -0.85, statementScope };
  const filed = mapCloudFinancials({ statementScope, quarterlyStatements: [quarter], annualStatements: [], priceHistory: [],
    financialCurrency: "USD", fundamentals: { marketCap: 40e9 } });
  const old = createTestFinancials({ quote: createTestQuote({ symbol: "VYLR", listingExchangeName: "NYSE" }),
    fundamentals: { trailingPE: 347.35 }, annualStatements: [{ date: "2025-12-31", totalRevenue: 10067e6 }],
    quarterlyStatements: [{ date: quarter.date, totalRevenue: 905e6, netIncome: -475e6 }] });
  expect(providerFinancialsMatchTarget(old, "VYLR", "NYSE")).toBe(false);
  expect(providerFinancialsMatchTarget(filed, "VYLR", "NYSE")).toBe(true);
  for (const result of [mergeFinancials(old, filed)!, mergeFinancials(filed, old)!, mergeRefreshedFinancials(old, filed), mergeMissingStatementArrays(old, filed)]) {
    expect(result.statementScope).toEqual(statementScope);
    expect(result.annualStatements).toEqual([]);
    expect(result.quarterlyStatements[0]?.totalRevenue).toBe(2458e6);
    expect(result.quarterlyStatements[0]?.netIncome).toBeUndefined();
    expect(withFiledTrailingEps(result).fundamentals?.trailingPE).toBeUndefined();
    expect(createValuationCurrencyContext(result).priceInStatementUnits(quarter, 70)).toBeNull();
  }
});

test("a reviewed standalone statement replaces historical caches atomically and can price only its own earnings", () => {
  const home = { registrant: "0002128626", basis: "standalone" as const, entity: "vylor-standalone", label: "Vylor standalone (as filed)" };
  const predecessor = { ...home, basis: "predecessor" as const, entity: "corteva-consolidated" };
  const year = { statementScope: home, date: "2027-12-31", availableAt: "2028-02-15", currency: "USD", eps: 3, totalRevenue: 120e6 };
  const book = mapCloudFinancials({ statementScope: home, statementReview: { status: "pending", reviewedThrough: "2028-02-15" },
    annualStatements: [year], quarterlyStatements: [], financialCurrency: "USD", priceHistory: [],
    fundamentals: { marketCap: 1000, trailingPeriodEnd: year.date, epsCurrency: "USD", eps: 3, trailingPE: 20 } });
  book.quote = createTestQuote({ symbol: "VYLR", currency: "USD", price: 60, listingExchangeName: "NYSE", lastUpdated: Date.parse("2028-02-16") });
  const old = createTestFinancials({ quarterlyStatements: [{ date: year.date, eps: 900 }], annualStatements: [] });
  for (const cached of [old, { ...old, statementScope: predecessor }]) {
    for (const result of [mergeFinancials(cached, book)!, mergeFinancials(book, cached)!, mergeMissingStatementArrays(cached, book), mergeRefreshedFinancials(book, cached)]) {
      expect(result.statementScope).toEqual(home);
      expect(result.statementReview).toEqual(book.statementReview);
      expect(result.quarterlyStatements).toEqual([]);
      expect(result.annualStatements).toEqual(book.annualStatements);
    }
  }
  const price = createValuationCurrencyContext(book);
  expect(price.priceInStatementUnits(year, 60)).toBe(60);
  expect(price.priceInStatementUnits({ ...year, statementScope: predecessor }, 60)).toBeNull();
  expect(price.priceInStatementUnits({ ...year, statementScope: undefined }, 60)).toBeNull();
  expect(withFiledTrailingEps(book, Date.parse("2028-02-16")).fundamentals?.trailingPE).toBe(20);
  expect(withFiledTrailingEps(book, Date.parse("2028-02-14")).fundamentals?.trailingPE).toBeUndefined();
  expect(withFiledTrailingEps({ ...book, quarterlyStatements: old.quarterlyStatements }, Date.parse("2028-02-16")).fundamentals?.trailingPE).toBeUndefined();
});

describe("provider-router financial quote usability", () => {
  let clock: ReturnType<typeof spyOn>;
  beforeEach(() => {
    clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-14T18:00:00Z"));
  });
  afterEach(() => clock.mockRestore());

  test("price and embedded financials keep the latest Nasdaq close on Thanksgiving without an active-session age bound", () => {
    clock.mockReturnValue(Date.parse("2026-11-26T15:00:00Z"));
    const quote = createTestQuote({ symbol: "NVDA", listingExchangeName: "NASDAQ", marketState: "CLOSED",
      stale: false, dataSource: "delayed", lastUpdated: Date.parse("2026-11-26T00:59:59.082Z") });
    expect(isProviderQuoteUsableForCurrentSession(quote, "NASDAQ", "NVDA")).toBe(true);
    const financials = { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] };
    expect(dropUnusableProviderQuote(financials, "NASDAQ").quote).toEqual(quote);
  });

  test.each([
    ["HKEX", "0700", "2026-10-01T03:00:00Z", "2026-09-30T08:08:00Z", "2026-09-29T08:08:00Z"],
    ["SSE", "600519", "2026-10-01T03:00:00Z", "2026-09-30T07:04:07Z", "2026-09-29T07:04:07Z"],
    ["SZSE", "301219", "2026-10-01T03:00:00Z", "2026-09-30T07:04:07Z", "2026-09-29T07:04:07Z"],
    ["JPX", "7203", "2026-11-03T02:00:00Z", "2026-11-02T06:30:00Z", "2026-10-30T06:30:00Z"],
    ["NSE", "RELIANCE", "2026-10-02T05:30:00Z", "2026-10-01T10:00:00Z", "2026-09-30T10:00:00Z"],
  ])("a carried REGULAR label does not reopen a published %s holiday", (venue, symbol, now, close, olderClose) => {
    clock.mockReturnValue(Date.parse(now));
    const latest = createTestQuote({ symbol, listingExchangeName: venue, marketState: "REGULAR",
      dataSource: "delayed", lastUpdated: Date.parse(close) });
    const older = { ...latest, lastUpdated: Date.parse(olderClose) };
    expect(isQuoteStaleForCurrentSession(latest)).toBe(false);
    expect(isQuoteStaleForCurrentSession(older)).toBe(true);
    expect(isProviderQuoteUsableForCurrentSession(latest, venue)).toBe(true);
    expect(isProviderQuoteUsableForCurrentSession(older, venue)).toBe(false);
  });

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

  test("keeps today's regular close before any after-hours trade, however old, but not an older one", () => {
    // Friday 2026-10-09: the 15:51 print is the last one, and nothing has traded since the 16:00 close.
    const close = createTestQuote({ listingExchangeName: "NYSE", marketState: "POST", dataSource: "delayed",
      lastUpdated: Date.parse("2026-10-09T19:51:00Z") });
    for (const now of ["2026-10-09T20:06:00Z", "2026-10-09T21:30:00Z", "2026-10-09T23:30:00Z"]) {
      clock.mockReturnValue(Date.parse(now));
      expect(isProviderQuoteUsableForCurrentSession(close, "NYSE"), now).toBe(true);
      expect(isProviderQuoteUsableForCurrentSession({ ...close, marketState: "CLOSED" }, "NYSE"), now).toBe(true);
      // With an after-hours price the print's own age counts again: 15 minutes old at 16:06, then too old.
      expect(isProviderQuoteUsableForCurrentSession({ ...close, postMarketPrice: 101 }, "NYSE"), now).toBe(now === "2026-10-09T20:06:00Z");
      expect(isProviderQuoteUsableForCurrentSession({ ...close, marketState: "REGULAR" }, "NYSE"), now).toBe(false);
      expect(isProviderQuoteUsableForCurrentSession({ ...close, stale: true }, "NYSE"), now).toBe(false);
      // Yesterday's close and this morning's pre-market print are not today's.
      expect(isProviderQuoteUsableForCurrentSession({ ...close, lastUpdated: Date.parse("2026-10-08T19:51:00Z") }, "NYSE"), now).toBe(false);
      expect(isProviderQuoteUsableForCurrentSession({ ...close, lastUpdated: Date.parse("2026-10-09T12:00:00Z") }, "NYSE"), now).toBe(false);
    }
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

test("does not attach another observation's currency to merged free cash flow", () => {
  const valued = createTestFinancials({ fundamentals: { revenue: 450, financialCurrency: "CAD" } });
  const older = createTestFinancials({ fundamentals: { freeCashFlow: -70 } });
  expect(mergeFinancials(valued, older)?.fundamentals).toMatchObject({ freeCashFlow: -70, freeCashFlowCurrency: null });
  older.fundamentals!.freeCashFlowCurrency = "USD";
  expect(mergeFinancials(valued, older)?.fundamentals).toMatchObject({ freeCashFlow: -70, freeCashFlowCurrency: "USD" });
  valued.fundamentals!.freeCashFlow = -50;
  expect(mergeFinancials(valued, older)?.fundamentals).toMatchObject({ freeCashFlow: -50, freeCashFlowCurrency: "CAD" });
});

test("a TTM conversion stays with the currency it describes, from a cached snapshot or a fresh one", () => {
  const ttmConversion = { from: "EUR", rate: 1.12571, asOf: "2026-10-09", eps: "report_date" as const };
  const converted = createTestFinancials({ fundamentals: { financialCurrency: "USD", revenue: 54.63e9, ttmConversion } });
  // A quote-only refresh keeps the cached block's unit and its conversion.
  expect(mergeFinancials(createTestFinancials({ fundamentals: { beta: 0.94 } }), converted)?.fundamentals)
    .toMatchObject({ financialCurrency: "USD", ttmConversion });
  // A fresh block in its own currency, or one without a unit, does not inherit an older conversion.
  const sameUnit = createTestFinancials({ fundamentals: { financialCurrency: "USD", revenue: 55e9 } });
  expect(mergeFinancials(sameUnit, converted)?.fundamentals?.ttmConversion).toBeUndefined();
  const unlabelled = createTestFinancials({ fundamentals: { revenue: 55e9 } });
  expect(mergeFinancials(unlabelled, converted)?.fundamentals).not.toHaveProperty("ttmConversion");
});

test("an EPS currency stays with its block, and a P/E's EPS rate with that P/E", () => {
  // CCU: CLP amounts, USD EPS. LIN on XETRA: a EUR P/E on USD EPS.
  const ccu = createTestFinancials({ fundamentals: { financialCurrency: "CLP", epsCurrency: "USD", eps: 0.61, revenue: 2.91e12 } });
  expect(mergeFinancials(createTestFinancials({ fundamentals: { beta: 0.26 } }), ccu)?.fundamentals)
    .toMatchObject({ financialCurrency: "CLP", epsCurrency: "USD" });
  const unlabelled = createTestFinancials({ fundamentals: { eps: 0.6, revenue: 2.9e12 } });
  expect(mergeFinancials(unlabelled, ccu)?.fundamentals).not.toHaveProperty("epsCurrency");
  const trailingPEConversion = { from: "USD", rate: 0.8924 };
  const lin = createTestFinancials({ fundamentals: { financialCurrency: "USD", eps: 14.61, trailingPE: 33.16, trailingPEConversion } });
  expect(mergeFinancials(createTestFinancials({ fundamentals: { beta: 0.9 } }), lin)?.fundamentals)
    .toMatchObject({ trailingPE: 33.16, trailingPEConversion });
  const repriced = createTestFinancials({ fundamentals: { financialCurrency: "USD", eps: 14.61, trailingPE: 30 } });
  expect(mergeFinancials(repriced, lin)?.fundamentals).not.toHaveProperty("trailingPEConversion");
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

test("a block that read next year's consensus stands whole: a forecast loss or none never takes an older multiple", () => {
  const vendor = createTestFinancials({ fundamentals: { forwardPE: 1.67, revenue: 100 } });
  const none = createTestFinancials({ fundamentals: { forwardEpsPeriodEnd: null, eps: -329 } });
  const merged = mergeFinancials(none, vendor)?.fundamentals;
  expect(merged).toMatchObject({ forwardEpsPeriodEnd: null, revenue: 100 });
  expect(merged?.forwardPE).toBeUndefined();
  const loss = createTestFinancials({ fundamentals: { forwardEps: -4.19, forwardEpsPeriodEnd: "2026-12-31", forwardEpsCurrency: "USD" } });
  expect(mergeFinancials(loss, vendor)?.fundamentals).toMatchObject({ forwardEps: -4.19, forwardEpsPeriodEnd: "2026-12-31" });
  expect(mergeFinancials(loss, vendor)?.fundamentals?.forwardPE).toBeUndefined();
  // A refresh that read consensus replaces a cached one's year, figure and multiple together.
  const cached = createTestFinancials({ fundamentals: { forwardPE: 2.4, forwardEps: 2.08, forwardEpsPeriodEnd: "2027-12-31", forwardEpsCurrency: "USD" } });
  const refreshed = mergeRefreshedFinancials(cached, none).fundamentals;
  expect(refreshed).toMatchObject({ forwardEpsPeriodEnd: null });
  expect(refreshed?.forwardPE).toBeUndefined();
  expect(refreshed?.forwardEps).toBeUndefined();
});

// SMSN on the LSE: Gloom Cloud withholds a GDR's cap that was its price x Samsung's ordinaries (27.34T USD).
test("a withheld market cap stays withheld over an older cached one, until a fresh observation serves a cap", () => {
  const withheld = createTestFinancials({ fundamentals: {
    unavailableFields: ["marketCap", "enterpriseValue", "enterpriseToRevenue"], marketCapUnavailable: "receipt-priced-as-ordinary",
  } });
  const cached = createTestFinancials({ fundamentals: { marketCap: 27_342_862_889_112, marketCapCurrency: "USD", revenue: 100 } });
  for (const merged of [mergeFinancials(withheld, cached)?.fundamentals, mergeRefreshedFinancials(cached, withheld).fundamentals]) {
    expect(merged?.marketCap).toBeUndefined();
    expect(merged).toMatchObject({ marketCapUnavailable: "receipt-priced-as-ordinary", revenue: 100 });
  }
  // A fresh cap ends the withholding and its reason.
  const priced = mergeFinancials(createTestFinancials({ fundamentals: { marketCap: 995_900_000_000, marketCapCurrency: "USD" } }), withheld)
    ?.fundamentals;
  expect(priced).toMatchObject({ marketCap: 995_900_000_000 });
  expect(priced?.unavailableFields).not.toContain("marketCap");
  expect(priced?.marketCapUnavailable).toBeUndefined();
});
