import { expect, test } from "bun:test";
import type { MnaDeal } from "../../../api-client/mna";
import type { Quote } from "../../../types/financials";
import { dealSpread, expectedCloseDate, formatPercentShort, termsLabel } from "./model";

const NOW = Date.parse("2026-09-27T12:00:00Z");

function deal(overrides: Partial<MnaDeal> = {}, terms: Partial<MnaDeal["terms"]> = {}): MnaDeal {
  return {
    id: "d1",
    target: { name: "ACV Auctions Inc.", symbol: "ACVA", country: "US" },
    acquirer: { name: "Copart, Inc.", symbol: "CPRT", country: "US" },
    status: "pending",
    stage: "Tender offer",
    hostile: false,
    terms: { consideration: "cash", cashPerShare: 10.5, exchangeRatio: null, ratioSymbol: null, currency: "USD", cvr: false, partial: false, ...terms },
    value: 1.78e9,
    valueCurrency: "USD",
    valueUsd: 1.78e9,
    announced: "2026-09-10",
    expectedClose: "2026-10-15",
    closed: null,
    headline: "",
    updatedAt: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

const quote = (symbol: string, price: number, currency = "USD") => ({ symbol, price, currency } as Quote);

test("a cash deal's spread annualizes to the expected close", () => {
  const spread = dealSpread(deal(), quote("ACVA", 10.46), null, NOW)!;
  expect(spread.offer).toBe(10.5);
  expect(formatPercentShort(spread.spread)).toBe("0.38%");
  // 0.38% over 17.5 days
  expect(spread.annualized!).toBeCloseTo(0.0798, 3);
});

test("a stock deal prices the ratio at the paying listing", () => {
  const stock = deal({}, { consideration: "stock", cashPerShare: null, exchangeRatio: 1.5401, ratioSymbol: "INDV", currency: null });
  expect(dealSpread(stock, quote("SUPN", 42.66), quote("INDV", 35.82), NOW)!.offer).toBeCloseTo(55.166, 3);
  // No price for the paying listing, no spread.
  expect(dealSpread(stock, quote("SUPN", 42.66), null, NOW)).toBeNull();
});

test("an offer in pence compares with a London quote in pounds", () => {
  const uk = deal({ target: { name: "Capricorn Energy", symbol: "CNE.L", country: "GB" } }, { cashPerShare: 250, currency: "GBp" });
  expect(dealSpread(uk, quote("CNE.L", 2.45, "GBP"), null, NOW)!.offer).toBe(2.5);
  // Another currency is never compared as if it were the quote's.
  expect(dealSpread(uk, quote("CNE.L", 2.45, "EUR"), null, NOW)).toBeNull();
});

test("a partial offer or a negative spread has no annualized return", () => {
  expect(dealSpread(deal({}, { partial: true }), quote("ACVA", 10), null, NOW)!.annualized).toBeNull();
  const above = dealSpread(deal(), quote("ACVA", 11), null, NOW)!;
  expect(formatPercentShort(above.spread)).toBe("-4.5%");
  expect(above.annualized).toBeNull();
  // Talks and closed deals have no spread at all.
  expect(dealSpread(deal({ status: "completed" }), quote("ACVA", 10.46), null, NOW)).toBeNull();
});

test("an expected close reads as the last day of its period", () => {
  expect(expectedCloseDate("Q4 2026")?.toISOString().slice(0, 10)).toBe("2026-12-31");
  expect(expectedCloseDate("H1 2027")?.toISOString().slice(0, 10)).toBe("2027-06-30");
  expect(expectedCloseDate("2027")?.toISOString().slice(0, 10)).toBe("2027-12-31");
  expect(expectedCloseDate("2026-02-30")).toBeNull();
});

test("terms read as what one share gets", () => {
  expect(termsLabel(deal().terms)).toBe("$10.50 cash");
  expect(termsLabel(deal({}, { exchangeRatio: 0.5, ratioSymbol: "CPRT", consideration: "mixed" }).terms)).toBe("$10.50 + 0.5 CPRT");
  expect(termsLabel(deal({}, { cvr: true, partial: true }).terms)).toBe("$10.50 cash + CVR, partial");
  expect(termsLabel(deal({}, { cashPerShare: null, currency: null, consideration: "undisclosed" }).terms)).toBe("--");
});
