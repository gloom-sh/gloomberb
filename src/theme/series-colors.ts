import { blendForContrastOnSurfaces } from "./color-utils";
import { getCurrentThemeId } from "./colors";
import { getTheme, SUBTLE_TEXT_MIN } from "./themes";

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

const setCache = new WeakMap<object, Map<string, Readonly<Record<string, string>>>>();

/**
 * Named colours that sit side by side in one view (a supply chain's roles), as
 * a theme draws them: each the theme's own slot (`themedSeriesColor`), a slot
 * that a theme's shorter palette wraps onto a colour already in the set taking
 * the palette's next free one, and each pushed toward the theme's text only
 * as far as reading it on the page takes, as the theme's gains and losses are.
 * A pastel slot on a light page reads as its darker shade, never as a wash.
 */
export function themedColorSet<K extends string>(slots: Readonly<Record<K, string>>, themeId: string): Readonly<Record<K, string>> {
  let byTheme = setCache.get(slots);
  if (!byTheme) setCache.set(slots, byTheme = new Map());
  const cached = byTheme.get(themeId);
  if (cached) return cached as Readonly<Record<K, string>>;
  const theme = getTheme(themeId);
  const palette = THEME_SERIES_COLORS[themeId];
  const used = new Set<string>();
  const set = Object.fromEntries((Object.entries(slots) as [K, string][]).map(([name, color]) => {
    let themed = themedSeriesColor(color, themeId);
    if (palette && used.has(themed)) themed = palette.find((candidate) => !used.has(candidate)) ?? themed;
    used.add(themed);
    return [name, blendForContrastOnSurfaces(themed, [theme.bg, theme.panel], theme.text, SUBTLE_TEXT_MIN)];
  })) as Record<K, string>;
  byTheme.set(themeId, set);
  return set;
}

/** `themedColorSet` in whichever theme is drawing, read when a colour is: the same facade as `colors`. */
export function currentThemeColorSet<K extends string>(slots: Readonly<Record<K, string>>): Readonly<Record<K, string>> {
  return new Proxy(slots, {
    get: (_target, key) => themedColorSet(slots, getCurrentThemeId())[key as K],
    getOwnPropertyDescriptor: (_target, key) => ({
      configurable: true,
      enumerable: true,
      value: themedColorSet(slots, getCurrentThemeId())[key as K],
    }),
  }) as Readonly<Record<K, string>>;
}
