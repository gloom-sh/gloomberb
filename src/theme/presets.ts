import { getScheme, getSchemeIds, hasScheme, isDarkTheme } from "./schemes";
import { DEFAULT_STYLE, getStyle, getStyleIds, hasAnyStyle, hasStyle } from "./styles";

/**
 * The curated pairings. A scheme and a style compose freely, but most of the
 * 23 x 5 grid is noise, so the picker ships a shortlist where the palette and
 * the structure were chosen together. Anything outside the list is still
 * reachable: `colors` swaps the scheme under whatever style is active.
 */
export interface ThemePreset {
  id: string;
  styleId: string;
  schemeId: string;
}

const PRESET_PAIRS: Array<[styleId: string, schemeId: string]> = [
  ["terminal", "amber"],
  ["terminal", "nord"],
  ["terminal", "tokyo"],
  ["terminal", "gruvbox"],
  ["terminal", "github-light"],
  ["phosphor", "amber"],
  ["phosphor", "green"],
  ["phosphor", "cyan"],
  ["modern", "catppuccin"],
  ["modern", "midnight"],
  ["modern", "nord-light"],
  ["paper", "paper"],
  ["paper", "solarized-light"],
  ["minimal", "rosepine"],
  ["minimal", "white"],
];

/**
 * While only one style ships, a theme is a scheme again, so the shortlist is
 * every scheme under the default style. That is the flat list the picker has
 * always shown. As soon as a second style stops being experimental the
 * curated pairings take over on their own.
 */
function resolvePresetPairs(): Array<[string, string]> {
  const stable = getStyleIds();
  if (stable.length <= 1) {
    const styleId = stable[0] ?? DEFAULT_STYLE;
    return getSchemeIds().map((schemeId) => [styleId, schemeId]);
  }
  return PRESET_PAIRS.filter(([styleId]) => hasStyle(styleId));
}

export const presets: ThemePreset[] = resolvePresetPairs().map(([styleId, schemeId]) => ({
  id: `${styleId}-${schemeId}`,
  styleId,
  schemeId,
}));

/** True while a theme is just a scheme, so callers can drop the style column. */
export function stylesAreSelectable(): boolean {
  return getStyleIds().length > 1;
}

const presetsById = new Map(presets.map((preset) => [preset.id, preset]));

export const DEFAULT_PRESET = presets[0]!;

export function getPresets(): ThemePreset[] {
  return presets;
}

export function getPreset(id: string): ThemePreset | null {
  return presetsById.get(id) ?? null;
}

export function findPreset(styleId: string, schemeId: string): ThemePreset | null {
  return presets.find((preset) => preset.styleId === styleId && preset.schemeId === schemeId) ?? null;
}

export interface PresetLabels {
  /** "Modern", the structural half. */
  style: string;
  /** "Catppuccin", the palette half. */
  scheme: string;
  /** "Modern Catppuccin", for anywhere that needs one string. */
  full: string;
  description: string;
  dark: boolean;
}

export function presetLabels(preset: ThemePreset): PresetLabels {
  const style = getStyle(preset.styleId);
  const scheme = getScheme(preset.schemeId);
  return {
    style: style.name,
    scheme: scheme.name,
    full: `${style.name} ${scheme.name}`,
    description: style.description,
    dark: isDarkTheme(preset.schemeId),
  };
}

/**
 * Accepts a preset id, a bare scheme id from a config written before styles
 * existed, or a style id on its own. Returns the pair to apply.
 */
export function resolvePresetSelection(
  requested: string,
  fallbackStyleId: string = DEFAULT_STYLE,
): { styleId: string; schemeId: string } | null {
  const normalized = requested.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const preset = presetsById.get(normalized);
  if (preset) return { styleId: preset.styleId, schemeId: preset.schemeId };
  for (const candidate of presets) {
    if (`${getStyle(candidate.styleId).name} ${getScheme(candidate.schemeId).name}`.toLowerCase().replace(/\s+/g, "-") === normalized) {
      return { styleId: candidate.styleId, schemeId: candidate.schemeId };
    }
  }
  // A composite `<style>-<scheme>` still resolves even when the style is
  // experimental, which is how the shot CLI and GLOOMBERB_THEME_STYLE reach one
  // while it is being developed. Split at each hyphen because both halves may
  // contain one, as in `modern-nord-light`.
  for (let cut = normalized.indexOf("-"); cut > 0; cut = normalized.indexOf("-", cut + 1)) {
    const styleId = normalized.slice(0, cut);
    const schemeId = normalized.slice(cut + 1);
    if (hasAnyStyle(styleId) && hasScheme(schemeId)) return { styleId, schemeId };
  }
  // A bare scheme id keeps the caller's style, which is what a pre-styles
  // config value means. A name that is both, such as `paper`, is read as the
  // scheme unless its style is actually on offer.
  if (hasScheme(normalized)) return { styleId: fallbackStyleId, schemeId: normalized };
  if (hasStyle(normalized)) return { styleId: normalized, schemeId: "" };
  return { styleId: fallbackStyleId, schemeId: normalized };
}
