import { describe, expect, test } from "bun:test";
import {
  dropUnusableProviderQuote,
  mergeFinancials,
  mergeMissingStatementArrays,
  isProviderQuoteUsableForCurrentSession,
} from "./financials";
import { makeFinancials, makeQuote } from "./test-support";

describe("provider-router financial quote usability", () => {
  test("rejects active-session labels without active-session prices", () => {
    expect(isProviderQuoteUsableForCurrentSession(makeQuote({
      listingExchangeName: "NASDAQ",
      marketState: "PRE",
      lastUpdated: Date.now(),
    }), "NASDAQ")).toBe(false);
  });

  test("rejects old active-session provider quotes", () => {
    expect(isProviderQuoteUsableForCurrentSession(makeQuote({
      listingExchangeName: "FWB2",
      marketState: "REGULAR",
      lastUpdated: Date.now() - 20 * 60_000,
    }), "FWB2")).toBe(false);
  });

  test("accepts a streamed 15-minute delayed quote during the active session", () => {
    expect(
      isProviderQuoteUsableForCurrentSession(
        makeQuote({
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
    expect(isProviderQuoteUsableForCurrentSession(makeQuote({
      dataSource: "delayed",
      listingExchangeName: "NASDAQ",
      marketState: "REGULAR",
      lastUpdated: Date.now() - 25 * 60_000,
    }), "NASDAQ")).toBe(true);
  });

  test("still rejects a delayed quote the provider stopped updating", () => {
    expect(isProviderQuoteUsableForCurrentSession(makeQuote({
      dataSource: "delayed",
      listingExchangeName: "NASDAQ",
      marketState: "REGULAR",
      lastUpdated: Date.now() - 35 * 60_000,
    }), "NASDAQ")).toBe(false);
  });

  test("keeps a closed Asian index that Yahoo still labels POST hours after the close", () => {
    expect(isProviderQuoteUsableForCurrentSession(makeQuote({
      symbol: "^N225",
      dataSource: "delayed",
      listingExchangeName: "OSAKA",
      marketState: "POST",
      lastUpdated: Date.now() - 6 * 60 * 60_000,
    }), "OSAKA")).toBe(true);
  });

  test("still ages out a US after-hours quote the provider stopped updating", () => {
    expect(isProviderQuoteUsableForCurrentSession(makeQuote({
      listingExchangeName: "NASDAQ",
      marketState: "POST",
      postMarketPrice: 101,
      lastUpdated: Date.now() - 15 * 60_000,
    }), "NASDAQ")).toBe(false);
  });

  test("rejects empty zero provider quotes", () => {
    expect(isProviderQuoteUsableForCurrentSession(makeQuote({
      price: 0,
      change: 0,
      changePercent: 0,
      listingExchangeName: "SFB",
      lastUpdated: Date.now(),
    }), "SFB")).toBe(false);
  });

  test("strips unusable quotes while preserving non-quote financials", () => {
    const value = dropUnusableProviderQuote(makeFinancials({
      profile: { sector: "Industrials" },
      quote: makeQuote({
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
  const primary = makeFinancials({ fundamentals: { financialCurrency: "USD", revenue: 100 } });
  const fallback = makeFinancials({ fundamentals: { financialCurrency: "TWD", revenue: 3000, freeCashFlow: 500 } });
  expect(mergeFinancials(primary, fallback)?.fundamentals).toEqual({ financialCurrency: "USD", revenue: 100 });
  primary.fundamentals!.financialCurrency = undefined;
  expect(mergeFinancials(primary, fallback)?.fundamentals?.financialCurrency).toBeUndefined();
});

test("fallback reporting currency does not label unknown primary statement units", () => {
  const primary = makeFinancials({ annualStatements: [{ date: "2025-12-31", totalRevenue: 100 }] });
  const fallback = makeFinancials({ financialCurrency: "TWD", annualStatements: [{ date: "2024-12-31", currency: "TWD", totalRevenue: 3000 }] });
  expect(mergeMissingStatementArrays(primary, fallback).financialCurrency).toBeUndefined();
  expect(mergeFinancials(primary, fallback)?.financialCurrency).toBeUndefined();
});

test("yield basis and source stay attached to the selected yield observation", () => {
  const forward = makeFinancials({ fundamentals: { dividendYield: 0.0399, dividendYieldBasis: "forward", dividendYieldSource: "yahoo" } });
  const trailing = makeFinancials({ fundamentals: { dividendYield: 0.03, dividendYieldBasis: "trailing", dividendYieldSource: "twelvedata", revenue: 100 } });
  expect(mergeFinancials(forward, trailing)?.fundamentals).toMatchObject({ dividendYield: 0.0399, dividendYieldBasis: "forward", dividendYieldSource: "yahoo", revenue: 100 });
  const unknown = makeFinancials({ fundamentals: { dividendYield: 0.16 } });
  expect(mergeFinancials(unknown, forward)?.fundamentals?.dividendYieldBasis).toBeUndefined();
  expect(mergeFinancials(unknown, forward)?.fundamentals?.dividendYieldSource).toBeUndefined();
  expect(mergeFinancials(makeFinancials({ fundamentals: { revenue: 200 } }), forward)?.fundamentals).toMatchObject({ dividendYield: 0.0399, dividendYieldBasis: "forward", dividendYieldSource: "yahoo" });
});
