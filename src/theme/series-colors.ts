/** Colours for series told apart by name (compared tickers, markets). */
export const SERIES_COLORS = [
  "#4dabf7",
  "#63e6be",
  "#f6c85f",
  "#b197fc",
  "#ff8787",
  "#ffa94d",
  "#74c0fc",
  "#e599f7",
  "#8ce99a",
  "#ffd43b",
] as const;

/**
 * Okabe-Ito on a dark page, ordered so the first slots, the ones most charts
 * use, sit furthest apart under deuteranopia, protanopia and tritanopia.
 */
const COLORBLIND_DARK_SERIES = ["#56b4e9", "#e69f00", "#f0e442", "#d55e00", "#009e73", "#cc79a7", "#0072b2"] as const;

/** The same family on a light page: yellow and sky blue fade into white, so ink and a dark ochre stand in. */
const COLORBLIND_LIGHT_SERIES = ["#0072b2", "#d55e00", "#009e73", "#1f2328", "#7a5c00", "#cc79a7"] as const;

const THEME_SERIES_COLORS: Readonly<Record<string, readonly string[]>> = {
  colorblind: COLORBLIND_DARK_SERIES,
  "colorblind-light": COLORBLIND_LIGHT_SERIES,
  "high-contrast": COLORBLIND_DARK_SERIES,
};

/** The theme's own palette for named series, or null where it draws them in `SERIES_COLORS`. */
export function themeSeriesColors(themeId: string): readonly string[] | null {
  return THEME_SERIES_COLORS[themeId] ?? null;
}

const DEFAULT_SLOT = new Map<string, number>(SERIES_COLORS.map((color, index) => [color, index]));

/**
 * A series colour as the theme draws it. A slot of the default palette moves
 * to the same slot of the theme's palette; any other colour, chosen on purpose
 * by a pane or a person, stays as it is.
 */
export function themedSeriesColor(color: string, themeId: string): string {
  const palette = THEME_SERIES_COLORS[themeId];
  const slot = palette ? DEFAULT_SLOT.get(color.toLowerCase()) : undefined;
  return slot === undefined ? color : palette![slot % palette!.length]!;
}
