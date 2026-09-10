import { DEFAULT_THEME, getTheme, type Theme } from "./schemes";
import { DEFAULT_STYLE, getStyle, hasStyle, type StyleSpec } from "./styles";
import type { GlyphSet } from "./glyphs";
import {
  ASSIST_ACCENT,
  resolveTheme,
  resolveTokensForPalette,
  type CommandBarBadgeTone,
  type ResolvedTheme,
  type ThemeTokens,
} from "./tokens";

export type ThemeColors = Readonly<Omit<Theme, "name" | "description">>;
export type { CommandBarBadgeTone };

export function getThemeColors(id: string): ThemeColors {
  return resolveTheme(id, currentStyleId).palette;
}

let currentResolved: ResolvedTheme = resolveTheme(DEFAULT_THEME, DEFAULT_STYLE);
let currentThemeId = DEFAULT_THEME;
let currentStyleId = DEFAULT_STYLE;

/** Compatibility facade for non-React formatting and rendering helpers. */
export const colors = new Proxy({ ...currentResolved.palette } as ThemeColors, {
  get: (_target, property) => currentResolved.palette[property as keyof ThemeColors],
  getOwnPropertyDescriptor: (_target, property) => ({
    configurable: true,
    enumerable: true,
    value: currentResolved.palette[property as keyof ThemeColors],
  }),
}) as ThemeColors;

/**
 * The resolved semantic tokens for the active theme, in the same shape as
 * `colors`: a live view, so a module-scope reference keeps working across a
 * theme switch. React code should prefer `useThemeTokens()`.
 */
export const tokens = new Proxy({} as ThemeTokens, {
  get: (_target, property) => currentResolved.tokens[property as keyof ThemeTokens],
  ownKeys: () => Reflect.ownKeys(currentResolved.tokens),
  getOwnPropertyDescriptor: (_target, property) => ({
    configurable: true,
    enumerable: true,
    value: currentResolved.tokens[property as keyof ThemeTokens],
  }),
}) as ThemeTokens;

/** Live view of the active style's glyph table, for non-React call sites. */
export const glyphs = new Proxy({} as GlyphSet, {
  get: (_target, property) => currentResolved.glyphs[property as keyof GlyphSet],
  ownKeys: () => Reflect.ownKeys(currentResolved.glyphs),
  getOwnPropertyDescriptor: (_target, property) => ({
    configurable: true,
    enumerable: true,
    value: currentResolved.glyphs[property as keyof GlyphSet],
  }),
}) as GlyphSet;

type ColorKey = keyof ThemeColors;

let transientPreviewKey: string | null = null;
let cssThemeKey: string | null = null;
let cssThemeDocument: unknown = null;

const THEME_CSS_VARIABLES: Array<[ColorKey, string]> = [
  ["bg", "--gloom-bg"],
  ["panel", "--gloom-panel"],
  ["border", "--gloom-border"],
  ["borderFocused", "--gloom-border-focused"],
  ["text", "--gloom-text"],
  ["textDim", "--gloom-text-dim"],
  ["textBright", "--gloom-text-bright"],
  ["textMuted", "--gloom-text-muted"],
  ["positive", "--gloom-positive"],
  ["negative", "--gloom-negative"],
  ["neutral", "--gloom-neutral"],
  ["warning", "--gloom-warning"],
  ["header", "--gloom-header"],
  ["headerText", "--gloom-header-text"],
  ["selected", "--gloom-selected"],
  ["selectedText", "--gloom-selected-text"],
  ["commandBg", "--gloom-command-bg"],
  ["commandBorder", "--gloom-command-border"],
];

export function getCurrentThemeId(): string {
  return currentThemeId;
}

export function getCurrentStyleId(): string {
  return currentStyleId;
}

export function getCurrentStyle(): StyleSpec {
  return currentResolved.style;
}

export function getResolvedTheme(): ResolvedTheme {
  return currentResolved;
}

/** Resolved theme for an explicit pair, without touching the active one. */
export function getResolvedThemeFor(themeId: string, styleId?: string): ResolvedTheme {
  return resolveTheme(themeId, styleId ?? currentStyleId);
}

export function applyTheme(id: string, styleId?: string): void {
  currentThemeId = id;
  if (styleId != null && hasStyle(styleId)) currentStyleId = styleId;
  currentResolved = resolveTheme(currentThemeId, currentStyleId);
  syncThemeCssVariables();
}

/** Swaps the structural half only, keeping the palette. */
export function applyThemeStyle(styleId: string): void {
  applyTheme(currentThemeId, styleId);
}

export function previewTheme(id: string, styleId?: string): void {
  transientPreviewKey = `${styleId ?? currentStyleId}:${id}`;
  applyTheme(id, styleId);
}

export function clearTransientThemePreview(): void {
  transientPreviewKey = null;
}

export function syncTheme(id: string, styleId?: string): void {
  const nextStyleId = styleId != null && hasStyle(styleId) ? styleId : currentStyleId;
  const nextKey = `${nextStyleId}:${id}`;
  if (transientPreviewKey && currentResolved.id === transientPreviewKey && nextKey !== transientPreviewKey) {
    syncThemeCssVariables();
    return;
  }
  transientPreviewKey = null;
  if (currentResolved.id === nextKey) {
    syncThemeCssVariables();
    return;
  }
  applyTheme(id, nextStyleId);
}

export { blendHex } from "./color-utils";

/**
 * Tokens for a palette handed in by a caller. The active theme's tokens are
 * returned untouched for the common case, so the hot path is a lookup and only
 * an off-theme palette pays for a resolve.
 */
function tokensFor(palette: ThemeColors): ThemeTokens {
  if (palette === colors || palette === currentResolved.palette) return currentResolved.tokens;
  return resolveTokensForPalette(palette, currentStyleId);
}

export function getChartIndicatorColor(index: number, palette: ThemeColors = colors): string {
  const indicators = tokensFor(palette).chart.indicator;
  return indicators[((index % indicators.length) + indicators.length) % indicators.length]!;
}

/** Returns a hover background color derived from bg and selected */
export function hoverBg(palette: ThemeColors = colors): string {
  return tokensFor(palette).surface.hover;
}

function syncThemeCssVariables(): void {
  const documentLike = (globalThis as {
    document?: {
      documentElement?: {
        style?: { setProperty: (name: string, value: string) => void };
        setAttribute?: (name: string, value: string) => void;
      };
    };
  }).document;
  const element = documentLike?.documentElement;
  const style = element?.style;
  if (!style) return;
  if (cssThemeKey === currentResolved.id && cssThemeDocument === documentLike) return;
  cssThemeKey = currentResolved.id;
  cssThemeDocument = documentLike;
  for (const [key, name] of THEME_CSS_VARIABLES) {
    style.setProperty(name, currentResolved.palette[key]);
  }
  for (const [name, value] of themeCssVariables(currentResolved)) {
    style.setProperty(name, value);
  }
  element?.setAttribute?.("data-gloom-style", currentResolved.styleId);
  element?.setAttribute?.("data-gloom-scheme", currentResolved.schemeId);
  element?.setAttribute?.("data-gloom-appearance", currentResolved.dark ? "dark" : "light");
}

const SHADOW_RECIPES = {
  none: { floating: "none", popover: "none" },
  soft: {
    floating: "0 18px 38px color-mix(in srgb, var(--gloom-bg) 46%, transparent)",
    popover: "0 14px 34px color-mix(in srgb, var(--gloom-bg) 42%, transparent)",
  },
  hard: {
    floating: "3px 3px 0 var(--gloom-border)",
    popover: "2px 2px 0 var(--gloom-border)",
  },
} as const;

/**
 * The non-colour half of the DOM contract. Everything the stylesheet used to
 * hard-code as a literal now comes from here, so a style changes the material
 * of the app without touching CSS.
 */
export function themeCssVariables(resolved: ResolvedTheme = currentResolved): Array<[string, string]> {
  const { style, tokens: themeTokens } = resolved;
  const shadow = SHADOW_RECIPES[style.effects.shadow];
  const radius = style.effects.radius;
  return [
    ["--gloom-hover-bg", themeTokens.surface.hover],
    ["--gloom-radius-pane", `${radius}px`],
    ["--gloom-radius-control", `${Math.max(0, Math.round(radius * 0.6))}px`],
    ["--gloom-shadow-floating", shadow.floating],
    ["--gloom-shadow-popover", shadow.popover],
    ["--gloom-font-ui", style.typography.ui],
    ["--gloom-font-mono", style.typography.mono],
    ["--gloom-heading-weight", `${style.typography.headingWeight}`],
    ["--gloom-letter-spacing", style.typography.letterSpacing],
    ["--gloom-row-h", `calc(var(--cell-h) * ${themeTokens.pane.chrome.rowHeight})`],
    ["--gloom-pane-pad-x", `${themeTokens.pane.chrome.padding.x}`],
    ["--gloom-pane-pad-y", `${themeTokens.pane.chrome.padding.y}`],
    ["--gloom-transition", style.effects.transitions ? "120ms cubic-bezier(0.23, 1, 0.32, 1)" : "0ms linear"],
    ["--gloom-pane-border-width", themeTokens.pane.chrome.drawsBorder ? "1px" : "0px"],
    ["--gloom-table-stripe", themeTokens.table.row.stripe ?? "transparent"],
  ];
}

export function commandBarBg(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.bg;
}

export function commandBarPanelBg(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.panelBg;
}

export function commandBarInputBg(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.inputBg;
}

export function commandBarSelectedBg(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.selectedBg;
}

export function commandBarHoverBg(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.hoverBg;
}

export function commandBarText(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.text;
}

export function commandBarHeadingText(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.headingText;
}

export function commandBarSubtleText(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.subtleText;
}

/**
 * Accent for the command bar's AI section. No scheme ships a violet token, so
 * the hue is fixed, and only darkened or lightened until it clears the
 * subtle-text contrast floor on both command bar surfaces.
 */
export function commandBarAccentText(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.accentText;
}

/** Matched terms inside a result row's snippet, legible on the selected row too. */
export function commandBarMatchText(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.matchText;
}

/** One hue per result family so commands, instruments, documents and AI answers scan apart. */
export function commandBarBadgeText(tone: CommandBarBadgeTone, palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.badge[tone];
}

export function commandBarSelectedText(palette: ThemeColors = colors): string {
  return tokensFor(palette).commandBar.selectedText;
}

/** Background for docked pane bodies */
export function paneBg(focused: boolean, palette: ThemeColors = colors): string {
  return tokensFor(palette).pane.body.bg[focused ? "focused" : "idle"];
}

/** Background for floating pane bodies, elevated above docked panes */
export function floatingPaneBg(focused: boolean, palette: ThemeColors = colors): string {
  return tokensFor(palette).pane.floatingBody.bg[focused ? "focused" : "idle"];
}

/** Background for pane title bars */
export function paneTitleBg(focused: boolean, palette: ThemeColors = colors): string {
  return tokensFor(palette).pane.title.bg[focused ? "focused" : "idle"];
}

/** Background for floating pane title bars */
export function floatingPaneTitleBg(focused: boolean, palette: ThemeColors = colors): string {
  return tokensFor(palette).pane.title.floatingBg[focused ? "focused" : "idle"];
}

/** Title text color for panes */
export function paneTitleText(focused: boolean, floating = false, palette: ThemeColors = colors): string {
  const title = tokensFor(palette).pane.title;
  const state = focused ? "focused" : "idle";
  return floating ? title.floatingText[state] : title.text[state];
}

/** Returns green for positive, red for negative, neutral for zero */
export function priceColor(value: number, palette: ThemeColors = colors): string {
  if (value > 0) return palette.positive;
  if (value < 0) return palette.negative;
  return palette.neutral;
}

export { ASSIST_ACCENT, getStyle, DEFAULT_STYLE };
export type { ResolvedTheme, StyleSpec, ThemeTokens, GlyphSet };
