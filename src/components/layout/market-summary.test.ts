import { describe, expect, test } from "bun:test";
import { resolveHeaderPromptGeometry } from "./shell/chrome";
import { resolveMarketSummaryFit, spySummary } from "./market-summary";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../market-data/market/status";
import { colors } from "../../theme/colors";
import type { Quote } from "../../types/financials";
import { sessionQuotes } from "../../test-support/test-fixture-session-quotes";
import { formatPercentRaw } from "../../utils/format";

/** "PRE-MKT · 1h 17m to regular open  SPY $762.43 -0.60%  base USD", each part with its trailing gap. */
const CLUSTER = {
  baseCurrencyWidth: 9,
  countdownWidth: 25,
  spyWidth: 19,
  stateWidth: 8,
};

describe("header market cluster", () => {
  /**
   * The cluster shares the header with the command prompt, so a narrow window
   * has to take it apart in an order the eye can follow: the countdown suffix
   * first, then the base currency, then the state label, and SPY last because
   * it is the value that moves.
   */
  test("sheds the countdown, then the currency, then the state, keeping SPY longest", () => {
    expect(resolveMarketSummaryFit({ available: 61, ...CLUSTER })).toEqual({
      showSpy: true,
      showState: true,
      showBaseCurrency: true,
      showCountdown: true,
      showSpyMove: true,
    });
    expect(resolveMarketSummaryFit({ available: 60, ...CLUSTER })).toMatchObject({
      showSpy: true,
      showState: true,
      showBaseCurrency: true,
      showCountdown: false,
    });
    expect(resolveMarketSummaryFit({ available: 35, ...CLUSTER })).toMatchObject({
      showSpy: true,
      showState: true,
      showBaseCurrency: false,
      showCountdown: false,
    });
    // AFTER-HRS, wider than the base currency label.
    expect(resolveMarketSummaryFit({ available: 28, ...CLUSTER, stateWidth: 10 })).toMatchObject({
      showSpy: true,
      showState: false,
      showBaseCurrency: true,
    });
    expect(resolveMarketSummaryFit({ available: 18, ...CLUSTER })).toMatchObject({
      showSpy: false,
      showState: true,
      showBaseCurrency: true,
    });
  });

  /** A countdown without the label it extends would read as a lone timer. */
  test("never shows a countdown without its state label", () => {
    const fit = resolveMarketSummaryFit({ ...CLUSTER, available: 30, stateWidth: 0 });
    expect(fit.showState).toBe(false);
    expect(fit.showCountdown).toBe(false);
  });

  /**
   * The reserve lives with the prompt geometry and the widths live here, so
   * this is the seam where the two can drift: a longer countdown must use
   * spare columns without shortening the command prompt.
   */
  test("fits the whole cluster only when spare room preserves the prompt", () => {
    for (const termWidth of [120, 140, 160]) {
      const { marketColumns } = resolveHeaderPromptGeometry({ termWidth });
      expect(resolveMarketSummaryFit({ available: marketColumns, ...CLUSTER })).toMatchObject({
        showSpy: true,
        showState: true,
        showCountdown: false,
      });
    }
    for (const termWidth of [180, 200]) {
      const { marketColumns } = resolveHeaderPromptGeometry({ termWidth });
      expect(resolveMarketSummaryFit({ available: marketColumns, ...CLUSTER })).toEqual({
        showSpy: true,
        showState: true,
        showBaseCurrency: true,
        showCountdown: true,
        showSpyMove: true,
      });
      const updating = resolveHeaderPromptGeometry({ termWidth, allowMarketExpansion: false });
      const quiet = resolveHeaderPromptGeometry({ termWidth });
      expect(updating.width).toBe(quiet.width);
      expect(updating.marketColumns).toBe(42);
      expect(updating.updateColumns - quiet.updateColumns).toBe(22);
    }

    // 80 columns keeps only SPY, and reserves nothing it cannot spend.
    const narrow = resolveHeaderPromptGeometry({ termWidth: 80 });
    expect(resolveMarketSummaryFit({ available: narrow.marketColumns, ...CLUSTER })).toMatchObject({
      showSpy: true,
      showState: false,
    });
  });

  /**
   * An account without Pro sees SPY late, and its mark (`◷15m`, or the clock
   * and 15m on the desktop) makes SPY too wide for the narrowest cluster.
   * SPY gives up its move there rather than leave the header to the state
   * and base currency, which give way first at every wider step.
   */
  test("keeps a delayed SPY and its mark by shedding the rest, then SPY's move", () => {
    const delayed = { ...CLUSTER, spyWidth: CLUSTER.spyWidth + 7, spyMoveWidth: 7 };
    expect(resolveMarketSummaryFit({ available: 31, ...delayed })).toMatchObject({
      showSpy: true,
      showSpyMove: true,
      showState: false,
      showBaseCurrency: false,
    });
    expect(resolveMarketSummaryFit({ available: 21, ...delayed })).toEqual({
      showSpy: true,
      showSpyMove: false,
      showState: false,
      showBaseCurrency: false,
      showCountdown: false,
    });
    // A SPY with no move to give up gives way as before.
    expect(resolveMarketSummaryFit({ available: 21, ...delayed, spyMoveWidth: 0 })).toMatchObject({
      showSpy: false,
      showState: true,
    });
  });
});

describe("header SPY", () => {
  const spy = sessionQuotes("SPY");
  const text = (quote: Quote) => spySummary(quote, colors).spyText;

  test("holds the regular close and its move once the market is closed, as `ticker SPY` headlines them", () => {
    const close = getRegularSessionDisplay(spy.weekend)!;
    expect(text(spy.weekend)).toBe(`SPY $198.78 ${formatPercentRaw(close.changePercent)}`);
    expect(text(spy.regular)).toBe("SPY $199.10 +0.67%");
  });

  test("shows the open extended session's print and its move from the close beside AFTER-HRS or PRE-MKT", () => {
    for (const quote of [spy.afterHours, spy.preMarket]) {
      const extended = getExtendedSessionDisplay(quote)!;
      expect(text(quote)).toBe(`SPY $${extended.price.toFixed(2)} ${formatPercentRaw(extended.changePercent).padStart(6)}`);
    }
    expect(text(spy.afterHours)).toBe("SPY $198.80 +0.01%");
    expect(text(spy.preMarket)).toBe("SPY $199.50 +0.36%");
  });
});
