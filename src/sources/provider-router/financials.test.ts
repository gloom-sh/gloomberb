import { describe, expect, test } from "bun:test";
import {
  dropUnusableProviderQuote,
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
