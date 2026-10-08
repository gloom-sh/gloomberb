import { afterEach, expect, test } from "bun:test";
import { applyTheme } from "../../../theme/colors";
import { contrastRatio } from "../../../theme/color-utils";
import { colors } from "../../../theme/colors";
import { DEFAULT_THEME, themes } from "../../../theme/themes";
import { TINT_THRESHOLDS, crossMovePercent, directionTint, nextTintLevel, tintLevel } from "./direction";

afterEach(() => applyTheme(DEFAULT_THEME));

test("a cross moves as the row currency gains on the column currency, whichever way the pair is quoted", () => {
  // EUR 1.07 -> 1.08 USD, JPY 149 -> 150 per USD (so JPY fell): EUR/JPY rose, JPY/EUR fell, USD/JPY rose.
  expect(crossMovePercent(1.08, 1.07, 1 / 150, 1 / 149)).toBeCloseTo(1.6, 1);
  expect(crossMovePercent(1 / 150, 1 / 149, 1.08, 1.07)).toBeCloseTo(-1.58, 1);
  expect(crossMovePercent(1, 1, 1 / 150, 1 / 149)).toBeCloseTo(0.67, 1);
  expect(crossMovePercent(1.08, 1.08, 1 / 150, 1 / 150)).toBe(0);
  expect(crossMovePercent(1, 0, 1, 1)).toBeNull();
});

test("a step is earned at its threshold and held until the move falls a fifth short of it", () => {
  const held = new Map<string, number>();
  const show = (move: number) => nextTintLevel(held, "EUR/GBP", move);
  expect(show(0.049)).toBe(0);
  expect(show(TINT_THRESHOLDS[0])).toBe(1);
  // Ticking around the 0.15% boundary does not flicker between two shades...
  expect(show(0.151)).toBe(2);
  expect(show(0.149)).toBe(2);
  expect(show(0.125)).toBe(2);
  // ...until the move has really fallen back.
  expect(show(0.119)).toBe(1);
  expect(show(0.149)).toBe(1);
  // A fall of several steps does not hold the old shade, and a move across zero starts afresh.
  expect(show(1.2)).toBe(5);
  expect(show(0.2)).toBe(2);
  expect(show(-0.2)).toBe(-2);
  expect(show(-0.04)).toBe(0);
  // The first step is held down to 0.03% (a fixed band, as a fifth of 0.05% is only a pip) and not past it.
  expect(show(-0.06)).toBe(-1);
  expect(show(-0.031)).toBe(-1);
  expect(show(-0.029)).toBe(0);
  expect(show(-0.045)).toBe(0);
  // A cell that loses its reference forgets its step.
  show(0.4);
  expect(nextTintLevel(held, "EUR/GBP", null)).toBe(0);
  expect(held.size).toBe(0);
  expect(tintLevel(-0.31)).toBe(-3);
});

test("the tint keeps the numbers readable in every theme, on the plain and the selected row", () => {
  for (const themeId of Object.keys(themes)) {
    applyTheme(themeId);
    for (const surface of [
      { background: colors.bg, text: colors.text },
      { background: colors.selected, text: colors.selectedText },
    ]) {
      const floor = Math.min(4.5, contrastRatio(surface.text, surface.background) * 0.9);
      for (const level of [1, 2, 3, 4, 5, -1, -2, -3, -4, -5]) {
        const tint = directionTint(level, surface);
        expect(tint, `${themeId} step ${level}`).toBeDefined();
        expect(contrastRatio(surface.text, tint!), `${themeId} step ${level}`).toBeGreaterThanOrEqual(floor);
      }
      expect(directionTint(5, surface)).not.toBe(directionTint(-5, surface));
      expect(directionTint(0, surface)).toBeUndefined();
    }
  }
});
