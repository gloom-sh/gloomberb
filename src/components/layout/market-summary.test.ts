import { describe, expect, test } from "bun:test";
import { resolveHeaderPromptGeometry } from "./shell/chrome";
import { resolveMarketSummaryFit, spySummary } from "./market-summary";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../market-data/market/status";
import { colors } from "../../theme/colors";
import type { Quote } from "../../types/financials";
import { sessionQuotes } from "../../test-support/test-fixture-session-quotes";
import { formatPercentRaw } from "../../utils/format";

/** "PRE-MKT · 1h 17m  SPY 762.43 -0.60%  USD", each part with its trailing gap. */
const CLUSTER = {
  baseCurrencyWidth: 4,
  countdownWidth: 9,
  spyWidth: 18,
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
    expect(resolveMarketSummaryFit({ available: 39, ...CLUSTER })).toEqual({
      showSpy: true,
      showState: true,
      showBaseCurrency: true,
      showCountdown: true,
    });
    expect(resolveMarketSummaryFit({ available: 38, ...CLUSTER })).toMatchObject({
      showSpy: true,
      showState: true,
      showBaseCurrency: true,
      showCountdown: false,
    });
    expect(resolveMarketSummaryFit({ available: 29, ...CLUSTER })).toMatchObject({
      showSpy: true,
      showState: true,
      showBaseCurrency: false,
      showCountdown: false,
    });
    expect(resolveMarketSummaryFit({ available: 25, ...CLUSTER })).toMatchObject({
      showSpy: true,
      showState: false,
      showBaseCurrency: true,
    });
    expect(resolveMarketSummaryFit({ available: 17, ...CLUSTER })).toMatchObject({
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
   * this is the seam where the two can drift: a reserve a column short would
   * silently drop the countdown on a window wide enough to show it.
   */
  test("fits the whole cluster in the columns the header reserves for it", () => {
    for (const termWidth of [120, 200]) {
      const { marketColumns } = resolveHeaderPromptGeometry({ termWidth });
      expect(resolveMarketSummaryFit({ available: marketColumns, ...CLUSTER })).toEqual({
        showSpy: true,
        showState: true,
        showBaseCurrency: true,
        showCountdown: true,
      });
    }

    // 80 columns keeps only SPY, and reserves nothing it cannot spend.
    const narrow = resolveHeaderPromptGeometry({ termWidth: 80 });
    expect(resolveMarketSummaryFit({ available: narrow.marketColumns, ...CLUSTER })).toMatchObject({
      showSpy: true,
      showState: false,
    });
  });
});

describe("header SPY", () => {
  const spy = sessionQuotes("SPY");
  const text = (quote: Quote) => spySummary(quote, colors).spyText;

  test("holds the regular close and its move once the market is closed, as `ticker SPY` headlines them", () => {
    const close = getRegularSessionDisplay(spy.weekend)!;
    expect(text(spy.weekend)).toBe(`SPY 198.78 ${formatPercentRaw(close.changePercent)}`);
    expect(text(spy.regular)).toBe("SPY 199.10 +0.67%");
  });

  test("shows the open extended session's print and its move from the close beside AFTER-HRS or PRE-MKT", () => {
    for (const quote of [spy.afterHours, spy.preMarket]) {
      const extended = getExtendedSessionDisplay(quote)!;
      expect(text(quote)).toBe(`SPY ${extended.price.toFixed(2)} ${formatPercentRaw(extended.changePercent).padStart(6)}`);
    }
    expect(text(spy.afterHours)).toBe("SPY 198.80 +0.01%");
    expect(text(spy.preMarket)).toBe("SPY 199.50 +0.36%");
  });
});
