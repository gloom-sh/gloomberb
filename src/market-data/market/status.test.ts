import { describe, expect, test } from "bun:test";
import type { Quote } from "../../types/financials";
import { sessionQuotes } from "../../test-support/test-fixture-session-quotes";
import {
  extendedSessionLineLabel,
  getActiveQuoteDisplay,
  getCompletedRegularSessionDisplay,
  getExtendedSessionDisplay,
  getRegularSessionDisplay,
  getSessionMoveDisplay,
  getTradedSessionMoveDisplay,
  marketStateCountdown,
  quoteDotMarketState,
  quoteHeadlineTime,
  quoteMarketStateLabel,
  quoteSessionColor,
  quoteSessionLabel,
} from "./status";
import { colors } from "../../theme/colors";

describe("marketStateCountdown", () => {
  test("adds precision as the US session boundary approaches", () => {
    expect(marketStateCountdown("PRE", Date.parse("2026-08-18T12:21:42Z"))).toBe("1h 9m");
    expect(marketStateCountdown("PRE", Date.parse("2026-08-18T13:25:09Z"))).toBe("4m 51s");
    expect(marketStateCountdown("REGULAR", Date.parse("2026-08-18T18:59:59Z"))).toBeNull();
    expect(marketStateCountdown("REGULAR", Date.parse("2026-08-18T19:00:00Z"))).toBe("1h");
    expect(marketStateCountdown("REGULAR", Date.parse("2026-08-18T19:50:42Z"))).toBe("9m 18s");
  });
});


test("active after-hours price keeps daily change against previous close, including a regular-only primary quote", () => {
  const quote = { symbol: "NVDA", currency: "USD", price: 218.36, change: -5.31, changePercent: -2.374,
    previousClose: 223.67, marketState: "POST" as const, postMarketPrice: 218.47,
    postMarketChange: 0.11, postMarketChangePercent: 0.0503755266532, lastUpdated: 1789072245412 };
  const active = getActiveQuoteDisplay(quote)!;
  expect(active.price).toBe(218.47);
  expect(active.change).toBeCloseTo(-5.2, 8);
  expect(active.changePercent).toBeCloseTo(-2.324853578933245, 8);
  for (const previousClose of [undefined, 0, Number.NaN]) {
    expect(getActiveQuoteDisplay({ ...quote, previousClose })).toEqual({ price: 218.47, change: undefined, changePercent: undefined });
  }
});

describe("regular and extended session displays", () => {
  // SPCX on 2026-10-08 at 22:22Z: the quote's price and change are the after-hours print against the day before's close.
  const afterHours: Quote = {
    symbol: "SPCX", currency: "USD", price: 165.14, change: -2.46, changePercent: -1.4678,
    previousClose: 167.6, regularClose: 160.57, regularCloseSessionDate: "2026-10-08", changeSessionDate: "2026-10-08",
    marketState: "POST", postMarketPrice: 165.14, postMarketChange: 4.57, postMarketChangePercent: 2.846,
    listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-08T22:22:00Z"),
  };
  // After 20:00 New York the after-hours fields are gone; the last print and the regular close stay.
  const overnight: Quote = {
    ...afterHours, marketState: "POSTPOST", price: 164.35, change: -3.25, changePercent: -1.939,
    postMarketPrice: undefined, postMarketChange: undefined, postMarketChangePercent: undefined,
    lastUpdated: Date.parse("2026-10-08T23:59:55Z"),
  };

  test("after the close the headline is the regular session and the extended line is the print against its close", () => {
    const regular = getRegularSessionDisplay(afterHours)!;
    expect(regular.price).toBe(160.57);
    expect(regular.change).toBeCloseTo(-7.03, 8);
    expect(regular.changePercent).toBeCloseTo(-4.1945, 3);
    const extended = getExtendedSessionDisplay(afterHours)!;
    expect(extended.session).toBe("POST");
    expect(extended.price).toBe(165.14);
    expect(extended.change).toBeCloseTo(4.57, 8);
    expect(extended.changePercent).toBeCloseTo(2.846, 3);
    expect(getSessionMoveDisplay(afterHours)).toEqual(extended);

    for (const state of ["POSTPOST", "PREPRE", "CLOSED"] as const) {
      const quote = { ...overnight, marketState: state };
      expect(getRegularSessionDisplay(quote)!.price).toBe(160.57);
      expect(getRegularSessionDisplay(quote)!.changePercent).toBeCloseTo(-4.1945, 3);
      expect(getExtendedSessionDisplay(quote)).toMatchObject({ session: "POST", price: 164.35 });
      expect(getExtendedSessionDisplay(quote)!.change).toBeCloseTo(3.78, 8);
      // Outside an open extended session a board colors by the regular session.
      expect(getSessionMoveDisplay(quote)!.price).toBe(160.57);
    }
    // Nothing traded after the close: no extended line once the session is over.
    expect(getExtendedSessionDisplay({ ...overnight, price: 160.57 })).toBeNull();
  });

  test("a close from another session, or none, leaves the live quote as the headline", () => {
    const olderClose = { ...overnight, regularCloseSessionDate: "2026-10-07" };
    expect(getRegularSessionDisplay(olderClose)).toEqual({ price: 164.35, change: -3.25, changePercent: -1.939 });
    expect(getExtendedSessionDisplay(olderClose)).toBeNull();

    // A non-US close carries no regular close.
    const closed: Quote = { symbol: "7203.T", currency: "JPY", price: 2800, change: 12, changePercent: 0.43,
      previousClose: 2788, marketState: "CLOSED", listingExchangeName: "JPX", lastUpdated: Date.parse("2026-10-08T06:30:00Z") };
    expect(getRegularSessionDisplay(closed)).toEqual({ price: 2800, change: 12, changePercent: 0.43 });
    expect(getExtendedSessionDisplay(closed)).toBeNull();
  });

  test("after hours without a reported close takes it from the after-hours move", () => {
    // A primary quote that stops at the regular close and reports the after-hours print beside it.
    const derived = { ...afterHours, regularClose: undefined, regularCloseSessionDate: undefined,
      price: 218.36, change: -5.31, changePercent: -2.374, previousClose: 223.67,
      postMarketPrice: 218.47, postMarketChange: 0.11, postMarketChangePercent: 0.0504 };
    expect(getRegularSessionDisplay(derived)!.price).toBeCloseTo(218.36, 8);
    expect(getRegularSessionDisplay(derived)!.change).toBeCloseTo(-5.31, 8);
    expect(getExtendedSessionDisplay(derived)!.change).toBeCloseTo(0.11, 8);

    // Without either, the headline stays the live quote and the after-hours line shows what the source sent.
    const bare = { ...derived, price: 218.47, change: -5.2, changePercent: -2.325, postMarketChange: undefined, postMarketChangePercent: undefined };
    expect(getRegularSessionDisplay(bare)).toEqual({ price: 218.47, change: -5.2, changePercent: -2.325 });
    expect(getExtendedSessionDisplay(bare)).toEqual({ session: "POST", price: 218.47, change: undefined, changePercent: undefined });
  });

  test("in the pre-market with the last session's close and move, the headline holds them and only the pre-market line moves", () => {
    // SPCX on 2026-10-09 at 12:01Z: the quote's own change is the pre-market print against Thursday's close.
    const pre: Quote = { symbol: "SPCX", currency: "USD", price: 166.95, change: 6.38, changePercent: 3.9733,
      previousClose: 160.57, regularClose: 160.57, regularCloseSessionDate: "2026-10-08",
      regularChange: -7.03, regularChangePercent: -4.1945, changeSessionDate: "2026-10-09", marketState: "PRE",
      preMarketPrice: 166.95, preMarketChange: 6.38, preMarketChangePercent: 3.9733,
      listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-09T12:01:00Z") };
    const headline = { price: 160.57, change: -7.03, changePercent: -4.1945 };
    expect(getRegularSessionDisplay(pre)).toEqual(headline);
    expect(getCompletedRegularSessionDisplay(pre)).toEqual(headline);
    expect(getExtendedSessionDisplay(pre)).toMatchObject({ session: "PRE", price: 166.95 });
    expect(getExtendedSessionDisplay(pre)!.change).toBeCloseTo(6.38, 8);
    expect(getExtendedSessionDisplay(pre)!.changePercent).toBeCloseTo(3.9733, 3);

    // The next pre-market print moves the pre-market line, measured from the same close, and nothing else.
    const later = { ...pre, price: 158, change: -2.57, changePercent: -1.6, preMarketPrice: 158, preMarketChange: undefined, preMarketChangePercent: undefined };
    expect(getRegularSessionDisplay(later)).toEqual(headline);
    expect(getExtendedSessionDisplay(later)!.change).toBeCloseTo(-2.57, 8);
    expect(getExtendedSessionDisplay(later)!.changePercent).toBeCloseTo(-1.6006, 3);
    // A board colors a name that has printed by that print, and one that has not by the last session.
    expect(getSessionMoveDisplay(pre)).toMatchObject({ session: "PRE", price: 166.95 });
    const noTrade = { ...pre, price: 160.57, change: 0, changePercent: 0, preMarketPrice: undefined, preMarketChange: undefined, preMarketChangePercent: undefined };
    expect(getSessionMoveDisplay(noTrade)).toEqual(headline);

    // Without the move, from an older server, or with a close that is not an earlier session, nothing changes.
    const live = { price: 166.95, change: 6.38, changePercent: 3.9733 };
    for (const quote of [
      { ...pre, regularChange: undefined, regularChangePercent: undefined },
      { ...pre, regularClose: undefined, regularCloseSessionDate: undefined },
      { ...pre, regularCloseSessionDate: undefined },
      { ...pre, regularCloseSessionDate: "2026-10-09" },
    ]) {
      expect(getRegularSessionDisplay(quote)).toEqual(live);
      expect(getCompletedRegularSessionDisplay(quote)).toBeNull();
      expect(getExtendedSessionDisplay(quote)).toEqual({ session: "PRE", ...live });
    }
  });

  test("a reported move for the completed session is the headline's move in every state, the percent following the change when absent", () => {
    const reported = { ...afterHours, previousClose: 150, regularChange: -7.03, regularChangePercent: -4.1945 };
    expect(getRegularSessionDisplay(reported)).toEqual({ price: 160.57, change: -7.03, changePercent: -4.1945 });
    expect(getRegularSessionDisplay({ ...reported, regularChangePercent: undefined })!.changePercent).toBeCloseTo(-4.1945, 3);
    expect(getRegularSessionDisplay({ ...overnight, regularChange: -7.03, regularChangePercent: -4.1945 })!.change).toBe(-7.03);
  });

  test("in the pre-market the headline and the pre-market line share the previous close", () => {
    const pre: Quote = { symbol: "SPCX", currency: "USD", price: 162, change: 1.43, changePercent: 0.8906,
      previousClose: 160.57, changeSessionDate: "2026-10-09", marketState: "PRE",
      preMarketPrice: 162, preMarketChange: 1.43, preMarketChangePercent: 0.8906,
      listingExchangeName: "NASDAQ", lastUpdated: Date.parse("2026-10-09T11:00:00Z") };
    expect(getRegularSessionDisplay(pre)).toEqual({ price: 162, change: 1.43, changePercent: 0.8906 });
    expect(getExtendedSessionDisplay(pre)).toEqual({ session: "PRE", price: 162, change: 1.43, changePercent: 0.8906 });
    // Before the first pre-market trade there is no pre-market move to color a board by.
    const noTrade = { ...pre, preMarketPrice: undefined, preMarketChange: undefined, preMarketChangePercent: undefined };
    expect(getExtendedSessionDisplay(noTrade)).toBeNull();
    expect(getSessionMoveDisplay(noTrade)).toEqual({ price: 162, change: 1.43, changePercent: 0.8906 });
  });
});

describe("the overnight session", () => {
  const { overnight, overnightMark, weekend } = sessionQuotes();

  test("is its own extended line from Friday's close, while the headline stays the regular session", () => {
    expect(getRegularSessionDisplay(overnight)).toEqual(getRegularSessionDisplay(weekend));
    const extended = getExtendedSessionDisplay(overnight)!;
    expect(extended).toMatchObject({ session: "OVERNIGHT", price: 198.95 });
    expect(extended.change).toBeCloseTo(0.17, 8);
    expect(extended.changePercent).toBeCloseTo((0.17 / 198.78) * 100, 8);
    expect(extended.mark).toBeUndefined();
    expect(extendedSessionLineLabel(extended)).toBe("Overnight");
    // A position is worth the overnight price, from the daily reference.
    expect(getActiveQuoteDisplay(overnight)).toEqual({ price: 198.95, change: 1.17, changePercent: 0.5916 });
    expect(getSessionMoveDisplay(overnight)?.session).toBe("OVERNIGHT");
    // Sunday evening in New York, as the overnight quote is.
    const sunday = Date.parse("2026-10-12T00:35:00Z");
    expect(quoteSessionLabel(overnight, sunday)).toBe("OVERNIGHT");
    expect(quoteSessionLabel(weekend, sunday)).toBe("CLOSED");
  });

  test("says a bid and ask midpoint is one, and a board of moves leaves it out", () => {
    const extended = getExtendedSessionDisplay(overnightMark)!;
    expect(extended).toMatchObject({ session: "OVERNIGHT", price: 198.95, mark: true });
    expect(extendedSessionLineLabel(extended)).toBe("Overnight mid");
    expect(getTradedSessionMoveDisplay(overnightMark)).toEqual(getRegularSessionDisplay(overnightMark));
    expect(getTradedSessionMoveDisplay(overnight)?.session).toBe("OVERNIGHT");
  });

  test("is no session of the exchange's own", () => {
    for (const marketState of ["PRE", "REGULAR", "POST"] as const) {
      const quote = { ...overnight, marketState };
      expect(getExtendedSessionDisplay(quote)?.session).not.toBe("OVERNIGHT");
      expect(quoteSessionLabel(quote)).not.toBe("OVERNIGHT");
    }
  });
});

describe("a quote older than its venue's latest completed session", () => {
  // Thursday 15 Oct 2026: 08:00 New York time is the pre-market, 10:00 the regular session.
  const preMarket = Date.parse("2026-10-15T12:00:00Z");
  const regular = Date.parse("2026-10-15T14:00:00Z");
  const nyse = (marketState: Quote["marketState"], lastUpdated: string): Quote => ({
    symbol: "XYZ", price: 10, change: 0, changePercent: 0, currency: "USD", listingExchangeName: "NYSE",
    marketState, lastUpdated: Date.parse(lastUpdated),
  });

  test("reads STALE, never the session its source states, once a whole session traded after its print", () => {
    // Last printed Tuesday; Wednesday's session has completed since.
    const behind = nyse("REGULAR", "2026-10-13T20:00:00Z");
    expect(quoteSessionLabel(behind, regular)).toBe("STALE");
    expect(quoteMarketStateLabel(behind, regular)).toBe("STALE");
    expect(quoteSessionColor(behind, colors, regular)).toBe(colors.warning);
    expect(quoteDotMarketState(behind, regular)).toBeUndefined();
    // A delisted line years old, with no venue named, is stale whatever its source says.
    const delisted = { ...behind, listingExchangeName: undefined, lastUpdated: Date.parse("2022-03-14T23:00:00Z"), stale: true };
    expect(quoteSessionLabel({ ...delisted, marketState: "POST" }, regular)).toBe("STALE");
  });

  test("the last session's close or after-hours print keeps its state before the open and through the next session", () => {
    const close = nyse("PRE", "2026-10-14T20:00:00Z");
    expect(quoteSessionLabel(close, preMarket)).toBe("PRE-MKT");
    expect(quoteSessionLabel(nyse("PRE", "2026-10-14T23:30:00Z"), preMarket)).toBe("PRE-MKT");
    // No trade yet in Thursday's session: Wednesday's close is the latest completed one.
    expect(quoteSessionLabel({ ...close, marketState: "REGULAR" }, regular)).toBe("OPEN");
    expect(quoteDotMarketState({ ...close, marketState: "REGULAR" }, regular)).toBe("REGULAR");
  });

  test("an FX pair or a coin keeps its state: neither has a session to fall behind", () => {
    const fx: Quote = { ...nyse("REGULAR", "2026-10-12T14:00:00Z"), symbol: "EURUSD=X", listingExchangeName: "CCY", stale: true };
    expect(quoteSessionLabel(fx, regular)).toBe("OPEN");
    expect(quoteSessionLabel({ ...fx, symbol: "BTC-USD", listingExchangeName: "CCC" }, regular)).toBe("OPEN");
  });
});

describe("a pre-market nothing has traded in yet", () => {
  // PLTR at Fri 16 Oct 2026 08:14 UTC: the US pre-market opened at 08:00, nothing has printed in it. The price is
  // Thursday's last after-hours print at 23:59 UTC; the quote carries Thursday's 20:00 UTC close and its move.
  const thursdayClose = Date.parse("2026-10-15T20:00:00Z");
  const waiting: Quote = {
    symbol: "PLTR", currency: "USD", price: 200.66, change: 0.16, changePercent: 0.0798, previousClose: 200.5,
    regularClose: 200.5, regularCloseSessionDate: "2026-10-15", regularChange: -0.47, regularChangePercent: -0.2339,
    changeSessionDate: "2026-10-16", marketState: "PRE", extendedSessionPrint: false, listingExchangeName: "NASDAQ",
    lastUpdated: Date.parse("2026-10-15T23:59:00Z"),
  };
  const now = Date.parse("2026-10-16T08:14:00Z");

  test("reads as the regular close it stands at, by that close's weekday and time, not the pre-market or the after-hours print", () => {
    expect(getRegularSessionDisplay(waiting)).toEqual({ price: 200.5, change: -0.47, changePercent: -0.2339 });
    expect(quoteSessionLabel(waiting, now)).toBe("Thu close");
    expect(quoteMarketStateLabel(waiting, now)).toBe("Thu close");
    expect(quoteSessionColor(waiting, colors, now)).toBe(colors.textDim);
    expect(quoteHeadlineTime(waiting)).toBe(thursdayClose);
    // A source that projects the carried price into the pre-market fields, saying nothing traded, shows no pre-market print.
    const projected = { ...waiting, preMarketPrice: 200.66, preMarketChange: 0.16, preMarketChangePercent: 0.0798 };
    expect(getExtendedSessionDisplay(projected)).toBeNull();
    expect(quoteSessionLabel(projected, now)).toBe("Thu close");
    expect(getSessionMoveDisplay(projected)).toEqual(getRegularSessionDisplay(waiting));
    // So does one that sends no pre-market price, or 0, or the close, and does not say, its last update from before 08:00 UTC.
    for (const preMarketPrice of [undefined, 0, 200.5]) {
      const silent = { ...waiting, extendedSessionPrint: undefined, preMarketPrice };
      expect(quoteSessionLabel(silent, now)).toBe("Thu close");
      expect(getExtendedSessionDisplay(silent)).toBeNull();
    }
  });

  test("a quote that may hold a pre-market trade is never read as the close", () => {
    const sinceOpen = Date.parse("2026-10-16T08:03:45Z");
    const cases: Array<[string, Quote]> = [
      // The source says a trade printed, though it sent no pre-market price.
      ["print flagged, no price", { ...waiting, extendedSessionPrint: true }],
      // The source does not say, and the quote was updated after the pre-market opened at 08:00 UTC.
      ["unflagged, updated since the open", { ...waiting, extendedSessionPrint: undefined, lastUpdated: sinceOpen }],
      // The source does not say, and sends a pre-market price that is not the close.
      ["unflagged, a pre-market price", { ...waiting, extendedSessionPrint: undefined, preMarketPrice: 200.66 }],
      // Fields from two sources: one says nothing traded, the other carries a pre-market trade.
      ["mixed sources", { ...waiting, preMarketPrice: 201.29, preMarketChange: 0.79, preMarketChangePercent: 0.394 }],
      ["mixed sources, its price", { ...waiting, price: 201.29, preMarketPrice: 201.29, lastUpdated: sinceOpen }],
    ];
    for (const [name, quote] of cases) {
      expect(quoteSessionLabel(quote, now), name).toBe("PRE-MKT");
      expect(quoteHeadlineTime(quote), name).toBe(quote.lastUpdated);
    }
    expect(getExtendedSessionDisplay(cases.find(([name]) => name === "mixed sources")![1])).toMatchObject({ session: "PRE", price: 201.29 });
    // A pre-market price of 0 is no print: no $0 pre-market figure, and no $0 position.
    const zero = { ...waiting, extendedSessionPrint: undefined, preMarketPrice: 0, preMarketChange: -200.66, lastUpdated: sinceOpen };
    expect(quoteSessionLabel(zero, now)).toBe("PRE-MKT");
    expect(getExtendedSessionDisplay(zero)).toBeNull();
    expect(getActiveQuoteDisplay(zero)?.price).toBe(200.66);
    // Another venue's pre-market hours are not known: a quote that does not say stays the pre-market's.
    expect(quoteSessionLabel({ ...waiting, extendedSessionPrint: undefined, listingExchangeName: "LSE" }, now)).toBe("PRE-MKT");
  });

  test("a pre-market trade is the pre-market again, at that trade's time", () => {
    const printed = { ...waiting, price: 201.29, preMarketPrice: 201.29, preMarketChange: 0.79, preMarketChangePercent: 0.394,
      extendedSessionPrint: true, lastUpdated: Date.parse("2026-10-16T08:03:45Z") };
    expect(quoteSessionLabel(printed, now)).toBe("PRE-MKT");
    expect(quoteHeadlineTime(printed)).toBe(printed.lastUpdated);
    expect(getExtendedSessionDisplay(printed)).toMatchObject({ session: "PRE", price: 201.29 });
    // Without the close and its move the quote cannot say which close it is: it stays the pre-market's.
    const unanchored = { ...waiting, regularClose: undefined, regularCloseSessionDate: undefined };
    expect(quoteSessionLabel(unanchored, now)).toBe("PRE-MKT");
    expect(quoteHeadlineTime(unanchored)).toBe(waiting.lastUpdated);
  });

  test("the regular session and after hours keep their own labels and times", () => {
    const { regular, afterHours } = sessionQuotes();
    expect(quoteSessionLabel(regular, regular.lastUpdated)).toBe("OPEN");
    expect(quoteHeadlineTime(regular)).toBe(regular.lastUpdated);
    expect(quoteSessionLabel(afterHours, afterHours.lastUpdated)).toBe("AFTER-HRS");
    expect(quoteHeadlineTime(afterHours)).toBe(afterHours.lastUpdated);
  });

  test("after a weekend or a holiday the close is the last session's: Friday's, and its early close", () => {
    // Monday 12 Oct 05:00 New York: Friday 9 Oct closed at 20:00 UTC.
    const { weekend } = sessionQuotes();
    const monday = { ...weekend, marketState: "PRE" as const, changeSessionDate: "2026-10-12", extendedSessionPrint: false };
    expect(quoteSessionLabel(monday, Date.parse("2026-10-12T09:00:00Z"))).toBe("Fri close");
    expect(quoteHeadlineTime(monday)).toBe(Date.parse("2026-10-09T20:00:00Z"));
    // Monday 30 Nov: the day after Thanksgiving closed early, at 13:00 New York.
    const afterThanksgiving = { ...monday, regularCloseSessionDate: "2026-11-27", changeSessionDate: "2026-11-30",
      lastUpdated: Date.parse("2026-11-28T00:59:00Z") };
    expect(quoteSessionLabel(afterThanksgiving, Date.parse("2026-11-30T10:00:00Z"))).toBe("Fri close");
    expect(quoteHeadlineTime(afterThanksgiving)).toBe(Date.parse("2026-11-27T18:00:00Z"));
  });
});
