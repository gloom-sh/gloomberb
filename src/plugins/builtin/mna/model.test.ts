import { expect, test } from "bun:test";
import type { MnaDeal } from "../../../api-client/mna";
import type { Quote } from "../../../types/financials";
import { dealSpread, expectedCloseDate, formatDealValue, formatPercentShort, stageLabel, termsLabel } from "./model";

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
    lastReported: "2026-09-17",
    stale: false,
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

test("a private deal nobody has reported on for months says so", () => {
  const quiet = deal({ target: { name: "Quiet Co", symbol: null, country: "US" }, stale: true, lastReported: "2025-11-04" });
  expect(stageLabel(quiet)).toBe("No news since Nov 2025");
});

test("a missing deal currency stays blank, and an explicit code still prints", () => {
  expect(formatDealValue(1.8e9, null)).toBe("1.8B");
  expect(formatDealValue(1.8e9, "")).toBe("1.8B");
  expect(formatDealValue(1.8e9, "USD")).toBe("$1.8B");
  expect(formatDealValue(1.8e9, "usd")).toBe("$1.8B");
  expect(formatDealValue(1.8e9, "EUR")).toBe("€1.8B");
  expect(formatDealValue(null, "USD")).toBe("--");
});

// Athabasca: each holder takes CAD 12.00 or 0.264 Cenovus, prorated. blueharbor: $12.70 and 1.0534 TowneBank for every share.
const athabasca = (election: boolean | undefined) => deal(
  { target: { name: "Athabasca Oil", symbol: "ATH.TO", country: "CA" }, acquirer: { name: "Cenovus Energy", symbol: "CVE.TO", country: "CA" }, expectedClose: "2026-12-31" },
  { consideration: "mixed", cashPerShare: 12, exchangeRatio: 0.264, ratioSymbol: "CVE.TO", currency: "CAD", election },
);
const blueharbor = (election: boolean | undefined) => deal(
  { target: { name: "blueharbor bank", symbol: "BLHK", country: "US" }, acquirer: { name: "TowneBank", symbol: "TOWN", country: "US" }, expectedClose: "2027-03-31" },
  { consideration: "mixed", cashPerShare: 12.7, exchangeRatio: 1.0534, ratioSymbol: "TOWN", election },
);

test("an election is priced at its cash leg, and legs paid together add up", () => {
  const ath = dealSpread(athabasca(true), quote("ATH.TO", 12.06, "CAD"), quote("CVE.TO", 46.54, "CAD"), NOW)!;
  expect(ath.offer).toBe(12);
  expect(formatPercentShort(ath.spread)).toBe("-0.50%");
  expect(ath.annualized).toBeNull();
  // The cash leg needs no quote for the shares.
  expect(dealSpread(athabasca(true), quote("ATH.TO", 11.8, "CAD"), null, NOW)!.offer).toBe(12);
  // Cash the quote cannot be compared with: the stock leg stands in.
  expect(dealSpread(athabasca(true), quote("ATH.TO", 12.06, "USD"), quote("CVE.TO", 46.54, "USD"), NOW)!.offer).toBeCloseTo(12.287, 3);

  const blhk = dealSpread(blueharbor(false), quote("BLHK", 49.5), quote("TOWN", 36.15), NOW)!;
  expect(blhk.offer).toBeCloseTo(50.78, 2);
  expect(formatPercentShort(blhk.spread)).toBe("2.6%");
  expect(blhk.annualized!).toBeCloseTo(0.0511, 3);
  expect(dealSpread(blueharbor(false), quote("BLHK", 49.5), null, NOW)).toBeNull();
});

test("a server without the election field keeps pricing both legs", () => {
  expect(dealSpread(blueharbor(undefined), quote("BLHK", 49.5), quote("TOWN", 36.15), NOW)!.offer).toBeCloseTo(50.78, 2);
  expect(dealSpread(athabasca(undefined), quote("ATH.TO", 12.06, "CAD"), quote("CVE.TO", 46.54, "CAD"), NOW)!.offer).toBeCloseTo(24.287, 3);
  expect(termsLabel(athabasca(undefined).terms)).toBe("CAD 12.00 + 0.264 CVE.TO");
});

test("terms read as what one share gets", () => {
  expect(termsLabel(deal().terms)).toBe("$10.50 cash");
  expect(termsLabel(blueharbor(false).terms)).toBe("$12.70 + 1.0534 TOWN");
  expect(termsLabel(athabasca(true).terms)).toBe("CAD 12.00 or 0.264 CVE.TO");
  expect(termsLabel(deal({}, { cvr: true, partial: true }).terms)).toBe("$10.50 cash + CVR, partial");
  expect(termsLabel(deal({}, { cashPerShare: null, currency: null, consideration: "undisclosed" }).terms)).toBe("--");
});
