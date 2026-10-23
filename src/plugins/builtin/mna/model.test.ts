import { expect, test } from "bun:test";
import type { MnaDeal } from "../../../api-client/mna";
import type { Quote } from "../../../types/financials";
import { dealSpread, dealsSymbol, electionLeg, expectedCloseDate, formatDealValue, formatPercentShort, inQuoteCurrency, offerSeries, stageLabel, termsLabel } from "./model";

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

test("the offer line draws the leg the Offer is priced at", () => {
  const days = ["2026-09-09", "2026-09-10", "2026-09-11"];
  const closes = [
    { date: new Date("2026-09-10T00:00:00Z"), close: 45 },
    { date: new Date("2026-09-11T00:00:00Z"), close: 46.54 },
  ];
  const last = (points: Array<{ value: number }>) => points.at(-1)!.value;
  // Priced at the cash: a flat line at the cash, before the announcement nothing.
  const ath = athabasca(true);
  const cad = quote("ATH.TO", 12.06, "CAD");
  expect(electionLeg(ath.terms, cad)).toBe("cash");
  expect(offerSeries(ath, closes, days, "cash")).toEqual([{ day: "2026-09-10", value: 12 }, { day: "2026-09-11", value: 12 }]);
  // Cash the quote cannot be compared with: the line follows the stock leg alone, as the Offer does.
  const usd = quote("ATH.TO", 12.06, "USD");
  const cveUsd = quote("CVE.TO", 46.54, "USD");
  expect(electionLeg(ath.terms, usd)).toBe("stock");
  const stock = offerSeries(ath, closes, days, "stock", (close) => inQuoteCurrency(close, "USD", "USD"));
  expect(last(stock)).toBeCloseTo(dealSpread(ath, usd, cveUsd, NOW)!.offer, 6);
  // Legs paid together add up, every day.
  const blhk = blueharbor(false);
  expect(last(offerSeries(blhk, closes, days, null))).toBeCloseTo(12.7 + 1.0534 * 46.54, 6);
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

test("deals are asked for by the symbol they are filed under: the quote symbol abroad, the bare symbol in the US", () => {
  // A listing abroad goes by its venue's suffix, whichever way the key spells the venue.
  expect(dealsSymbol("ATH:TSX")).toBe("ATH.TO");
  expect(dealsSymbol("ATH:XTSE")).toBe("ATH.TO");
  expect(dealsSymbol("ath:tsx")).toBe("ATH.TO");
  expect(dealsSymbol("SHEL:LSE")).toBe("SHEL.L");
  expect(dealsSymbol("AIR:EPA")).toBe("AIR.PA");
  expect(dealsSymbol("9984:JPX")).toBe("9984.T");
  expect(dealsSymbol("CYBE:VENTURE")).toBe("CYBE.V");
  expect(dealsSymbol("BHP:ASX")).toBe("BHP.AX");
  // The saved venue stands in for a key with none.
  expect(dealsSymbol("ATH", "TSX")).toBe("ATH.TO");
  expect(dealsSymbol("ATH:TSX", "NASDAQ")).toBe("ATH.TO");
  // Already a quote symbol: left as it is.
  expect(dealsSymbol("ATH.TO")).toBe("ATH.TO");
  expect(dealsSymbol("ATH.TO", "TSX")).toBe("ATH.TO");
  expect(dealsSymbol("0700.HK")).toBe("0700.HK");
  // A US listing, with or without its venue, is the bare symbol, as before.
  expect(dealsSymbol("ATH")).toBe("ATH");
  expect(dealsSymbol("ATH:NYSE")).toBe("ATH");
  expect(dealsSymbol("AMD:XNAS", "NASDAQ")).toBe("AMD");
  expect(dealsSymbol("BRK.B", "NYSE")).toBe("BRK.B");
  expect(dealsSymbol("ACVA", "")).toBe("ACVA");
  // Order routing is not a listing.
  expect(dealsSymbol("ACVA", "SMART")).toBe("ACVA");
  // No ticker, no symbol.
  expect(dealsSymbol(null)).toBe("");
  expect(dealsSymbol("  ")).toBe("");
});
