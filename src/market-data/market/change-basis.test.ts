import { expect, test } from "bun:test";
import { createTestQuote } from "../../test-support/data-provider";
import type { Quote } from "../../types/financials";
import {
  changeBasisJson,
  changeBasisLabel,
  changeBasisNote,
  combinedChangeBasisLabel,
  quoteChangeBasis,
  quotePreviousCloseDate,
} from "./change-basis";

// Linear: GLO-1089. Wed 21 Oct 2026, 01:30 UTC.
const NOW = Date.parse("2026-10-21T01:30:00Z");

// 3042.HK as `quote` served it on Tue 20 Oct: HKEX was closed Mon 19 Oct for
// the Chung Yeung holiday, so the move ran from Fri 16 Oct's close.
const hk = createTestQuote({
  symbol: "3042.HK", currency: "HKD", instrumentType: "ETF", listingExchangeName: "HKEX", exchangeName: "HKEX",
  price: 9.88, change: -0.06, changePercent: -0.6, previousClose: 9.94, changeSessionDate: "2026-10-20",
  marketState: "CLOSED", lastUpdated: Date.parse("2026-10-20T08:08:00Z"),
});

const coin = (overrides: Partial<Quote> = {}) => createTestQuote({
  symbol: "BTC-USD", instrumentType: "CRYPTOCURRENCY", listingExchangeName: "CCC", exchangeName: "CCC",
  price: 82_750, change: -190, changePercent: -0.23, previousClose: 82_940, changeSessionDate: "2026-10-21",
  marketState: "REGULAR", lastUpdated: Date.parse("2026-10-21T01:21:00Z"), ...overrides,
});

test("a move skipping a venue holiday names the close it is from and the day the venue was shut", () => {
  const basis = quoteChangeBasis(hk);
  expect(basis).toEqual({ kind: "close", date: "2026-10-16", venue: "HKEX", closed: ["2026-10-19"] });
  expect(changeBasisLabel(basis!, NOW)).toBe("vs Fri 16 Oct close");
  expect(changeBasisNote(basis, NOW)).toBe("HKEX closed Mon 19 Oct, holiday");
  expect(quotePreviousCloseDate(hk)).toBe("2026-10-16");
  // The session after it is a plain day-to-day move, with nothing to note.
  const wednesday = { ...hk, changeSessionDate: "2026-10-21", lastUpdated: Date.parse("2026-10-21T02:00:00Z") };
  expect(quoteChangeBasis(wednesday)).toEqual({ kind: "close", date: "2026-10-20", venue: "HKEX", closed: [] });
  expect(changeBasisNote(quoteChangeBasis(wednesday), NOW)).toBeNull();
  // Several shut days read as a span; another year's close carries its year.
  expect(changeBasisNote({ kind: "close", date: "2026-02-11", venue: "TWSE", closed: ["2026-02-12", "2026-02-13", "2026-02-16"] }, NOW))
    .toBe("TWSE closed Thu 12 Feb to Mon 16 Feb, holidays");
  expect(changeBasisLabel({ kind: "close", date: "2025-12-31" }, NOW)).toBe("vs Wed 31 Dec 2025 close");
});

test("a venue without a published calendar keeps its previous close undated, never guessed", () => {
  const sap = { ...hk, symbol: "SAP.DE", listingExchangeName: "XETRA", exchangeName: "XETRA", currency: "EUR" };
  expect(quoteChangeBasis(sap)).toEqual({ kind: "previous close" });
  expect(changeBasisLabel({ kind: "previous close" })).toBe("vs prev close");
  expect(quotePreviousCloseDate(sap)).toBeNull();
});

test("a coin moves since 00:00 UTC unless Gloom Cloud says 24 hours, and a perpetual always over 24 hours", () => {
  expect(quoteChangeBasis(coin())).toEqual({ kind: "utc day" });
  expect(changeBasisLabel({ kind: "utc day" })).toBe("since 00:00 UTC");
  expect(quotePreviousCloseDate(coin())).toBe("2026-10-20");
  const day = coin({ changeBasis: "24h", previousClose: undefined });
  expect(quoteChangeBasis(day)).toEqual({ kind: "24h" });
  expect(changeBasisLabel({ kind: "24h" })).toBe("24h");
  expect(quotePreviousCloseDate(day)).toBeNull();
  // A coin with no move has no basis to state.
  expect(quoteChangeBasis(coin({ changeBasis: "none", change: Number.NaN, changePercent: Number.NaN }))).toBeNull();
  const perp = coin({ symbol: "BTC-PERP", listingExchangeName: "HYPERLIQUID", exchangeName: "HYPERLIQUID" });
  expect(quoteChangeBasis(perp)).toEqual({ kind: "24h" });
});

test("a future's move is from the settlement its terms name, dated by the session the headline holds", () => {
  // Monday 05:00 New York, nothing traded yet: the headline is Friday's close and Friday's move, from Thursday.
  const monday = createTestQuote({
    symbol: "KC=F", currency: "USX", instrumentType: "FUTURE", marketState: "PRE", price: 314.95, change: 2.55, changePercent: 0.82,
    regularClose: 314.95, regularChange: 2.55, regularChangePercent: 0.82, regularCloseSessionDate: "2026-10-16",
    changeSessionDate: "2026-10-19", previousClose: 314.95, lastUpdated: Date.parse("2026-10-16T17:30:00Z"),
  });
  const terms = { settlement: { price: 312.4, date: "2026-10-15" }, spec: { tick: 0.05 } };
  expect(quoteChangeBasis(monday, { terms })).toEqual({ kind: "settle", date: "2026-10-15" });
  expect(changeBasisLabel({ kind: "settle", date: "2026-10-15" }, NOW)).toBe("vs Thu 15 Oct settle");
  // Dated by the day ahead it would have read Friday's settlement or last trade.
  expect(quoteChangeBasis(monday, { terms: { ...terms, settlement: { price: 314.95, date: "2026-10-16" } } }))
    .toEqual({ kind: "close", date: "2026-10-15" });
  // Once Monday trades, its move is Monday's, from Friday's settlement.
  const trading = { ...monday, marketState: "REGULAR" as const, price: 316, change: 1.05, lastUpdated: Date.parse("2026-10-19T14:00:00Z") };
  expect(quoteChangeBasis(trading, { terms: { ...terms, settlement: { price: 314.95, date: "2026-10-16" } } }))
    .toEqual({ kind: "settle", date: "2026-10-16" });
});

test("a total over moves from different closes says so instead of naming one", () => {
  const us = { kind: "close" as const, date: "2026-10-19", venue: "NASDAQ", closed: [] };
  const hkex = { kind: "close" as const, date: "2026-10-16", venue: "HKEX", closed: ["2026-10-19"] };
  expect(combinedChangeBasisLabel([us, us, null], NOW)).toBe("vs Mon 19 Oct close");
  expect(combinedChangeBasisLabel([us, hkex], NOW)).toBe("vs mixed closes");
  expect(combinedChangeBasisLabel([us, { kind: "utc day" }], NOW)).toBe("vs mixed closes");
  expect(combinedChangeBasisLabel([null], NOW)).toBeNull();
});

test("--json gives the basis beside the move: kind, dated session, closures, label and note", () => {
  expect(changeBasisJson(quoteChangeBasis(hk), NOW)).toEqual({
    kind: "close", date: "2026-10-16", closed: ["2026-10-19"], label: "vs Fri 16 Oct close", note: "HKEX closed Mon 19 Oct, holiday",
  });
  expect(changeBasisJson({ kind: "utc day" }, NOW)).toEqual({ kind: "utc day", date: null, label: "since 00:00 UTC" });
  expect(changeBasisJson(null, NOW)).toBeNull();
});
