import { describe, expect, test } from "bun:test";
import { formatCloudDateTime, mapCloudFinancials, mapQuote } from "./normalizers";
import type { CloudQuotePayload } from "../../api-client";
import { mergeQuoteContribution, normalizeQuoteContribution } from "../../market-data/quotes/contributions";
import { resolveTickerFinancialsQuoteState } from "../../market-data/quotes/resolution";

test("intraday boundaries use venue time or explicit UTC while daily dates stay UTC calendar dates", () => {
  const winter = new Date("2026-01-15T01:02:03.456Z");
  const summer = new Date("2026-07-15T01:02:03.456Z");
  for (const exchange of ["", "UNKNOWN"]) {
    expect(formatCloudDateTime(winter, true, exchange)).toBe("2026-01-15T01:02:03Z");
    expect(formatCloudDateTime(summer, true, exchange)).toBe("2026-07-15T01:02:03Z");
  }
  expect(formatCloudDateTime(winter, true, "NASDAQ")).toBe("2026-01-14 20:02:03");
  expect(formatCloudDateTime(summer, true, "NASDAQ")).toBe("2026-07-14 21:02:03");
  expect(formatCloudDateTime(summer, true, "CCC")).toBe("2026-07-15 01:02:03");
  expect(formatCloudDateTime(winter, false, "NASDAQ")).toBe("2026-01-15");
  expect(formatCloudDateTime(summer, false)).toBe("2026-07-15");
});

describe("cloud quote wire values", () => {
  test.each([null, undefined, Number.NaN, Infinity, -Infinity])(
    "normalizes unavailable daily changes independently, including %s",
    (missing) => {
      const quote: CloudQuotePayload = {
        symbol: "VOD", currency: "GBp", price: 100, lastUpdated: 1,
        providerId: "gloomberb-cloud", dataSource: "delayed",
        change: missing, changePercent: 0,
      };
      const withoutChange = mapQuote(quote);
      expect(withoutChange.change).toBeNaN();
      expect(withoutChange.changePercent).toBe(0);
      const withoutPercent = mapQuote({ ...quote, change: 2, changePercent: missing });
      expect(withoutPercent.change).toBe(0.02);
      expect(withoutPercent.changePercent).toBeNaN();
    },
  );
});

describe("mapCloudFinancials", () => {
  test("divides GBp history with the raw quote currency, not the normalized GBP quote", () => {
    const financials = mapCloudFinancials({
      quote: {
        providerId: "gloomberb-cloud",
        dataSource: "delayed",
        symbol: "VOD",
        price: 23.1,
        currency: "GBp",
        regularClose: 23,
        regularCloseSessionDate: "2026-05-12",
        change: 1,
        changePercent: 4.5,
        lastUpdated: Date.parse("2026-05-13T15:00:00Z"),
        listingExchangeName: "LSE",
        exchangeName: "LSE",
      },
      annualStatements: [],
      quarterlyStatements: [],
      priceHistory: [{
        date: "2026-05-13 10:15:00",
        open: 23,
        high: 23.4,
        low: 22.8,
        close: 23.1,
        volume: 1000,
      }],
    });

    expect(financials.quote?.currency).toBe("GBP");
    expect(financials.quote?.price).toBeCloseTo(0.231);
    expect(financials.quote?.regularClose).toBeCloseTo(0.23);
    expect(financials.quote?.regularCloseSessionDate).toBe("2026-05-12");
    expect(financials.priceHistory[0]?.close).toBeCloseTo(0.231);
    expect(financials.priceHistory[0]?.date.toISOString()).toBe("2026-05-13T09:15:00.000Z");
  });
});

test("a stream frame without the 52-week range or market cap keeps the snapshot's values", () => {
  const lastUpdated = Date.now();
  const snapshot = mapQuote({
    symbol: "AAPL", currency: "USD", price: 230, change: 1, changePercent: 0.4, lastUpdated: lastUpdated - 60_000,
    providerId: "gloomberb-cloud", dataSource: "live", high52w: 260, low52w: 160, marketCap: 3.4e12, name: "Apple Inc.",
    listingExchangeName: "NASDAQ", marketState: "REGULAR",
  });
  const frame = mapQuote({
    symbol: "AAPL", currency: "USD", price: 231, change: 2, changePercent: 0.9, lastUpdated,
    providerId: "gloomberb-cloud", dataSource: "live", listingExchangeName: "NASDAQ", marketState: "REGULAR",
  });
  expect("high52w" in frame).toBe(false);
  expect(Object.values(frame).includes(undefined)).toBe(false);

  const resolved = resolveTickerFinancialsQuoteState(
    { annualStatements: [], quarterlyStatements: [], priceHistory: [], quote: snapshot },
    frame,
  )?.quote;
  expect(resolved).toMatchObject({ price: 231, high52w: 260, low52w: 160, marketCap: 3.4e12, name: "Apple Inc." });

  // An explicit undefined from any source is not a retraction either.
  const merged = mergeQuoteContribution(
    normalizeQuoteContribution(snapshot),
    { ...frame, high52w: undefined, name: undefined },
  );
  expect(merged).toMatchObject({ high52w: 260, name: "Apple Inc." });
});
