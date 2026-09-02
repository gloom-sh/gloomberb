import { describe, expect, test } from "bun:test";
import { resolveHeaderPromptGeometry } from "./shell/chrome";
import { resolveMarketSummaryFit } from "./market-summary";

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
