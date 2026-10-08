import { afterEach, describe, expect, test } from "bun:test";
import { applyTheme } from "./colors";
import { contrastRatio } from "./color-utils";
import { DEFAULT_THEME, themes } from "./themes";
import {
  hexToOklab,
  resolveHeatCellColors,
  resolveHeatmapSelectedTileColors,
  resolveHeatmapTileColors,
} from "./heat-colors";

const CORRELATION_VALUES = [-1, -0.75, -0.5, -0.25, 0, 0.13, 0.24, 0.39, 0.49, 0.75, 1] as const;
const CELL_TEXT_MIN_CONTRAST = 4.5;
const MUTED_TEXT_MIN_CONTRAST = 3.6;

afterEach(() => {
  applyTheme(DEFAULT_THEME);
});

describe("heat cell colors", () => {
  test("keeps populated cells readable in every theme", () => {
    for (const themeId of Object.keys(themes)) {
      applyTheme(themeId);
      for (const correlation of CORRELATION_VALUES) {
        const cell = resolveHeatCellColors(correlation);
        expect(
          contrastRatio(cell.foreground, cell.background),
          `${themeId} correlation ${correlation}`,
        ).toBeGreaterThanOrEqual(CELL_TEXT_MIN_CONTRAST);
      }
    }
  });

  test("keeps empty cells readable in every theme", () => {
    for (const themeId of Object.keys(themes)) {
      applyTheme(themeId);
      const cell = resolveHeatCellColors(null);
      expect(
        contrastRatio(cell.foreground, cell.background),
        `${themeId} empty cell`,
      ).toBeGreaterThanOrEqual(MUTED_TEXT_MIN_CONTRAST);
    }
  });
});

function oklabDistance(left: string, right: string): number {
  const [l1, a1, b1] = hexToOklab(left);
  const [l2, a2, b2] = hexToOklab(right);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

function chroma(hex: string): number {
  const [, a, b] = hexToOklab(hex);
  return Math.hypot(a, b);
}

describe("heat map tile colors", () => {
  const MOVES = [-6, -3, -2, -1, -0.5, -0.1, 0, 0.1, 0.5, 1, 2, 3, 6];

  test("every tile, selected or not, keeps its text readable in every theme", () => {
    for (const themeId of Object.keys(themes)) {
      applyTheme(themeId);
      for (const move of [...MOVES, null]) {
        for (const tile of [resolveHeatmapTileColors(move), resolveHeatmapSelectedTileColors(move)]) {
          expect(contrastRatio(tile.foreground, tile.background), `${themeId} ${move}`).toBeGreaterThanOrEqual(CELL_TEXT_MIN_CONTRAST);
        }
      }
    }
  });

  test("colour moves away from flat steadily with the size of the move and is full at 3%", () => {
    for (const themeId of ["white", "github-light"]) {
      applyTheme(themeId);
      const flat = resolveHeatmapTileColors(0).background;
      for (const side of [-1, 1]) {
        const steps = [0.1, 0.3, 0.6, 1, 1.5, 2, 2.5, 3].map((move) => oklabDistance(resolveHeatmapTileColors(side * move).background, flat));
        for (let index = 1; index < steps.length; index += 1) expect(steps[index]!, `${themeId} ${side}`).toBeGreaterThan(steps[index - 1]!);
        expect(resolveHeatmapTileColors(side * 6).background).toBe(resolveHeatmapTileColors(side * 3).background);
      }
      // Losses and gains read as different hues, not just different strengths.
      expect(oklabDistance(resolveHeatmapTileColors(-3).background, resolveHeatmapTileColors(3).background)).toBeGreaterThan(0.2);
    }
  });

  test("a missing move is grey, never the flat colour", () => {
    for (const themeId of ["white", "github-light"]) {
      applyTheme(themeId);
      const missing = resolveHeatmapTileColors(null).background;
      expect(chroma(missing)).toBeLessThan(0.02);
      expect(missing).not.toBe(resolveHeatmapTileColors(0).background);
      expect(resolveHeatmapTileColors(Number.NaN).background).toBe(missing);
    }
  });
});
