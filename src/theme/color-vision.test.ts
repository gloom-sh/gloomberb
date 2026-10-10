import { afterEach, describe, expect, test } from "bun:test";
import { applyTheme, getThemeColors } from "./colors";
import { contrastRatio } from "./color-utils";
import { hexToOklab, resolveHeatCellColors, resolveHeatmapTileColors } from "./heat-colors";
import { themeSeriesColors } from "./series-colors";
import { DEFAULT_THEME, listThemes } from "./themes";

/**
 * Machado, Oliveira and Fernandes (2009) at full severity, applied in linear
 * sRGB: how each colour looks to someone with no working L, M or S cones.
 */
const DEFICIENCIES = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
} as const;
type Vision = keyof typeof DEFICIENCIES | "typical";
const VISIONS: readonly Vision[] = ["typical", "protanopia", "deuteranopia", "tritanopia"];

/** Distance in OKLab; about 0.02 is the smallest step anyone notices. */
const UP_DOWN_MIN = 0.15;
const WARNING_MIN = 0.06;
const SERIES_MIN = 0.07;
const SERIES_ON_PAGE_MIN = 3;
const HEAT_ENDS_MIN = 0.15;
const AAA = 7;

const toLinear = (channel: number) => {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};
const toChannel = (linear: number) => {
  const value = Math.max(0, Math.min(1, linear));
  return Math.round((value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055) * 255);
};

function simulate(hex: string, vision: Vision): string {
  if (vision === "typical") return hex;
  const rgb = [1, 3, 5].map((offset) => toLinear(parseInt(hex.slice(offset, offset + 2), 16)));
  return `#${DEFICIENCIES[vision].map((row) => (
    toChannel(row[0] * rgb[0]! + row[1] * rgb[1]! + row[2] * rgb[2]!).toString(16).padStart(2, "0")
  )).join("")}`;
}

/** The smallest distance between two colours across typical vision and the three deficiencies. */
function seenApart(left: string, right: string): number {
  return Math.min(...VISIONS.map((vision) => {
    const [a, b] = [hexToOklab(simulate(left, vision)), hexToOklab(simulate(right, vision))];
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }));
}

function expectApart(themeId: string, label: string, left: string, right: string, minimum: number): void {
  const distance = seenApart(left, right);
  if (distance < minimum) {
    throw new Error(`${themeId} ${label} (${left} vs ${right}) sit ${distance.toFixed(3)} apart for some colour vision, below ${minimum}`);
  }
}

const SAFE_THEMES = listThemes().filter((theme) => theme.traits.includes("colorblind-safe")).map((theme) => theme.id);

afterEach(() => {
  applyTheme(DEFAULT_THEME);
});

describe("colour-blind safe themes", () => {
  test("the check tells the classic red and green apart from a safe pair", () => {
    // The default theme's up and down nearly merge for deuteranopia; that is why these themes exist.
    const classic = getThemeColors(DEFAULT_THEME);
    expect(seenApart(classic.positive, classic.negative)).toBeLessThan(UP_DOWN_MIN);
    expect(SAFE_THEMES).toEqual(["colorblind", "colorblind-light", "high-contrast"]);
  });

  test("keep up, down and warning apart for every colour vision", () => {
    for (const id of SAFE_THEMES) {
      const palette = getThemeColors(id);
      expectApart(id, "positive/negative", palette.positive, palette.negative, UP_DOWN_MIN);
      expectApart(id, "warning/positive", palette.warning, palette.positive, WARNING_MIN);
      expectApart(id, "warning/negative", palette.warning, palette.negative, WARNING_MIN);
      for (const role of ["positive", "negative", "warning"] as const) {
        expectApart(id, `${role}/neutral`, palette[role], palette.neutral, WARNING_MIN);
      }
    }
  });

  test("keep every pair of chart series colours apart, and each one off the page", () => {
    for (const id of SAFE_THEMES) {
      const series = themeSeriesColors(id);
      const { bg } = getThemeColors(id);
      expect(series?.length).toBeGreaterThanOrEqual(6);
      series!.forEach((color, index) => {
        expect(contrastRatio(color, bg)).toBeGreaterThanOrEqual(SERIES_ON_PAGE_MIN);
        for (const other of series!.slice(index + 1)) expectApart(id, "series", color, other, SERIES_MIN);
      });
    }
  });

  test("keep the heat map and correlation scales diverging for every colour vision", () => {
    for (const id of SAFE_THEMES) {
      const palette = getThemeColors(id);
      for (const move of [3, 1.5]) {
        const gain = resolveHeatmapTileColors(move, palette).background;
        const loss = resolveHeatmapTileColors(-move, palette).background;
        const flat = resolveHeatmapTileColors(0, palette).background;
        expectApart(id, `heat +/-${move}%`, gain, loss, move === 3 ? HEAT_ENDS_MIN : WARNING_MIN);
        expectApart(id, `heat +${move}%/flat`, gain, flat, WARNING_MIN);
        expectApart(id, `heat -${move}%/flat`, loss, flat, WARNING_MIN);
      }
      applyTheme(id);
      expectApart(id, "correlation +/-1", resolveHeatCellColors(1).background, resolveHeatCellColors(-1).background, WARNING_MIN);
    }
  });

  test("high contrast keeps every text role at AAA on the page", () => {
    const palette = getThemeColors("high-contrast");
    for (const role of ["text", "textDim", "textMuted", "textBright", "positive", "negative", "neutral", "warning"] as const) {
      for (const surface of [palette.bg, palette.panel]) {
        expect(contrastRatio(palette[role], surface)).toBeGreaterThanOrEqual(AAA);
      }
    }
    expect(contrastRatio(palette.selectedText, palette.selected)).toBeGreaterThanOrEqual(AAA);
    expect(contrastRatio(palette.headerText, palette.header)).toBeGreaterThanOrEqual(AAA);
  });
});
