import { expect, test } from "bun:test";
import { createTestQuote } from "../../test-support/data-provider";
import type { Quote } from "../../types/financials";
import {
  changeBasisJson,
  changeBasisLabel,
  changeBasisNote,
  combinedChangeBasisLabel,
  dayMoveBasisLabel,
  futuresQuoteFromSettle,
  quoteChangeBasis,
  quotePreviousCloseDate,
  quoteSettleText,
} from "./change-basis";
import { isRegularSessionTime, nextRegularSessionOpen, previousPublishedSession } from "./freshness";

// Wed 21 Oct 2026, 01:30 UTC.
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

test("a split in the move's session is said beside the close it is measured from, as Gloom Cloud adjusted it", () => {
  // SOXX on Thu 5 Nov 2026, the first session of its 3-for-1 split: the source's close of 450.41 is 150.14 on the new basis.
  const soxx = createTestQuote({ symbol: "SOXX", instrumentType: "ETF", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ",
    price: 148.94, change: -1.2, changePercent: -0.8, previousClose: 150.14, changeSessionDate: "2026-11-05", marketState: "REGULAR",
    lastUpdated: Date.parse("2026-11-05T18:30:00Z"), sessionSplit: { exDate: "2026-11-05", priceFactor: 1 / 3, sourcePreviousClose: 450.41 } });
  const now = Date.parse("2026-11-05T19:00:00Z");
  const basis = quoteChangeBasis(soxx);
  expect(basis).toEqual({ kind: "close", date: "2026-11-04", venue: "NASDAQ", closed: [], split: { exDate: "2026-11-05", priceFactor: 1 / 3 } });
  expect(changeBasisLabel(basis!, now)).toBe("vs Wed 4 Nov close");
  expect(changeBasisNote(basis, now)).toBe("3-for-1 split Thu 5 Nov, close adjusted");
  // The day after, the move is a plain day's: the split is no longer the move's.
  const friday = { ...soxx, changeSessionDate: "2026-11-06", lastUpdated: Date.parse("2026-11-06T18:30:00Z") };
  expect(changeBasisNote(quoteChangeBasis(friday), now)).toBeNull();
  // A reverse split reads as one.
  expect(changeBasisNote({ ...basis!, split: { exDate: "2026-11-05", priceFactor: 10 } } as never, now))
    .toBe("1-for-10 reverse split Thu 5 Nov, close adjusted");
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
  // Undated, a pair's move is of the FX trading day of its print, which turns at 17:00 New York:
  // a print stamped 17:00:00 is that day's close, one after it the next day's.
  const undated = (lastUpdated: string) => ({ ...eurusd, changeSessionDate: undefined, lastUpdated: Date.parse(lastUpdated) });
  expect(quoteChangeBasis(undated("2026-10-15T20:59:00Z"))).toEqual({ kind: "close", date: "2026-10-14" });
  expect(quoteChangeBasis(undated("2026-10-15T21:00:00Z"))).toEqual({ kind: "close", date: "2026-10-14" });
  expect(quoteChangeBasis(undated("2026-10-15T21:00:01Z"))).toEqual({ kind: "close", date: "2026-10-15" });
  expect(quotePreviousCloseDate(undated("2026-10-16T20:59:00Z"))).toBe("2026-10-15");
  expect(quotePreviousCloseDate(undated("2026-10-16T21:00:00Z"))).toBe("2026-10-15");
  // A print made while FX is shut belongs to no trading day, so nothing dates its previous close.
  for (const shut of ["2026-10-16T21:00:01Z", "2026-10-17T10:00:00Z", "2026-10-18T21:00:00Z"]) {
    expect(quoteChangeBasis(undated(shut)), shut).toEqual({ kind: "previous close" });
    expect(quotePreviousCloseDate(undated(shut)), shut).toBeNull();
  }
  // HKEX's Monday holiday: a quote read that day holds Friday's move, from Thursday.
  expect(previousPublishedSession("HKEX", "2026-10-19")).toEqual({ date: "2026-10-15", closed: [] });
  expect(previousPublishedSession("HKEX", "2026-10-20")).toEqual({ date: "2026-10-16", closed: ["2026-10-19"] });
});

test("NSE's Sunday Muhurat session is a session: its move is from Friday's close, and it trades only its own hours", () => {
  // Sun 8 Nov 2026: INFY:NSE traded the Diwali Muhurat session, 14:20 to 15:30 IST, -0.83% from Fri 6 Nov's 1,181.40.
  const infy = createTestQuote({ symbol: "INFY", currency: "INR", listingExchangeName: "NSE", exchangeName: "NSE", price: 1171.6,
    change: -9.8, changePercent: -0.83, previousClose: 1181.4, changeSessionDate: "2026-11-08", marketState: "CLOSED",
    lastUpdated: Date.parse("2026-11-08T09:59:30Z") });
  const evening = Date.parse("2026-11-08T14:05:00Z");
  expect(quoteChangeBasis(infy)).toEqual({ kind: "close", date: "2026-11-06", venue: "NSE", closed: [] });
  expect(changeBasisLabel(quoteChangeBasis(infy)!, evening)).toBe("vs Fri 6 Nov close");
  // Monday's move is from the Muhurat session, BSE's too.
  expect(previousPublishedSession("BSE", "2026-11-09")).toEqual({ date: "2026-11-08", closed: [] });
  // Open from 14:20 IST (08:50 UTC) to the close with its auction, 16:00 IST; shut that morning and the Sunday after.
  expect(isRegularSessionTime("NSE", Date.parse("2026-11-08T05:00:00Z"))).toBe(false);
  expect(isRegularSessionTime("NSE", Date.parse("2026-11-08T09:00:00Z"))).toBe(true);
  expect(isRegularSessionTime("NSE", Date.parse("2026-11-08T10:31:00Z"))).toBe(false);
  expect(nextRegularSessionOpen("NSE", Date.parse("2026-11-07T10:00:00Z"))?.open).toBe(Date.parse("2026-11-08T08:50:00Z"));
  expect(isRegularSessionTime("NSE", Date.parse("2026-11-15T09:00:00Z"))).toBe(false);
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

test("VX1, quoted at Cboe's settlement, moves from the CFE session before it, as CL=F does", () => {
  // As Gloom Cloud quoted it on Sun 8 Nov 2026: Friday's 23.6945 settlement, made at 15:00 Chicago time.
  const vx = createTestQuote({
    symbol: "VX1", name: "VIX Futures 1st generic, now Nov 2026", instrumentType: "FUTURE", listingExchangeName: "CFE", exchangeName: "CFE",
    price: 23.6945, change: -0.841, changePercent: -3.43, previousClose: 24.5355, previousCloseDate: "2026-11-05",
    changeSessionDate: "2026-11-06", lastUpdated: Date.parse("2026-11-06T21:00:00Z"), priceBasis: "points",
  });
  const terms = { settlement: { price: 23.6945, date: "2026-11-06" }, spec: { tick: 0.05 }, deliveryMonth: "2026-11" };
  const basis = quoteChangeBasis(vx, { terms });
  expect(basis).toEqual({ kind: "settle", date: "2026-11-05" });
  expect(changeBasisLabel(basis!, NOW)).toBe("vs Thu 5 Nov settle");
  expect(quoteSettleText(vx, terms)).toBe("23.6945 (2026-11-06)");
  // CFE had no trade date on Thanksgiving: the Friday after moves from Wednesday.
  const friday = { ...vx, changeSessionDate: "2026-11-27", lastUpdated: Date.parse("2026-11-27T18:15:00Z") };
  expect(quoteChangeBasis(friday, { terms: { ...terms, settlement: { price: 23.6945, date: "2026-11-27" } } }))
    .toEqual({ kind: "settle", date: "2026-11-25" });
});

test("ICE's softs did not trade Good Friday, so Monday's coffee move is from Thursday", () => {
  const kc = createTestQuote({
    symbol: "KC=F", name: "Coffee May 26", currency: "USX", instrumentType: "FUTURE", listingExchangeName: "ICE FUTURES", exchangeName: "ICE FUTURES",
    price: 300, change: 3, changePercent: 1.01, previousClose: 297, changeSessionDate: "2026-04-06", marketState: "REGULAR",
    lastUpdated: Date.parse("2026-04-06T15:00:00Z"),
  });
  const thursday = { settlement: { price: 297, date: "2026-04-02" }, spec: { tick: 0.05 }, deliveryMonth: "2026-05" };
  expect(quoteChangeBasis(kc, { terms: thursday })).toEqual({ kind: "settle", date: "2026-04-02" });
  // A reference that is not Thursday's settlement of the same contract is measured again from it, and reads as it.
  expect(quoteChangeBasis({ ...kc, change: 3.5 }, { terms: thursday })).toEqual({ kind: "previous close" });
  expect(quoteChangeBasis(futuresQuoteFromSettle({ ...kc, change: 3.5 }, thursday), { terms: thursday })).toEqual({ kind: "settle", date: "2026-04-02" });
  // Terms of July while the quote prices May: the source's move stands, from no named session.
  const july = { ...thursday, deliveryMonth: "2026-07" };
  expect(futuresQuoteFromSettle({ ...kc, change: 3.5 }, july)).toEqual({ ...kc, change: 3.5 });
  expect(quoteChangeBasis({ ...kc, change: 3.5 }, { terms: july })).toEqual({ kind: "previous close" });
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
  // ICE Futures Europe has no calendar here: no listing Gloom Cloud quotes trades there.
  const brent = es({ symbol: "B=F", listingExchangeName: "ICE FUTURES EUROPE", exchangeName: "ICE FUTURES EUROPE", price: 18.5, change: 0.5, previousClose: 18 });
  const terms = { settlement: { price: 18, date: "2026-05-22" }, spec: { tick: 0.05 } };
  // A settlement the move matches is dated by the terms, not by a calendar.
  expect(quoteChangeBasis(brent, { terms })).toEqual({ kind: "settle", date: "2026-05-22" });
  expect(quoteChangeBasis(brent, { terms: { ...terms, settlement: { price: 18.4, date: "2026-05-26" } } })).toEqual({ kind: "previous close" });
  expect(quoteChangeBasis(brent)).toEqual({ kind: "previous close" });
  expect(quotePreviousCloseDate(brent)).toBeNull();
});

/** `quote HCI:JSE` in session on 30 Oct 2026 said "+0.59% vs prev close" where US and LSE rows named the day. */
test("a JSE move names its close from the venue's calendar, without daily closes, across the election-day closure", () => {
  const hci = createTestQuote({
    symbol: "HCI", currency: "ZAR", instrumentType: "EQUITY", listingExchangeName: "JSE", exchangeName: "JSE",
    price: 172, change: 1, changePercent: 0.59, previousClose: 171, changeSessionDate: "2026-10-30",
    marketState: "REGULAR", lastUpdated: Date.parse("2026-10-30T10:00:00Z"),
  });
  expect(changeBasisLabel(quoteChangeBasis(hci)!, NOW)).toBe("vs Thu 29 Oct close");
  // Wed 4 Nov is South Africa's local government election day, a public holiday the JSE closes for.
  const thursday = { ...hci, changeSessionDate: "2026-11-05", lastUpdated: Date.parse("2026-11-05T10:00:00Z") };
  const basis = quoteChangeBasis(thursday);
  expect(basis).toEqual({ kind: "close", date: "2026-11-03", venue: "JSE", closed: ["2026-11-04"] });
  expect(changeBasisLabel(basis!, NOW)).toBe("vs Tue 3 Nov close");
  expect(changeBasisNote(basis, NOW)).toBe("JSE closed Wed 4 Nov, holiday");
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

test("an index quote naming no session is dated by the session of its home venue its last print sits in", () => {
  // Sun 8 Nov 2026: the S&P 500's closing print at 16:37 New York and the Nikkei's at 15:45 Tokyo, both on Fri 6 Nov.
  const now = Date.parse("2026-11-08T09:38:00Z");
  const index = (symbol: string, venue: string, at: string) => createTestQuote({
    symbol, instrumentType: "INDEX", listingExchangeName: venue, exchangeName: venue, price: 100, change: 1, changePercent: 1,
    previousClose: 99, marketState: "CLOSED", lastUpdated: Date.parse(at),
  });
  const label = (quote: Quote) => changeBasisLabel(quoteChangeBasis(quote)!, now);
  expect(label(index("^GSPC", "SNP", "2026-11-06T21:37:09Z"))).toBe("vs Thu 5 Nov close");
  expect(label(index("^IXIC", "NASDAQ GIDS", "2026-11-06T22:15:59Z"))).toBe("vs Thu 5 Nov close");
  expect(label(index("^N225", "OSAKA", "2026-11-06T06:45:02Z"))).toBe("vs Thu 5 Nov close");
  // A print before the day's open, on a day the venue has no session, or from a venue with no published calendar, names none.
  expect(label(index("^GSPC", "SNP", "2026-11-06T12:00:00Z"))).toBe("vs prev close");
  expect(label(index("^GSPC", "SNP", "2026-11-07T15:00:00Z"))).toBe("vs prev close");
  expect(label(index("^FTSE", "FTSE", "2026-11-06T16:35:00Z"))).toBe("vs prev close");
});

test("a Cboe yield index is never dated by its venue's equity calendar: NYSE trades through Veterans Day, the bond market does not", () => {
  // Thu 12 Nov 2026: the 10-year yield moves from Tue 10 Nov's close; Wed 11 Nov was a bond holiday.
  const now = Date.parse("2026-11-12T22:00:00Z");
  const tnx = createTestQuote({ symbol: "^TNX", instrumentType: "INDEX", listingExchangeName: "CBOE INDICES", exchangeName: "CBOE INDICES",
    price: 4.1, change: 0.03, changePercent: 0.74, previousClose: 4.07, marketState: "CLOSED", lastUpdated: Date.parse("2026-11-12T20:59:00Z") });
  const label = (quote: Quote) => changeBasisLabel(quoteChangeBasis(quote)!, now);
  // Neither its print nor its session names the day before; its own dated close does.
  expect(label(tnx)).toBe("vs prev close");
  expect(label({ ...tnx, changeSessionDate: "2026-11-12" })).toBe("vs prev close");
  expect(label({ ...tnx, changeSessionDate: "2026-11-12", previousCloseDate: "2026-11-10" })).toBe("vs Tue 10 Nov close");
  // ^VIX trades Cboe's equity days, Wednesday among them.
  expect(label({ ...tnx, symbol: "^VIX", changeSessionDate: "2026-11-12" })).toBe("vs Wed 11 Nov close");
});

test("a total over moves from different closes says so instead of naming one", () => {
  const us = { kind: "close" as const, date: "2026-10-19", venue: "NASDAQ", closed: [] };
  const hkex = { kind: "close" as const, date: "2026-10-16", venue: "HKEX", closed: ["2026-10-19"] };
  expect(combinedChangeBasisLabel([us, us, null], NOW)).toBe("vs Mon 19 Oct close");
  expect(combinedChangeBasisLabel([us, hkex], NOW)).toBe("vs mixed closes");
  expect(combinedChangeBasisLabel([us, { kind: "utc day" }], NOW)).toBe("vs mixed closes");
  expect(combinedChangeBasisLabel([null], NOW)).toBeNull();
});

test("a day's move priced at extended-hours prints names their session before the close it is from", () => {
  const us = { kind: "close" as const, date: "2026-10-19", venue: "NASDAQ", closed: [] };
  const hkex = { kind: "close" as const, date: "2026-10-16", venue: "HKEX", closed: ["2026-10-19"] };
  expect(dayMoveBasisLabel([us, us], ["POST", null], { now: NOW })).toBe("after hours vs Mon 19 Oct close");
  expect(dayMoveBasisLabel([us, us], ["POST", null], { marks: true, now: NOW })).toBe("AH vs Mon 19 Oct close");
  expect(dayMoveBasisLabel([us], ["PRE"], { marks: true, now: NOW })).toBe("PM vs Mon 19 Oct close");
  expect(dayMoveBasisLabel([us, hkex], ["PRE"], { now: NOW })).toBe("pre-market vs mixed closes");
  expect(dayMoveBasisLabel([us, us], ["PRE", "OVERNIGHT"], { marks: true, now: NOW })).toBe("EXT vs Mon 19 Oct close");
  expect(dayMoveBasisLabel([us, us], ["PRE", "OVERNIGHT"], { now: NOW })).toBe("extended hours vs Mon 19 Oct close");
  // Regular-session prices name the close alone; no basis, no label.
  expect(dayMoveBasisLabel([us, hkex], [null, undefined], { now: NOW })).toBe("vs mixed closes");
  expect(dayMoveBasisLabel([null], ["POST"], { now: NOW })).toBeNull();
});

test("--json gives the basis beside the move: kind, dated session, closures, label and note", () => {
  expect(changeBasisJson(quoteChangeBasis(hk), NOW)).toEqual({
    kind: "close", date: "2026-10-16", closed: ["2026-10-19"], label: "vs Fri 16 Oct close", note: "HKEX closed Mon 19 Oct, holiday",
  });
  expect(changeBasisJson({ kind: "utc day" }, NOW)).toEqual({ kind: "utc day", date: null, label: "since 00:00 UTC" });
  expect(changeBasisJson(null, NOW)).toBeNull();
});

test("after the CME reopen the move is the source's, from the close of the session that has not settled yet, never two sessions", () => {
  // ES=F on Wed 4 Nov 2026 at 23:18 UTC, eighteen minutes after Globex reopened for Thursday's trade date. Tuesday
  // settled at 7,596.75; Wednesday's 7,720.50 close is not confirmed as its settlement until overnight.
  const terms = { settlement: { price: 7596.75, date: "2026-11-03" }, spec: { tick: 0.25 }, deliveryMonth: "2026-12" };
  const reopen = (changeSessionDate: string, previousCloseDate: string) => createTestQuote({
    symbol: "ES=F", name: "E-Mini S&P 500 Dec 26", instrumentType: "FUTURE", listingExchangeName: "CME", exchangeName: "CME", marketState: "REGULAR",
    price: 7734.5, change: 14, changePercent: 0.18, previousClose: 7720.5, previousCloseDate, changeSessionDate,
    lastUpdated: Date.parse("2026-11-04T23:18:00Z"),
  });
  // The source still dates the move Wednesday's (it read "vs Tue 3 Nov last trade"), then Thursday's.
  for (const quote of [reopen("2026-11-04", "2026-11-03"), reopen("2026-11-05", "2026-11-04")]) {
    expect(futuresQuoteFromSettle(quote, terms)).toBe(quote);
    const basis = quoteChangeBasis(quote, { terms })!;
    expect(changeBasisLabel(basis, NOW)).toBe("vs Wed 4 Nov close");
    expect(quotePreviousCloseDate(quote)).toBe("2026-11-04");
  }
  // Once Wednesday's settlement is confirmed the source's move matches it and stands.
  const confirmed = { ...terms, settlement: { price: 7720.5, date: "2026-11-04" } };
  const quote = reopen("2026-11-05", "2026-11-04");
  expect(futuresQuoteFromSettle(quote, confirmed)).toBe(quote);
  expect(quoteChangeBasis(quote, { terms: confirmed })).toEqual({ kind: "settle", date: "2026-11-04" });
  // Confirmed at another price while the source still measures from the close: measured again from the settlement.
  const other = { ...terms, settlement: { price: 7722.25, date: "2026-11-04" } };
  const remeasured = futuresQuoteFromSettle(quote, other);
  expect(remeasured).toMatchObject({ change: 12.25, previousClose: 7722.25, previousCloseDate: "2026-11-04" });
  expect(changeBasisLabel(quoteChangeBasis(remeasured, { terms: other })!, NOW)).toBe("vs Wed 4 Nov settle");
  expect(quotePreviousCloseDate(remeasured)).toBe("2026-11-04");
});
