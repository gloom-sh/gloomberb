import { afterEach, describe, expect, test } from "bun:test";
import { applyTheme } from "./colors";
import { contrastRatio } from "./color-utils";
import { DEFAULT_THEME, themes } from "./themes";
import { resolveHeatCellColors } from "./heat-colors";

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
