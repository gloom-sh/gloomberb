import { describe, expect, test } from "bun:test";
import { resolveHeaderPromptGeometry } from "./shell/chrome";
import {
  headerMarketState,
  headerQuoteSummary,
  marketSummaryWidths,
  resolveMarketSummaryFit,
  type MarketSummary,
} from "./market-summary";
import { colors } from "../../theme/colors";
import { createTestQuote } from "../../test-support/data-provider";
import type { Quote } from "../../types/financials";

/** "NYSE pre-market · opens 9:30 ET  S&P 500 6,843 +0.20%  ◷15m", each part with its trailing gap. */
const CLUSTER = {
  quoteWidth: 26,
  quoteMoveWidth: 7,
  // "NYSE pre-market", "NYSE pre", "pre"
  stateWidths: { full: 16, short: 9, bare: 4 },
  detailWidth: 16,
};

describe("header market cluster", () => {
  /**
   * The cluster shares the header with the command prompt, so a narrow window
   * takes it apart in an order the eye can follow: when the session changes
   * first, then the exchange's state, shortened before it goes, then the
   * quote's move, and the market last because it is the value that moves.
   */
  test("sheds the detail, shortens the state and then drops it, then the move, keeping the market longest", () => {
    const fit = (available: number, options: Partial<typeof CLUSTER> = {}) => resolveMarketSummaryFit({ available, ...CLUSTER, ...options });
    expect(fit(58)).toEqual({ showQuote: true, showQuoteMove: true, state: "full", showDetail: true });
    expect(fit(57)).toEqual({ showQuote: true, showQuoteMove: true, state: "full", showDetail: false });
    expect(fit(41)).toEqual({ showQuote: true, showQuoteMove: true, state: "short", showDetail: false });
    expect(fit(34)).toEqual({ showQuote: true, showQuoteMove: true, state: "bare", showDetail: false });
    expect(fit(29)).toEqual({ showQuote: true, showQuoteMove: true, state: null, showDetail: false });
    // A detail that fits on its own never shows beside a shortened state, or without one.
    expect(fit(41, { detailWidth: 6 }).showDetail).toBe(false);
    expect(fit(29, { detailWidth: 2 }).showDetail).toBe(false);
    // A market too wide to keep its move gives it up; the room it leaves can still hold the bare state.
    expect(fit(25)).toEqual({ showQuote: true, showQuoteMove: false, state: "bare", showDetail: false });
    expect(fit(20)).toEqual({ showQuote: true, showQuoteMove: false, state: null, showDetail: false });
    // With no move to give up, a market too wide for the room gives way, and the state with it.
    expect(fit(25, { quoteMoveWidth: 0 })).toEqual({ showQuote: false, showQuoteMove: false, state: null, showDetail: false });
  });

  /**
   * The bare forms are never wider than what the header said before it named
   * the exchange (PRE-MKT, OPEN, AFTER-HRS, CLOSED), so a header that had room
   * for that state keeps one.
   */
  test("never shortens a state to wider than the old one", () => {
    const old = { "pre-market": "PRE-MKT", open: "OPEN", "after-hours": "AFTER-HRS", closed: "CLOSED", holiday: "CLOSED" };
    const at = {
      "pre-market": "2026-10-13T12:00:00Z",
      open: "2026-10-13T14:00:00Z",
      "after-hours": "2026-10-13T21:30:00Z",
      closed: "2026-10-14T01:00:00Z",
      holiday: "2026-11-26T15:00:00Z",
    };
    for (const [phase, iso] of Object.entries(at)) {
      const { marketLabels } = headerMarketState({ venue: "NYSE", exchange: "" }, null, Date.parse(iso), colors);
      expect(marketLabels.bare.length, phase).toBeLessThanOrEqual(old[phase as keyof typeof old].length);
      expect(marketLabels.short.length, phase).toBeLessThanOrEqual(marketLabels.full.length);
      expect(marketLabels.bare.length, phase).toBeLessThan(marketLabels.short.length);
    }
    expect(headerMarketState({ venue: "NYSE", exchange: "" }, null, Date.parse(at["pre-market"]), colors).marketLabels)
      .toEqual({ full: "NYSE pre-market", short: "NYSE pre", bare: "pre" });
  });

  /**
   * The reserve lives with the prompt geometry and the widths here, so this is
   * the seam where the two can drift: the longer state and its detail use
   * spare columns without shortening the command prompt.
   */
  test("fits the cluster into the columns the prompt leaves, without moving the prompt", () => {
    const summary: MarketSummary = {
      marketLabels: { full: "NYSE pre-market", short: "NYSE pre", bare: "pre" },
      marketDetail: "opens 9:30 ET",
      marketColor: colors.text,
      quoteLabel: "S&P 500",
      quoteText: "6,843 +0.20%",
      quotePriceText: "6,843",
      quoteColor: colors.positive,
      quoteDelayMinutes: 15,
    };
    const widths = marketSummaryWidths(summary, 4);
    const fitAt = (termWidth: number, allowMarketExpansion?: boolean) => resolveMarketSummaryFit({
      available: resolveHeaderPromptGeometry({ termWidth, allowMarketExpansion }).marketColumns,
      ...widths,
    });
    expect(fitAt(80)).toEqual({ showQuote: true, showQuoteMove: false, state: null, showDetail: false });
    expect(fitAt(100)).toEqual({ showQuote: true, showQuoteMove: true, state: "bare", showDetail: false });
    for (const termWidth of [120, 140, 160]) {
      expect(fitAt(termWidth)).toEqual({ showQuote: true, showQuoteMove: true, state: "full", showDetail: false });
    }
    for (const termWidth of [200, 240]) {
      expect(fitAt(termWidth)).toEqual({ showQuote: true, showQuoteMove: true, state: "full", showDetail: true });
      // An update status keeps the room the detail would take; the prompt stays put either way.
      expect(fitAt(termWidth, false).showDetail).toBe(false);
      expect(resolveHeaderPromptGeometry({ termWidth, allowMarketExpansion: false }).width)
        .toBe(resolveHeaderPromptGeometry({ termWidth }).width);
    }
    // Spare room between the tiers goes to the cluster, never out of the prompt.
    for (const termWidth of [150, 160, 170, 180]) {
      const quiet = resolveHeaderPromptGeometry({ termWidth });
      const updating = resolveHeaderPromptGeometry({ termWidth, allowMarketExpansion: false });
      expect(quiet.width).toBe(updating.width);
      expect(quiet.marketColumns).toBeGreaterThanOrEqual(updating.marketColumns);
      expect(quiet.marketColumns).toBeLessThanOrEqual(64);
    }
  });
});

describe("header market quote", () => {
  test("reads an index by its level in whole units and a listing to its tick", () => {
    const index = createTestQuote({ symbol: "^GSPC", instrumentType: "INDEX", price: 6843.21, change: 13.66, changePercent: 0.2, marketState: "REGULAR" });
    expect(headerQuoteSummary(index, colors)).toMatchObject({ quoteText: "6,843 +0.20%", quotePriceText: "6,843" });
    const etf = createTestQuote({ symbol: "SPY", instrumentType: "ETF", price: 687.18, change: -3.66, changePercent: -0.53, marketState: "REGULAR" });
    expect(headerQuoteSummary(etf, colors).quotePriceText).toBe("$687.18");
    // A quote without a price is no answer: the strip shows a dash, never a zero level.
    expect(headerQuoteSummary(createTestQuote({ symbol: "^GSPC", instrumentType: "INDEX", price: 0 }), colors).quoteText).toBe("—");
  });
});

describe("header market state", () => {
  const at = (iso: string) => Date.parse(iso);
  const state = (venue: string, iso: string, quote: Quote | null = null) => {
    const { marketLabels, marketDetail } = headerMarketState({ venue, exchange: "" }, quote, at(iso), colors);
    return marketDetail ? `${marketLabels.full} · ${marketDetail}` : marketLabels.full;
  };
  const reporting = (marketState: Quote["marketState"], overrides: Partial<Quote> = {}) => createTestQuote({ symbol: "IDX", marketState, ...overrides });

  /** The exchange's own hours and holidays, read on its clock, whatever zone the machine is in. */
  test("names the exchange and where its day stands", () => {
    // Tuesday 13 October 2026 in New York.
    expect(state("NYSE", "2026-10-13T03:00:00Z")).toBe("NYSE closed · opens 9:30 ET");
    expect(state("NYSE", "2026-10-13T12:00:00Z")).toBe("NYSE pre-market · opens 9:30 ET");
    expect(state("NYSE", "2026-10-13T13:50:00Z")).toBe("NYSE open · 6h10 left");
    expect(state("NYSE", "2026-10-13T21:30:00Z")).toBe("NYSE after-hours · opens 9:30 ET");
    expect(state("NYSE", "2026-10-14T01:00:00Z")).toBe("NYSE closed · opens 9:30 ET");
    expect(state("NYSE", "2026-10-17T15:00:00Z")).toBe("NYSE closed · opens Mon 9:30 ET");
    // Thanksgiving, and the early close the day after it.
    expect(state("NYSE", "2026-11-26T15:00:00Z")).toBe("NYSE holiday · opens 9:30 ET");
    expect(state("NYSE", "2026-11-27T16:00:00Z")).toBe("NYSE open · 2h left");
    // Hong Kong: its lunch break, its afternoon, and the Chung Yeung holiday; no pre-market.
    expect(state("HKEX", "2026-10-13T01:00:00Z")).toBe("HKEX closed · opens 9:30 HKT");
    expect(state("HKEX", "2026-10-13T04:30:00Z")).toBe("HKEX lunch · reopens 13:00 HKT");
    expect(state("HKEX", "2026-10-13T06:00:00Z")).toBe("HKEX open · 2h10 left");
    expect(state("HKEX", "2026-10-19T02:00:00Z")).toBe("HKEX holiday · opens 9:30 HKT");
    expect(state("JPX", "2026-10-13T03:00:00Z")).toBe("JPX lunch · reopens 12:30 JST");
  });

  /** Christmas Eve and Lunar New Year's Eve trade the morning only: no lunch, no afternoon. */
  test("ends a half day after the morning", () => {
    expect(state("HKEX", "2026-12-24T04:05:00Z")).toBe("HKEX open · 5m left");
    expect(state("HKEX", "2026-12-24T04:30:00Z")).toBe("HKEX closed · opens Mon 9:30 HKT");
    expect(state("HKEX", "2026-12-24T06:00:00Z")).toBe("HKEX closed · opens Mon 9:30 HKT");
    expect(state("SGX", "2026-12-24T04:30:00Z")).toBe("SGX closed · opens Mon 9:00 SGT");
    expect(state("SGX", "2026-12-31T05:00:00Z")).toBe("SGX closed · opens Mon 9:00 SGT");
    expect(state("HKEX", "2026-02-16T06:00:00Z")).toBe("HKEX closed · opens Fri 9:30 HKT");
  });

  /**
   * Where the app has no published closures for the day (LSE and XETRA have
   * none, SSE none past 2026) a holiday would read as a session, so the state
   * is the one the quote reports, with no time; with no quote, there is none.
   */
  test("reads the quote's state on a day whose closures are not published", () => {
    // Christmas Day and the Boxing Day holiday in London and Frankfurt.
    expect(state("XETRA", "2026-12-25T10:00:00Z")).toBe("");
    expect(state("LSE", "2026-12-25T10:00:00Z")).toBe("");
    expect(state("XETRA", "2026-12-25T10:00:00Z", reporting("CLOSED"))).toBe("XETRA closed");
    expect(state("LSE", "2026-12-28T10:00:00Z", reporting("CLOSED"))).toBe("LSE closed");
    expect(state("LSE", "2026-10-13T10:00:00Z", reporting("REGULAR"))).toBe("LSE open");
    expect(state("SSE", "2027-01-01T03:00:00Z", reporting("CLOSED"))).toBe("SSE closed");
    // The last published day says it closed, not when it opens in a year the calendar does not have.
    expect(state("SSE", "2026-12-31T08:00:00Z")).toBe("SSE closed");
    // A quote the app marked stale says nothing about now.
    expect(state("LSE", "2026-10-13T10:00:00Z", reporting("REGULAR", { stale: true }))).toBe("");
  });

  test("reads a picked listing's venue from its quote, and its quote's state where that venue's calendar is not published", () => {
    const listing = (exchangeName: string, marketState: Quote["marketState"]) => createTestQuote({ symbol: "XYZ", exchangeName, marketState });
    const picked = (quote: Quote, iso: string) => {
      const { marketLabels, marketDetail } = headerMarketState({ venue: null, exchange: "" }, quote, at(iso), colors);
      return marketDetail ? `${marketLabels.full} · ${marketDetail}` : marketLabels.full;
    };
    expect(picked(listing("HKEX", "REGULAR"), "2026-12-24T06:00:00Z")).toBe("HKEX closed · opens Mon 9:30 HKT");
    expect(picked(listing("LSE", "CLOSED"), "2026-12-25T10:00:00Z")).toBe("LSE closed");
    expect(picked(listing("Nowhere", "REGULAR"), "2026-10-13T15:00:00Z")).toBe("Nowhere open");
    expect(headerMarketState({ venue: "CCC", exchange: "" }, null, at("2026-10-13T15:00:00Z"), colors).marketLabels.full).toBe("");
  });
});
