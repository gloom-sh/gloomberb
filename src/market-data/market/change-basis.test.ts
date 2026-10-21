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
import { previousPublishedSession } from "./freshness";

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

test("a quote dated by when it was read, on a weekend or a holiday, holds the last session's move, from the session before", () => {
  // Read on Saturday 17 Oct with no session date: Friday's move, from Thursday's close.
  const saturday = Date.parse("2026-10-17T10:00:00Z");
  const aapl = createTestQuote({ symbol: "AAPL", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ", price: 251.5, change: -1.5,
    changePercent: -0.59, previousClose: 253, marketState: "CLOSED", lastUpdated: saturday });
  expect(quoteChangeBasis(aapl)).toEqual({ kind: "close", date: "2026-10-15", venue: "NASDAQ", closed: [] });
  expect(quotePreviousCloseDate(aapl)).toBe("2026-10-15");
  // A currency pair a source dates by the Saturday it was read.
  const eurusd = createTestQuote({ symbol: "EURUSD=X", instrumentType: "CURRENCY", listingExchangeName: "CCY", price: 1.16, change: 0.002,
    changePercent: 0.17, previousClose: 1.158, changeSessionDate: "2026-10-17", lastUpdated: saturday });
  expect(quoteChangeBasis(eurusd)).toEqual({ kind: "close", date: "2026-10-15" });
  // HKEX's Monday holiday: a quote read that day holds Friday's move, from Thursday.
  expect(previousPublishedSession("HKEX", "2026-10-19")).toEqual({ date: "2026-10-15", closed: [] });
  expect(previousPublishedSession("HKEX", "2026-10-20")).toEqual({ date: "2026-10-16", closed: ["2026-10-19"] });
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
    symbol: "KC=F", currency: "USX", instrumentType: "FUTURE", listingExchangeName: "ICE FUTURES", exchangeName: "ICE FUTURES",
    marketState: "PRE", price: 314.95, change: 2.55, changePercent: 0.82,
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

// ES=F on Tue 26 May 2026. CME Group set no trade date for Memorial Day:
// Globex traded Monday for Tuesday's trade date and settled nothing.
const es = (overrides: Partial<Quote> = {}) => createTestQuote({
  symbol: "ES=F", instrumentType: "FUTURE", listingExchangeName: "CME", exchangeName: "CME", price: 7420, change: 20, changePercent: 0.27,
  previousClose: 7400, changeSessionDate: "2026-05-26", marketState: "REGULAR", lastUpdated: Date.parse("2026-05-26T15:00:00Z"), ...overrides,
});
const esTerms = (date: string, price = 7400) => ({ settlement: { price, date }, spec: { tick: 0.25 } });

test("a future's move the Tuesday after Memorial Day is from Friday, the trade date before it on CME Group's calendar", () => {
  const settle = quoteChangeBasis(es(), { terms: esTerms("2026-05-22") });
  expect(settle).toEqual({ kind: "settle", date: "2026-05-22" });
  expect(changeBasisLabel(settle!, NOW)).toBe("vs Fri 22 May settle");
  // Tuesday settled: its own settlement cannot confirm the reference, which is Friday's close, not Monday's.
  const close = quoteChangeBasis(es(), { terms: esTerms("2026-05-26", 7418) });
  expect(close).toEqual({ kind: "close", date: "2026-05-22" });
  expect(changeBasisLabel(close!, NOW)).toBe("vs Fri 22 May close");
  expect(quotePreviousCloseDate(es())).toBe("2026-05-22");
  // Monday's abbreviated Globex session is booked on Tuesday's trade date: a move dated Monday is from Friday too.
  expect(quoteChangeBasis(es({ changeSessionDate: "2026-05-25" }))).toEqual({ kind: "close", date: "2026-05-22" });
});

test("ICE's softs did not trade Good Friday, so Monday's coffee move is from Thursday", () => {
  const kc = createTestQuote({
    symbol: "KC=F", currency: "USX", instrumentType: "FUTURE", listingExchangeName: "ICE FUTURES", exchangeName: "ICE FUTURES",
    price: 300, change: 3, changePercent: 1.01, previousClose: 297, changeSessionDate: "2026-04-06", marketState: "REGULAR",
    lastUpdated: Date.parse("2026-04-06T15:00:00Z"),
  });
  const thursday = { settlement: { price: 297, date: "2026-04-02" }, spec: { tick: 0.05 } };
  expect(quoteChangeBasis(kc, { terms: thursday })).toEqual({ kind: "settle", date: "2026-04-02" });
  expect(quoteChangeBasis({ ...kc, change: 3.5 }, { terms: thursday })).toEqual({ kind: "last trade", date: "2026-04-02" });
  expect(quoteChangeBasis(kc, { terms: { ...thursday, settlement: { price: 300.5, date: "2026-04-06" } } }))
    .toEqual({ kind: "close", date: "2026-04-02" });
  expect(quotePreviousCloseDate(kc)).toBe("2026-04-02");
  // CME settled its FX and rate contracts that Good Friday but not its equity index ones, so its calendar
  // cannot date ES=F's Monday: only a settlement the move matches is named.
  const monday = es({ changeSessionDate: "2026-04-06" });
  expect(quoteChangeBasis(monday, { terms: esTerms("2026-04-02") })).toEqual({ kind: "settle", date: "2026-04-02" });
  expect(quoteChangeBasis(monday)).toEqual({ kind: "previous close" });
});

test("a future on a venue without a published calendar keeps its previous close undated", () => {
  const vx = es({ symbol: "VX=F", listingExchangeName: "CFE", exchangeName: "CFE", price: 18.5, change: 0.5, previousClose: 18 });
  const terms = { settlement: { price: 18, date: "2026-05-22" }, spec: { tick: 0.05 } };
  // A settlement the move matches is dated by the terms, not by a calendar.
  expect(quoteChangeBasis(vx, { terms })).toEqual({ kind: "settle", date: "2026-05-22" });
  expect(quoteChangeBasis(vx, { terms: { ...terms, settlement: { price: 18.4, date: "2026-05-26" } } })).toEqual({ kind: "previous close" });
  expect(quoteChangeBasis(vx)).toEqual({ kind: "previous close" });
  expect(quotePreviousCloseDate(vx)).toBeNull();
});

test("an index quoted under its publisher names the venue whose days it trades in its holiday note", () => {
  const hsi = createTestQuote({
    symbol: "^HSI", currency: "HKD", instrumentType: "INDEX", listingExchangeName: "HKSE", exchangeName: "HKSE",
    price: 25_800, change: -150, changePercent: -0.58, previousClose: 25_950, changeSessionDate: "2026-10-20",
    marketState: "CLOSED", lastUpdated: Date.parse("2026-10-20T08:10:00Z"),
  });
  const basis = quoteChangeBasis(hsi);
  expect(basis).toEqual({ kind: "close", date: "2026-10-16", venue: "HKEX", closed: ["2026-10-19"] });
  expect(changeBasisNote(basis, NOW)).toBe("HKEX closed Mon 19 Oct, holiday");
  expect(quotePreviousCloseDate(hsi)).toBe("2026-10-16");
  const spx = { ...hsi, symbol: "^GSPC", listingExchangeName: "SNP", exchangeName: "SNP", changeSessionDate: "2026-11-27" };
  expect(changeBasisNote(quoteChangeBasis(spx), NOW)).toBe("NYSE closed Thu 26 Nov, holiday");
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
