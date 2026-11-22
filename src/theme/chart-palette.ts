import { blendForContrastOnSurfaces } from "./color-utils";
import { getTheme, SUBTLE_TEXT_MIN } from "./themes";

/**
 * The colours a person picks on a chart: a drawing's, a study's, a series'.
 * A pick is kept as one of these whatever the theme, and drawn through
 * `chartPaletteColor`, so it reads on every theme's page.
 */
export const CHART_PALETTE = ["#f5a524", "#4c9aff", "#33c481", "#ff5c7a", "#c084fc"] as const;

type ChartPaletteColor = (typeof CHART_PALETTE)[number];

const NAMES: Readonly<Record<ChartPaletteColor, string>> = {
  "#f5a524": "Orange",
  "#4c9aff": "Blue",
  "#33c481": "Green",
  "#ff5c7a": "Pink",
  "#c084fc": "Purple",
};

function isChartPaletteColor(color: string | undefined): color is ChartPaletteColor {
  return color !== undefined && Object.prototype.hasOwnProperty.call(NAMES, color);
}

/** What a control calls a colour: `Orange` for a palette one, any other by its hex. */
export function chartPaletteColorName(color: string): string {
  return isChartPaletteColor(color) ? NAMES[color] : color;
}

/**
 * A palette colour as `themeId` draws it: the same hue, moved toward the
 * theme's text only as far as reading it on the page and on a panel takes, so
 * a light page darkens the orange. Any other colour is returned as it is.
 */
export function chartPaletteColor(color: string, themeId: string): string {
  if (!isChartPaletteColor(color)) return color;
  const theme = getTheme(themeId);
  return blendForContrastOnSurfaces(color, [theme.bg, theme.panel], theme.text, SUBTLE_TEXT_MIN);
}

/**
 * The colour after `color` in the palette, back to the first after the last.
 * With `auto`, no colour (the theme's own) comes before the first and after
 * the last; a colour from outside the palette moves to the first either way.
 */
export function nextChartPaletteColor(color: string | undefined, auto: boolean): string | undefined {
  const next = (isChartPaletteColor(color) ? CHART_PALETTE.indexOf(color) : -1) + 1;
  if (next < CHART_PALETTE.length) return CHART_PALETTE[next];
  return auto ? undefined : CHART_PALETTE[0];
}
