import { describe, expect, test } from "bun:test";
import type { QuoteContributionMap } from "../../types/financials";
import {
  resolveCanonicalQuote,
  resolveTickerFinancialsQuoteState,
  upsertQuoteContributionMap,
} from "./resolution";
import { normalizeQuoteContribution } from "./contributions";

describe("quote-resolution", () => {
  test("resolves price, session, listing venue, and route from separate providers", () => {
    const now = Date.parse("2026-04-08T11:00:00Z");
    const contributions: QuoteContributionMap = {
      ibkr: {
        symbol: "AMD",
        providerId: "ibkr",
        dataSource: "live",
        price: 100,
        currency: "USD",
        change: 1,
        changePercent: 1,
        lastUpdated: Date.parse("2026-04-08T10:59:00Z"),
        listingExchangeName: "NASDAQ",
        routingExchangeName: "SMART",
        routingExchangeFullName: "SMART",
        sessionConfidence: "unknown",
      },
      "gloomberb-cloud": {
        symbol: "AMD",
        providerId: "gloomberb-cloud",
        dataSource: "delayed",
        price: 99.8,
        currency: "USD",
        change: 0.8,
        changePercent: 0.81,
        lastUpdated: Date.parse("2026-04-08T10:58:00Z"),
        listingExchangeName: "NASDAQ",
        listingExchangeFullName: "NASDAQ",
        sessionConfidence: "unknown",
      },
      yahoo: {
        symbol: "AMD",
        providerId: "yahoo",
        dataSource: "delayed",
        price: 99.7,
        currency: "USD",
        change: 0.7,
        changePercent: 0.7,
        lastUpdated: Date.parse("2026-04-08T10:57:00Z"),
        listingExchangeName: "NMS",
        listingExchangeFullName: "NASDAQ",
        marketState: "PRE",
        sessionConfidence: "derived",
        preMarketPrice: 101,
        preMarketChange: 2,
        preMarketChangePercent: 2.02,
      },
    };

    const quote = resolveCanonicalQuote(contributions, now).quote;

    expect(quote?.price).toBe(100);
    expect(quote?.providerId).toBe("ibkr");
    expect(quote?.marketState).toBe("PRE");
    expect(quote?.preMarketPrice).toBe(101);
    expect(quote?.listingExchangeName).toBe("NASDAQ");
    expect(quote?.routingExchangeName).toBe("SMART");
    expect(quote?.provenance?.price?.providerId).toBe("ibkr");
    expect(quote?.provenance?.session?.providerId).toBe("yahoo");
  });

  test("uses provider previous close with the live broker price for daily change", () => {
    const now = Date.parse("2026-07-06T14:05:00Z");
    const contributions: QuoteContributionMap = {
      ibkr: {
        symbol: "VICR",
        providerId: "ibkr",
        dataSource: "live",
        price: 299.8,
        currency: "USD",
        change: -80.3,
        changePercent: -21.12,
        previousClose: 380.1,
        lastUpdated: Date.parse("2026-07-06T14:04:58Z"),
        receivedAt: Date.parse("2026-07-06T14:04:59Z"),
        listingExchangeName: "NASDAQ",
        routingExchangeName: "SMART",
        sessionConfidence: "unknown",
      },
      yahoo: {
        symbol: "VICR",
        providerId: "yahoo",
        dataSource: "delayed",
        price: 299.74,
        currency: "USD",
        change: 16.79,
        changePercent: 5.93,
        previousClose: 282.95,
        lastUpdated: Date.parse("2026-07-06T14:04:00Z"),
        listingExchangeName: "NMS",
        marketState: "REGULAR",
        sessionConfidence: "derived",
      },
    };

    const quote = resolveCanonicalQuote(contributions, now).quote;

    expect(quote?.providerId).toBe("ibkr");
    expect(quote?.price).toBe(299.8);
    expect(quote?.previousClose).toBe(282.95);
    expect(quote?.change).toBeCloseTo(16.85, 10);
    expect(quote?.changePercent).toBeCloseTo((16.85 / 282.95) * 100, 10);
    expect(quote?.provenance?.price?.providerId).toBe("ibkr");
    expect(quote?.provenance?.fields?.previousClose?.providerId).toBe("yahoo");
  });

  test("prefers fresher/provider-ranked non-live price candidates", () => {
    const now = Date.parse("2026-07-07T11:25:00Z");
    const cases: Array<{
      contributions: QuoteContributionMap;
      expectedPrice: number;
      expectedProvider: string;
      expectedChangePercent?: number;
      expectedRoute?: string;
    }> = [
      {
        contributions: {
          ibkr: {
            symbol: "LPK",
            providerId: "ibkr",
            dataSource: "delayed",
            price: 17.75,
            currency: "EUR",
            change: -1.85,
            changePercent: -9.44,
            previousClose: 19.6,
            lastUpdated: Date.parse("2026-07-07T11:02:00Z"),
            receivedAt: Date.parse("2026-07-07T11:02:01Z"),
            listingExchangeName: "IBIS",
            routingExchangeName: "SMART",
            sessionConfidence: "unknown",
          },
          yahoo: {
            symbol: "LPK.DE",
            providerId: "yahoo",
            dataSource: "delayed",
            price: 17.85,
            currency: "EUR",
            change: -1.75,
            changePercent: -8.93,
            previousClose: 19.6,
            lastUpdated: Date.parse("2026-07-07T11:24:00Z"),
            listingExchangeName: "GER",
            marketState: "REGULAR",
            sessionConfidence: "derived",
          },
        },
        expectedProvider: "yahoo",
        expectedPrice: 17.85,
        expectedChangePercent: ((17.85 - 19.6) / 19.6) * 100,
        expectedRoute: "SMART",
      },
      {
        contributions: {
          "gloomberb-cloud": {
            symbol: "3HNX",
            providerId: "gloomberb-cloud",
            dataSource: "delayed",
            price: 5.81,
            currency: "GBP",
            change: -1.58,
            changePercent: -21.42,
            previousClose: 7.39,
            lastUpdated: Date.parse("2026-07-07T11:18:00Z"),
            listingExchangeName: "LSE",
            marketState: "REGULAR",
            sessionConfidence: "derived",
          },
          yahoo: {
            symbol: "3HNX.L",
            providerId: "yahoo",
            dataSource: "delayed",
            price: 5.9775,
            currency: "GBP",
            change: -1.4125,
            changePercent: -19.09,
            previousClose: 7.39,
            lastUpdated: Date.parse("2026-07-07T11:24:00Z"),
            listingExchangeName: "LSE",
            marketState: "REGULAR",
            sessionConfidence: "derived",
          },
        },
        expectedProvider: "yahoo",
        expectedPrice: 5.9775,
      },
    ];

    for (const scenario of cases) {
      const quote = resolveCanonicalQuote(scenario.contributions, now).quote;
      expect(quote?.providerId).toBe(scenario.expectedProvider);
      expect(quote?.price).toBe(scenario.expectedPrice);
      expect(quote?.provenance?.price?.providerId).toBe(scenario.expectedProvider);
      if (scenario.expectedChangePercent != null) {
        expect(quote?.changePercent).toBeCloseTo(scenario.expectedChangePercent, 10);
      }
      if (scenario.expectedRoute) {
        expect(quote?.routingExchangeName).toBe(scenario.expectedRoute);
      }
    }
  });

  test("prefers yahoo day reference fields over stale cloud previous close data", () => {
    const now = Date.parse("2026-07-06T15:45:00Z");
    const contributions: QuoteContributionMap = {
      "gloomberb-cloud": {
        symbol: "VICR",
        providerId: "gloomberb-cloud",
        dataSource: "delayed",
        price: 299.8,
        currency: "USD",
        change: -80.27,
        changePercent: -21.12,
        previousClose: 380.07,
        lastUpdated: Date.parse("2026-07-06T15:44:00Z"),
        listingExchangeName: "NASDAQ",
        marketState: "REGULAR",
        sessionConfidence: "derived",
      },
      yahoo: {
        symbol: "VICR",
        providerId: "yahoo",
        dataSource: "delayed",
        price: 297.9,
        currency: "USD",
        change: 14.95,
        changePercent: 5.28,
        previousClose: 282.95,
        lastUpdated: Date.parse("2026-07-06T15:41:00Z"),
        listingExchangeName: "NMS",
        marketState: "REGULAR",
        sessionConfidence: "derived",
      },
    };

    const quote = resolveCanonicalQuote(contributions, now).quote;

    expect(quote?.providerId).toBe("gloomberb-cloud");
    expect(quote?.price).toBe(299.8);
    expect(quote?.previousClose).toBe(282.95);
    expect(quote?.change).toBeCloseTo(16.85, 10);
    expect(quote?.changePercent).toBeCloseTo((16.85 / 282.95) * 100, 10);
    expect(quote?.provenance?.price?.providerId).toBe("gloomberb-cloud");
    expect(quote?.provenance?.fields?.previousClose?.providerId).toBe("yahoo");
  });

  test("prefers cloud session data over yahoo when confidence is tied", () => {
    const now = Date.parse("2026-04-08T11:00:00Z");
    const contributions: QuoteContributionMap = {
      "gloomberb-cloud": {
        symbol: "ELF",
        providerId: "gloomberb-cloud",
        dataSource: "delayed",
        price: 88,
        currency: "USD",
        change: 0,
        changePercent: 0,
        lastUpdated: Date.parse("2026-04-08T10:58:00Z"),
        listingExchangeName: "NYSE",
        marketState: "PRE",
        sessionConfidence: "derived",
        preMarketPrice: 89,
      },
      yahoo: {
        symbol: "ELF",
        providerId: "yahoo",
        dataSource: "delayed",
        price: 87.5,
        currency: "USD",
        change: 0,
        changePercent: 0,
        lastUpdated: Date.parse("2026-04-08T10:57:00Z"),
        listingExchangeName: "NYQ",
        marketState: "PRE",
        sessionConfidence: "derived",
        preMarketPrice: 87.8,
      },
    };

    const quote = resolveCanonicalQuote(contributions, now).quote;

    expect(quote?.marketState).toBe("PRE");
    expect(quote?.preMarketPrice).toBe(89);
    expect(quote?.provenance?.session?.providerId).toBe("gloomberb-cloud");
  });

  test("prefers yahoo extended-hours session data when cloud premarket lacks an active-session price", () => {
    const now = Date.parse("2026-04-08T11:00:00Z");
    const contributions: QuoteContributionMap = {
      "gloomberb-cloud": {
        symbol: "AMD",
        providerId: "gloomberb-cloud",
        dataSource: "delayed",
        price: 221.53,
        currency: "USD",
        change: 1.35,
        changePercent: 0.61,
        lastUpdated: Date.parse("2026-04-08T10:58:00Z"),
        listingExchangeName: "NASDAQ",
        marketState: "PRE",
        sessionConfidence: "derived",
      },
      yahoo: {
        symbol: "AMD",
        providerId: "yahoo",
        dataSource: "delayed",
        price: 221.53,
        currency: "USD",
        change: 1.35,
        changePercent: 0.61,
        lastUpdated: Date.parse("2026-04-08T10:57:00Z"),
        listingExchangeName: "NMS",
        marketState: "PRE",
        sessionConfidence: "derived",
        preMarketPrice: 231.7,
        preMarketChange: 10.17,
        preMarketChangePercent: 4.59,
      },
    };

    const quote = resolveCanonicalQuote(contributions, now).quote;

    expect(quote?.marketState).toBe("PRE");
    expect(quote?.preMarketPrice).toBe(231.7);
    expect(quote?.preMarketChangePercent).toBe(4.59);
    expect(quote?.provenance?.session?.providerId).toBe("yahoo");
    expect(quote?.provenance?.fields?.preMarketPrice?.providerId).toBe("yahoo");
  });

  test("does not fabricate delayed derived premarket prices from the regular last trade", () => {
    const quote = resolveTickerFinancialsQuoteState({
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
      quote: {
        symbol: "AMD",
        providerId: "gloomberb-cloud",
        dataSource: "delayed",
        price: 221.53,
        currency: "USD",
        change: 1.35,
        changePercent: 0.61,
        lastUpdated: 1,
        marketState: "PRE",
        sessionConfidence: "derived",
      },
    })?.quote;

    expect(quote?.marketState).toBe("PRE");
    expect(quote?.preMarketPrice).toBeUndefined();
    expect(quote?.preMarketChange).toBeUndefined();
    expect(quote?.preMarketChangePercent).toBeUndefined();
  });

  test("explicit session state does not turn a delayed or unclassified regular close into extended-hours trades", () => {
    for (const marketState of ["PRE", "POST"] as const) {
      for (const dataSource of ["delayed", undefined] as const) {
        const contribution = normalizeQuoteContribution({
          symbol: "ASML", providerId: "gloomberb-cloud", listingExchangeName: "AMS",
          price: 1472.8, currency: "EUR", previousClose: 1497.6,
          change: -24.8, changePercent: -1.65598,
          lastUpdated: Date.parse("2026-09-10T15:29:00Z"),
          marketState, sessionConfidence: "explicit", dataSource,
        })!;
        const canonical = resolveCanonicalQuote({ "gloomberb-cloud": contribution }, contribution.lastUpdated).quote;
        for (const quote of [contribution, canonical]) {
          expect(quote?.price).toBe(1472.8);
          expect(quote?.marketState).toBe(marketState);
          expect(quote?.preMarketPrice).toBeUndefined();
          expect(quote?.preMarketChange).toBeUndefined();
          expect(quote?.preMarketChangePercent).toBeUndefined();
          expect(quote?.postMarketPrice).toBeUndefined();
          expect(quote?.postMarketChange).toBeUndefined();
          expect(quote?.postMarketChangePercent).toBeUndefined();
        }
      }
    }
  });

  test("preserves reported delayed after-hours fields without filling missing changes from the daily move", () => {
    const base = {
      symbol: "ASML", providerId: "gloomberb-cloud", listingExchangeName: "AMS",
      price: 1472.8, currency: "EUR", previousClose: 1497.6,
      change: -24.8, changePercent: -1.65598, lastUpdated: Date.parse("2026-09-10T16:00:00Z"),
      marketState: "POST" as const, sessionConfidence: "explicit" as const, dataSource: "delayed" as const,
      postMarketPrice: 1475,
    };
    const priceOnly = normalizeQuoteContribution(base)!;
    expect(priceOnly.postMarketPrice).toBe(1475);
    expect(priceOnly.postMarketChange).toBeUndefined();
    expect(priceOnly.postMarketChangePercent).toBeUndefined();
    const reported = normalizeQuoteContribution({ ...base, postMarketChange: 2.2, postMarketChangePercent: 0.1494 })!;
    expect(resolveCanonicalQuote({ "gloomberb-cloud": reported }, reported.lastUpdated).quote).toMatchObject({
      postMarketPrice: 1475, postMarketChange: 2.2, postMarketChangePercent: 0.1494,
    });
  });

  test("ignores stale cloud price contributions when a fresh yahoo quote exists", () => {
    const now = Date.parse("2026-04-08T10:30:00Z");
    const contributions: QuoteContributionMap = {
      "gloomberb-cloud": {
        symbol: "HY9H",
        providerId: "gloomberb-cloud",
        dataSource: "delayed",
        price: 528,
        currency: "EUR",
        change: 4,
        changePercent: 0.76,
        lastUpdated: Date.parse("2026-04-07T17:55:00Z"),
        listingExchangeName: "FWB2",
        marketState: "REGULAR",
        sessionConfidence: "explicit",
      },
      yahoo: {
        symbol: "HY9H",
        providerId: "yahoo",
        dataSource: "delayed",
        price: 598,
        currency: "EUR",
        change: 6,
        changePercent: 1.01,
        lastUpdated: Date.parse("2026-04-08T10:25:00Z"),
        listingExchangeName: "FWB2",
        marketState: "REGULAR",
        sessionConfidence: "derived",
      },
    };

    const quote = resolveCanonicalQuote(contributions, now).quote;

    expect(quote?.price).toBe(598);
    expect(quote?.providerId).toBe("yahoo");
    expect(quote?.provenance?.price?.providerId).toBe("yahoo");
  });

  test("rejects an incoming stale cloud contribution when a fresh quote already exists", () => {
    const now = Date.parse("2026-04-08T10:30:00Z");
    const current: QuoteContributionMap = {
      yahoo: {
        symbol: "HY9H",
        providerId: "yahoo",
        dataSource: "delayed",
        price: 598,
        currency: "EUR",
        change: 6,
        changePercent: 1.01,
        lastUpdated: Date.parse("2026-04-08T10:25:00Z"),
        listingExchangeName: "FWB2",
        marketState: "REGULAR",
        sessionConfidence: "derived",
      },
    };

    const next = upsertQuoteContributionMap(current, {
      symbol: "HY9H",
      providerId: "gloomberb-cloud",
      dataSource: "delayed",
      price: 528,
      currency: "EUR",
      change: 4,
      changePercent: 0.76,
      lastUpdated: Date.parse("2026-04-07T17:55:00Z"),
      listingExchangeName: "FWB2",
      marketState: "REGULAR",
      sessionConfidence: "explicit",
    }, { now });

    expect(next).toEqual(current);
  });

  test("keeps broker-only SMART quotes as unknown session while preserving the route", () => {
    const financials = resolveTickerFinancialsQuoteState({
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [],
      quote: {
        symbol: "MU",
        providerId: "ibkr",
        dataSource: "live",
        price: 120,
        currency: "USD",
        change: 1,
        changePercent: 0.84,
        lastUpdated: 1,
        listingExchangeName: "NASDAQ",
        routingExchangeName: "SMART",
        sessionConfidence: "unknown",
      },
    });

    expect(financials?.quote?.listingExchangeName).toBe("NASDAQ");
    expect(financials?.quote?.routingExchangeName).toBe("SMART");
    expect(financials?.quote?.marketState).toBeUndefined();
    expect(financials?.quote?.provenance?.price?.providerId).toBe("ibkr");
  });
});
