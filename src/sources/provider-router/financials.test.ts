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
