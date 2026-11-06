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

/** "NYSE pre-market · opens 9:30 ET  S&P 500 6,843 +0.20%  ◷15m", each part with its trailing gap. */
const CLUSTER = {
  quoteWidth: 26,
  quoteMoveWidth: 7,
  stateWidth: 16,
  detailWidth: 16,
};

describe("header market cluster", () => {
  /**
   * The cluster shares the header with the command prompt, so a narrow window
   * takes it apart in an order the eye can follow: when the session changes
   * first, then the exchange's state, then the quote's move, and the market
   * last because it is the value that moves.
   */
  test("sheds the detail, then the state, then the move, keeping the market longest", () => {
    expect(resolveMarketSummaryFit({ available: 58, ...CLUSTER })).toEqual({
      showQuote: true, showQuoteMove: true, showState: true, showDetail: true,
    });
    expect(resolveMarketSummaryFit({ available: 57, ...CLUSTER })).toEqual({
      showQuote: true, showQuoteMove: true, showState: true, showDetail: false,
    });
    expect(resolveMarketSummaryFit({ available: 41, ...CLUSTER })).toEqual({
      showQuote: true, showQuoteMove: true, showState: false, showDetail: false,
    });
    // A detail that fits on its own never shows without the state it extends.
    expect(resolveMarketSummaryFit({ available: 41, ...CLUSTER, detailWidth: 10 }).showDetail).toBe(false);
    expect(resolveMarketSummaryFit({ available: 25, ...CLUSTER })).toEqual({
      showQuote: true, showQuoteMove: false, showState: false, showDetail: false,
    });
    // With no move to give up, a market too wide for the room gives way, and the state with it.
    expect(resolveMarketSummaryFit({ available: 25, ...CLUSTER, quoteMoveWidth: 0, stateWidth: 12 })).toEqual({
      showQuote: false, showQuoteMove: false, showState: false, showDetail: false,
    });
  });

  /**
   * The reserve lives with the prompt geometry and the widths here, so this is
   * the seam where the two can drift: the longer state and its detail use
   * spare columns without shortening the command prompt.
   */
  test("fits the cluster into the columns the prompt leaves, without moving the prompt", () => {
    const summary: MarketSummary = {
      marketLabel: "NYSE pre-market",
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
    expect(fitAt(80)).toEqual({ showQuote: true, showQuoteMove: false, showState: false, showDetail: false });
    for (const termWidth of [120, 140, 160]) {
      expect(fitAt(termWidth)).toEqual({ showQuote: true, showQuoteMove: true, showState: true, showDetail: false });
    }
    for (const termWidth of [200, 240]) {
      expect(fitAt(termWidth)).toEqual({ showQuote: true, showQuoteMove: true, showState: true, showDetail: true });
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
  const state = (venue: string, iso: string) => {
    const { marketLabel, marketDetail } = headerMarketState({ venue, exchange: "" }, null, at(iso), colors);
    return marketDetail ? `${marketLabel} · ${marketDetail}` : marketLabel;
  };

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
    expect(state("XETRA", "2026-10-17T10:00:00Z")).toBe("XETRA closed · opens Mon 9:00 CET");
  });

  test("falls back to the quote's state for a venue whose hours it does not know, and says nothing around the clock", () => {
    const quote = createTestQuote({ symbol: "XYZ", exchangeName: "Nowhere", marketState: "REGULAR" });
    expect(headerMarketState({ venue: null, exchange: "" }, quote, at("2026-10-13T15:00:00Z"), colors)).toMatchObject({
      marketLabel: "Nowhere open",
      marketDetail: null,
    });
    expect(headerMarketState({ venue: "CCC", exchange: "" }, null, at("2026-10-13T15:00:00Z"), colors).marketLabel).toBe("");
  });
});
