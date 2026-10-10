import { afterEach, describe, expect, test } from "bun:test";
import { applyTheme, getThemeColors, type ThemeColors } from "./colors";
import { contrastRatio, relativeLuminance } from "./color-utils";
import { DEFAULT_THEME, getThemeIds, isDarkTheme, themes } from "./themes";
import {
  hexToOklab,
  resolveHeatCellColors,
  resolveHeatmapSelectedTileColors,
  resolveHeatmapSelectionRing,
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

/** A user's own palette: a teal page with amber text, orange losses and blue gains. */
const CUSTOM_PALETTE: ThemeColors = {
  ...getThemeColors("tokyo"),
  bg: "#0f2a2e",
  panel: "#123236",
  text: "#f0c674",
  textBright: "#ffe7b0",
  selectedText: "#ffe7b0",
  headerText: "#f0c674",
  neutral: "#5f7f80",
  positive: "#5fa8ff",
  negative: "#ff8c42",
};

const PALETTES: ReadonlyArray<readonly [string, ThemeColors]> = [
  ...getThemeIds().map((id) => [id, getThemeColors(id)] as const),
  ["custom", CUSTOM_PALETTE],
];

describe("heat map tile colors", () => {
  const MOVES = [-6, -3, -2, -1, -0.5, -0.1, 0, 0.1, 0.5, 1, 2, 3, 6];

  test("every tile, selected or not, keeps its text at 4.5:1 in every theme and a custom palette", () => {
    for (const [name, palette] of PALETTES) {
      for (const move of [...MOVES, null]) {
        for (const tile of [resolveHeatmapTileColors(move, palette), resolveHeatmapSelectedTileColors(move, palette)]) {
          expect(contrastRatio(tile.foreground, tile.background), `${name} ${move}`).toBeGreaterThanOrEqual(CELL_TEXT_MIN_CONTRAST);
        }
      }
    }
  });

  test("the strongest tiles are the theme's own down and up colours", () => {
    for (const [name, palette] of PALETTES) {
      expect(resolveHeatmapTileColors(-3, palette).background, name).toBe(palette.negative);
      expect(resolveHeatmapTileColors(3, palette).background, name).toBe(palette.positive);
    }
  });

  test("colour moves away from flat steadily with the size of the move and is full at 3%", () => {
    for (const [name, palette] of PALETTES) {
      const flat = resolveHeatmapTileColors(0, palette).background;
      for (const side of [-1, 1]) {
        const steps = [0.1, 0.3, 0.6, 1, 1.5, 2, 2.5, 3].map((move) => oklabDistance(resolveHeatmapTileColors(side * move, palette).background, flat));
        for (let index = 1; index < steps.length; index += 1) expect(steps[index]!, `${name} ${side}`).toBeGreaterThan(steps[index - 1]!);
        expect(resolveHeatmapTileColors(side * 6, palette).background).toBe(resolveHeatmapTileColors(side * 3, palette).background);
      }
    }
  });

  test("the flat middle stands off the page toward the text, and a missing move is a quieter grey", () => {
    for (const [name, palette] of PALETTES) {
      const flat = resolveHeatmapTileColors(0, palette).background;
      const missing = resolveHeatmapTileColors(null, palette).background;
      const dark = relativeLuminance(palette.text) > relativeLuminance(palette.bg);
      // Lighter than a dark page and darker than a light one, never a colour of its own.
      expect(relativeLuminance(flat) > relativeLuminance(palette.bg), name).toBe(dark);
      expect(chroma(flat), name).toBeLessThan(0.04);
      expect(chroma(missing), name).toBeLessThan(0.02);
      expect(oklabDistance(missing, flat), name).toBeGreaterThan(0.04);
      expect(contrastRatio(missing, palette.bg), name).toBeLessThan(contrastRatio(flat, palette.bg));
      expect(resolveHeatmapTileColors(Number.NaN, palette).background).toBe(missing);
    }
    expect(getThemeIds().some((id) => !isDarkTheme(id))).toBe(true);
  });

  test("the scale follows the palette's colours, not its name or a light or dark flag", () => {
    applyTheme("white");
    const white = resolveHeatmapTileColors(2).background;
    applyTheme("tokyo");
    // Both are dark themes: a light/dark cache would hand back the white theme's tile.
    expect(resolveHeatmapTileColors(2).background).not.toBe(white);
    expect(resolveHeatmapTileColors(2).background).toBe(resolveHeatmapTileColors(2, getThemeColors("tokyo")).background);

    const tokyo = getThemeColors("tokyo");
    const edited = { ...tokyo, positive: "#00b4d8" };
    expect(resolveHeatmapTileColors(2, edited).background).not.toBe(resolveHeatmapTileColors(2, tokyo).background);
    expect(resolveHeatmapTileColors(-2, edited).background).toBe(resolveHeatmapTileColors(-2, tokyo).background);
  });

  test("a palette whose up and down colours cannot carry the scale still separates gains from losses", () => {
    const base = getThemeColors(DEFAULT_THEME);
    for (const palette of [
      { ...base, positive: base.negative },
      { ...base, positive: "#7f7f7f", negative: "#808080" },
      { ...base, positive: base.bg },
      // A green so dark it would sink into the page: kept green, lifted clear of it.
      { ...base, positive: "#06301a" },
    ]) {
      const loss = resolveHeatmapTileColors(-3, palette).background;
      const gain = resolveHeatmapTileColors(3, palette).background;
      const flat = resolveHeatmapTileColors(0, palette).background;
      expect(oklabDistance(loss, gain)).toBeGreaterThan(0.15);
      expect(oklabDistance(gain, flat)).toBeGreaterThan(0.12);
      expect(oklabDistance(gain, palette.bg)).toBeGreaterThan(oklabDistance(flat, palette.bg));
    }
  });

  test("a selected tile stands out in every theme: the ring on any tile, the lifted colour from its neighbours", () => {
    for (const [name, palette] of PALETTES) {
      const ring = resolveHeatmapSelectionRing(palette);
      for (const move of [...MOVES, null]) {
        const tile = resolveHeatmapTileColors(move, palette).background;
        const ringContrast = Math.max(contrastRatio(ring.outer, tile), contrastRatio(ring.inner, tile));
        expect(ringContrast, `${name} ring ${move}`).toBeGreaterThanOrEqual(3);
        const selected = resolveHeatmapSelectedTileColors(move, palette).background;
        expect(oklabDistance(selected, tile), `${name} lift ${move}`).toBeGreaterThan(0.08);
        expect(oklabDistance(selected, palette.bg), `${name} lift ${move}`).toBeGreaterThan(0.1);
      }
    }
  });
});
