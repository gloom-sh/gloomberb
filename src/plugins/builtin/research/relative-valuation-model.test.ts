import { MISSING_VALUE } from "../../../utils/format";
import { expect, test } from "bun:test";
import type { Quote, TickerFinancials } from "../../../types/financials";
import { fundamentalsBasisParts } from "./relative-valuation-basis";
import { formatRelativePrice, relativeValuationValues, withLiveQuote } from "./relative-valuation-model";

const snapshot: TickerFinancials = {
  annualStatements: [],
  quarterlyStatements: [],
  priceHistory: [],
  quote: { symbol: "PLD", price: 100, change: 1, changePercent: 1, currency: "USD", lastUpdated: 1_000, marketCap: 1_000 },
  fundamentals: { trailingPE: 20, forwardPE: 16, freeCashFlow: 50, financialCurrency: "USD" },
};

function live(overrides: Partial<Quote>): Quote {
  return { symbol: "PLD", price: 110, change: 11, changePercent: 11, currency: "USD", lastUpdated: 2_000, ...overrides };
}

test("a missing price currency stays blank, and an explicit code still prints", () => {
  expect(formatRelativePrice(10, null)).toBe("10.00");
  expect(formatRelativePrice(10, undefined)).toBe("10.00");
  expect(formatRelativePrice(10, "USD")).toBe("$10.00");
  expect(formatRelativePrice(10, "EUR")).toBe("€10.00");
  expect(formatRelativePrice(null, "USD")).toBe(MISSING_VALUE);
});

test("a live quote moves price-based values with the price and keeps the fundamentals", () => {
  const values = relativeValuationValues(withLiveQuote(snapshot, live({})));
  expect(values.price).toBe(110);
  expect(values.changePercent).toBe(11);
  expect(values.marketCap).toBeCloseTo(1_100);
  expect(values.fcfYield).toBeCloseTo(50 / 1_100);
  expect(values.reportedMultiples.trailingPE).toBeCloseTo(22);
  expect(values.reportedMultiples.forwardPE).toBeCloseTo(17.6);
});

test("a live after-hours print leaves Last and the price-derived values at the close and gets its own field", () => {
  // The live quote's price is the print, as Gloom Cloud sends it after the close, with the close beside it.
  const values = relativeValuationValues(withLiveQuote(snapshot, live({
    price: 112, change: 12, changePercent: 12, previousClose: 100, regularClose: 110, regularCloseSessionDate: "2026-10-09",
    regularChange: 10, regularChangePercent: 10, changeSessionDate: "2026-10-09", marketState: "POST", listingExchangeName: "NYSE",
  })));
  expect(values).toMatchObject({ price: 110, change: 10, changePercent: 10, extendedSession: "POST", extendedPrice: 112 });
  expect(values.extendedChangePercent).toBeCloseTo(200 / 110);
  expect(values.marketCap).toBeCloseTo(1_100);
  expect(values.reportedMultiples.trailingPE).toBeCloseTo(22);
  expect(values.fcfYield).toBeCloseTo(50 / 1_100);
});

test("an older, stale or differently priced quote leaves the snapshot alone", () => {
  for (const quote of [live({ lastUpdated: 500 }), live({ stale: true }), live({ currency: "EUR" })]) {
    expect(withLiveQuote(snapshot, quote)).toBe(snapshot);
  }
});

test("values measured at a stale price or from stale fundamentals do not scale", () => {
  const staleFundamentals = { ...snapshot, fundamentals: { ...snapshot.fundamentals!, stale: true } };
  const fromStaleFundamentals = relativeValuationValues(withLiveQuote(staleFundamentals, live({})));
  expect(fromStaleFundamentals.price).toBe(110);
  expect(fromStaleFundamentals.marketCap).toBeCloseTo(1_100);
  expect(fromStaleFundamentals.reportedMultiples.trailingPE).toBe(20);

  const staleQuote = {
    ...snapshot,
    quote: { ...snapshot.quote!, stale: true },
    fundamentals: { ...snapshot.fundamentals!, marketCap: 900, marketCapCurrency: "USD" },
  };
  const fromStaleQuote = relativeValuationValues(withLiveQuote(staleQuote, live({})));
  expect(fromStaleQuote.price).toBe(110);
  expect(fromStaleQuote.marketCap).toBe(900);
  expect(fromStaleQuote.reportedMultiples.trailingPE).toBe(20);
});

test("a margin the source did not serve for the trailing year falls back to the latest fiscal year and names it", () => {
  // CCL on 2026-10-25: the quarter ended 2026-08-31 was not in the statements yet, so no trailing margin was served.
  const carnival: TickerFinancials = {
    ...snapshot,
    annualStatements: [
      { date: "2024-11-30", totalRevenue: 25.02e9, operatingIncome: 3.57e9 },
      { date: "2025-11-30", totalRevenue: 26.62e9, operatingIncome: 4.48e9 },
    ],
  };
  const values = relativeValuationValues(carnival);
  expect(values.operatingMargin).toBeCloseTo(4.48 / 26.62);
  expect(values).toMatchObject({ operatingMarginPeriod: "FY25", operatingMarginPeriodEnd: "2025-11-30", gaps: {} });
  // A trailing margin, when served, is the figure and names no year.
  const trailing = relativeValuationValues({ ...carnival, fundamentals: { ...carnival.fundamentals, operatingMargin: 0.13 } });
  expect(trailing).toMatchObject({ operatingMargin: 0.13, operatingMarginPeriod: null, operatingMarginPeriodEnd: null });
  // The latest year without its operating income is a gap; an older year is not passed off for it.
  const gap = relativeValuationValues({ ...carnival, annualStatements: [carnival.annualStatements[0]!, { date: "2025-11-30", totalRevenue: 26.62e9 }] });
  expect(gap).toMatchObject({ operatingMargin: null, operatingMarginPeriod: null, gaps: { operatingMargin: "not reported" } });
});

// fn RV of Tokyo's trading houses on 9 Nov 2026 read EV/S "revenue ccy unstated" and "no TTM FCF" for
// Mitsubishi Corporation, whose statements are in yen with four quarters of free cash flow, and P/E 24.6 on its
// year to March 2026 as if trailing.
test("RV reads the statements' currency, the filed quarters' free cash flow, and names a P/E's fiscal year", () => {
  const quarter = (date: string, freeCashFlow?: number) => ({ date, currency: "JPY", totalRevenue: 5e12, ...(freeCashFlow !== undefined ? { freeCashFlow } : {}) });
  const mitsubishi: TickerFinancials = {
    annualStatements: [{ date: "2025-03-31", currency: "JPY", eps: 235.8 }, { date: "2026-03-31", currency: "JPY", eps: 209.78 }],
    quarterlyStatements: [quarter("2025-09-30", 235.935e9), quarter("2025-12-31", 6.692e9), quarter("2026-03-31", 864.825e9),
      quarter("2026-06-30", 338.676e9), quarter("2026-09-30")],
    priceHistory: [],
    financialCurrency: "JPY",
    quote: { symbol: "8058", price: 5170, change: 212, changePercent: 4.28, currency: "JPY", lastUpdated: Date.parse("2026-11-09T06:30:00Z"), marketCap: 18.93e12 },
    // The filed EPS of the year to March 2026, no quarter after it filed with one.
    fundamentals: { marketCap: 18.93e12, enterpriseValue: 23.82e12, revenue: 20.69e12, eps: 209.78, trailingPE: 24.64,
      trailingEpsSource: "filed-quarters", trailingEpsPeriodEnd: "2026-03-31" },
  };
  const values = relativeValuationValues(mitsubishi);
  expect(values.evSales).toBeCloseTo(23.82 / 20.69);
  // The four quarters to June that carry it; September's came with its income ahead of its cash flow.
  expect(values.fcfYield).toBeCloseTo(1.446128e12 / 18.93e12);
  // The P/E names its year in the one form valuation and the overview use; the footer says whose FCF is the filed quarters'.
  expect(values).toMatchObject({ fcfYieldThrough: "2026-06-30", trailingPEPeriod: "FY Mar-26", gaps: {} });
  const served = { ...values, symbol: "8031:JPX", fcfYieldThrough: null };
  expect(fundamentalsBasisParts([{ ...values, symbol: "8058:JPX" }], "Q REV%", "FCF%")).toContain("FCF%: filed quarters to 2026-06-30");
  expect(fundamentalsBasisParts([{ ...values, symbol: "8058:JPX" }, served], "Q REV%", "FCF%"))
    .toContain("FCF% of 8058:JPX: filed quarters to 2026-06-30");
  // Gloom Cloud's figure states no period: the same 209.78 served is not named a fiscal year by its value.
  const unstated = relativeValuationValues({ ...mitsubishi, fundamentals: { ...mitsubishi.fundamentals, trailingEpsSource: "served", trailingEpsPeriodEnd: undefined } });
  expect(unstated.trailingPEPeriod).toBeNull();
  // A quote in another currency than the statements' leaves both blank, saying why.
  const dollars = relativeValuationValues({ ...mitsubishi, quote: { ...mitsubishi.quote!, currency: "USD" }, fundamentals: { ...mitsubishi.fundamentals, marketCapCurrency: "USD" } });
  expect(dollars).toMatchObject({ evSales: null, fcfYield: null, gaps: { evSales: "revenue ccy unstated", fcfYield: "FCF in JPY" } });
});

// fn RV SMSN:LSE,SSNLF showed 27.34T USD for the GDR: its price x Samsung's ordinaries, from a stale quote's fallback.
test("a receipt cap Gloom Cloud withheld is no cap, from the quote or the fundamentals, and says why", () => {
  const receipt: TickerFinancials = {
    ...snapshot,
    quote: { symbol: "SMSN:LSE", price: 4298, change: 188, changePercent: 4.57, currency: "USD", lastUpdated: 1_000,
      stale: true, marketCap: 27_342_862_889_112 },
    fundamentals: { marketCap: 27_342_862_889_112, marketCapCurrency: "USD", sharesOutstanding: 5_792_563_304,
      unavailableFields: ["marketCap"], marketCapUnavailable: "receipt-priced-as-ordinary" },
  };
  for (const values of [relativeValuationValues(receipt), relativeValuationValues({ ...receipt, quote: { ...receipt.quote!, stale: false } })]) {
    expect(values.marketCap).toBeNull();
    expect(values.gaps.marketCap).toBe("receipt, no ratio");
    expect(values.marketCapWithheld).toBe("No market cap: a depositary receipt with no known ratio, whose source's cap is the receipt price x the company's ordinary shares.");
  }
});
