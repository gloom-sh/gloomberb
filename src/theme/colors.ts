import { blendForContrast, blendForContrastOnSurfaces, blendHex, higherContrast } from "./color-utils";
import { getTheme, DEFAULT_THEME, type Theme } from "./themes";
import { hoverColour, themeCssVariables } from "./ui-tokens";

export type ThemeColors = Readonly<Omit<Theme, "name" | "description">>;

export function getThemeColors(id: string): ThemeColors {
  const { name: _name, description: _description, ...palette } = getTheme(id);
  return Object.freeze(palette);
}

/** Soft violet the AI section is tinted with, before per-theme contrast fixup. */
const ASSIST_ACCENT = "#a877ff";

let currentColors = getThemeColors(DEFAULT_THEME);

/** Compatibility facade for non-React formatting and rendering helpers. */
export const colors = new Proxy({ ...currentColors } as ThemeColors, {
  get: (_target, property) => currentColors[property as keyof ThemeColors],
  getOwnPropertyDescriptor: (_target, property) => ({
    configurable: true,
    enumerable: true,
    value: currentColors[property as keyof ThemeColors],
  }),
}) as ThemeColors;

let currentThemeId = DEFAULT_THEME;
let transientPreviewThemeId: string | null = null;
let cssThemeId: string | null = null;
let cssThemeDocument: unknown = null;

export function getCurrentThemeId(): string {
  return currentThemeId;
}

export function applyTheme(id: string): void {
  currentThemeId = id;
  currentColors = getThemeColors(id);
  syncThemeCssVariables();
}

export function previewTheme(id: string): void {
  transientPreviewThemeId = id;
  applyTheme(id);
}

export function clearTransientThemePreview(): void {
  transientPreviewThemeId = null;
}

export function syncTheme(id: string): void {
  if (
    transientPreviewThemeId
    && currentThemeId === transientPreviewThemeId
    && id !== transientPreviewThemeId
  ) {
    syncThemeCssVariables();
    return;
  }
  transientPreviewThemeId = null;
  if (currentThemeId === id) {
    syncThemeCssVariables();
    return;
  }
  applyTheme(id);
}

export { blendHex } from "./color-utils";

export function getChartIndicatorColor(index: number): string {
  const accent = higherContrast(colors.warning, colors.borderFocused, colors.bg);
  const indicatorColors = [
    colors.warning,
    blendHex(colors.borderFocused, colors.warning, 0.38),
    blendHex(colors.warning, colors.textBright, 0.42),
    blendHex(colors.borderFocused, colors.textBright, 0.38),
    colors.neutral,
    blendHex(colors.warning, colors.neutral, 0.52),
    blendHex(colors.borderFocused, colors.neutral, 0.46),
  ];
  const candidate = indicatorColors[((index % indicatorColors.length) + indicatorColors.length) % indicatorColors.length]!;
  const color = blendForContrast(
    candidate,
    colors.bg,
    higherContrast(accent, colors.textBright, colors.bg),
    3.6,
  );
  if (![colors.positive, colors.negative, colors.text].includes(color)) return color;
  return blendForContrast(blendHex(color, accent, 0.55), colors.bg, colors.textBright, 3.6);
}

/** Returns a hover background color derived from bg and selected */
export function hoverBg(palette: ThemeColors = colors): string {
  return hoverColour(palette);
}

/** Body-text contrast, which text on a hovered control keeps whatever the surface. */
const HOVER_TEXT_MIN_CONTRAST = 4.5;

/**
 * Text on a control under the pointer: the theme's bright text, which hovered
 * buttons and table actions light up to, pushed toward black or white only as
 * far as `surface` needs for it to stay readable. A chip tinted with its own
 * tone (a ticker's day move, a mention) is the case that needs it: a phosphor
 * theme's bright text is its own hue, and red on a green chip is not readable.
 */
export function hoverText(surface: string, palette: ThemeColors = colors): string {
  return blendForContrast(
    palette.textBright,
    surface,
    higherContrast("#ffffff", "#000000", surface),
    HOVER_TEXT_MIN_CONTRAST,
  );
}

function syncThemeCssVariables(): void {
  const documentLike = (globalThis as {
    document?: { documentElement?: { style?: { setProperty: (name: string, value: string) => void } } };
  }).document;
  const style = documentLike?.documentElement?.style;
  if (!style) return;
  if (cssThemeId === currentThemeId && cssThemeDocument === documentLike) return;
  cssThemeId = currentThemeId;
  cssThemeDocument = documentLike;
  for (const [name, value] of themeCssVariables(currentColors)) style.setProperty(name, value);
}

export function commandBarBg(palette: ThemeColors = colors): string {
  const base = higherContrast(palette.commandBg, palette.panel, palette.bg);
  const accent = higherContrast(palette.textBright, palette.borderFocused, base);
  return blendForContrast(base, palette.bg, accent, 1.45);
}

export function commandBarPanelBg(palette: ThemeColors = colors): string {
  return blendHex(commandBarBg(palette), palette.panel, 0.28);
}

export function commandBarInputBg(palette: ThemeColors = colors): string {
  return blendHex(commandBarPanelBg(palette), palette.bg, 0.22);
}

export function commandBarSelectedBg(palette: ThemeColors = colors): string {
  const base = commandBarBg(palette);
  const accent = higherContrast(palette.selectedText, palette.textBright, palette.selected);
  return blendForContrast(palette.selected, base, accent, 1.45);
}

export function commandBarHoverBg(palette: ThemeColors = colors): string {
  return blendHex(commandBarBg(palette), commandBarSelectedBg(palette), 0.45);
}

export function commandBarText(palette: ThemeColors = colors): string {
  const base = commandBarBg(palette);
  const fallback = higherContrast(palette.textBright, "#f2f2f2", base);
  return blendForContrast(palette.text, base, fallback, 5.4);
}

export function commandBarHeadingText(palette: ThemeColors = colors): string {
  const base = commandBarBg(palette);
  const fallback = higherContrast(
    higherContrast(palette.textDim, palette.text, base),
    higherContrast(palette.textBright, palette.selectedText, base),
    base,
  );
  return blendForContrast(palette.textMuted, base, fallback, 3.6);
}

export function commandBarSubtleText(palette: ThemeColors = colors): string {
  const base = commandBarBg(palette);
  const fallback = higherContrast(commandBarText(palette), "#d8d8d8", base);
  return blendForContrast(palette.textDim, base, fallback, 4.1);
}

/**
 * Accent for the command bar's AI section. No theme ships a violet token, so the
 * hue is fixed — that is the point, it has to read as "not one of your results"
 * on monochrome palettes too — and only darkened or lightened until it clears
 * the subtle-text contrast floor on both command bar surfaces.
 */
export function commandBarAccentText(palette: ThemeColors = colors): string {
  const surfaces = [commandBarBg(palette), commandBarPanelBg(palette)] as const;
  return blendForContrastOnSurfaces(
    ASSIST_ACCENT,
    surfaces,
    higherContrast("#000000", "#ffffff", surfaces[0]),
    3.6,
  );
}

/**
 * Matched terms inside a result row's snippet. It has to stay legible on the
 * selected row too, so contrast is checked against the selection background as
 * well as the two panel surfaces.
 */
export function commandBarMatchText(palette: ThemeColors = colors): string {
  const surfaces = [
    commandBarBg(palette),
    commandBarPanelBg(palette),
    commandBarSelectedBg(palette),
  ] as const;
  return blendForContrastOnSurfaces(
    palette.warning,
    surfaces,
    higherContrast("#ffffff", "#000000", surfaces[0]),
    3.6,
  );
}

export type CommandBarBadgeTone = "command" | "instrument" | "document" | "assist";

function commandBarBadgeHue(tone: CommandBarBadgeTone, palette: ThemeColors): string {
  if (tone === "instrument") return palette.warning;
  if (tone === "document") return palette.neutral;
  if (tone === "assist") return ASSIST_ACCENT;
  return palette.borderFocused;
}

/**
 * Text-only tag left of a result label. One hue per family so commands,
 * instruments, documents and AI answers scan apart without a filled box, pulled
 * towards the subtle text so the tag stays quieter than the label, then pushed
 * only until it clears every surface it can land on, the selected row included.
 */
export function commandBarBadgeText(tone: CommandBarBadgeTone, palette: ThemeColors = colors): string {
  const surfaces = [
    commandBarBg(palette),
    commandBarPanelBg(palette),
    commandBarHoverBg(palette),
    commandBarSelectedBg(palette),
  ] as const;
  const muted = blendHex(commandBarBadgeHue(tone, palette), commandBarSubtleText(palette), 0.4);
  return blendForContrastOnSurfaces(
    muted,
    surfaces,
    higherContrast("#ffffff", "#000000", surfaces[0]),
    3.6,
  );
}

export function commandBarSelectedText(palette: ThemeColors = colors): string {
  const base = commandBarSelectedBg(palette);
  const preferred = higherContrast(palette.selectedText, palette.text, base);
  const fallback = higherContrast(
    higherContrast(palette.textBright, palette.text, base),
    higherContrast("#ffffff", "#000000", base),
    base,
  );
  return blendForContrast(preferred, base, fallback, 4.5);
}

/** Background for docked pane bodies */
export function paneBg(focused: boolean, palette: ThemeColors = colors): string {
  if (focused) return blendHex(palette.bg, palette.borderFocused, 0.06);
  return blendHex(palette.panel, palette.border, 0.08);
}

/** Background for floating pane bodies — elevated above docked panes */
export function floatingPaneBg(focused: boolean, palette: ThemeColors = colors): string {
  if (focused) return blendHex(palette.bg, palette.borderFocused, 0.08);
  return blendHex(palette.panel, palette.border, 0.18);
}

/** Background for pane title bars */
export function paneTitleBg(focused: boolean, palette: ThemeColors = colors): string {
  if (focused) return blendHex(palette.bg, palette.borderFocused, 0.22);
  return blendHex(palette.panel, palette.border, 0.15);
}

/** Background for floating pane title bars */
export function floatingPaneTitleBg(focused: boolean, palette: ThemeColors = colors): string {
  if (focused) return blendHex(palette.bg, palette.borderFocused, 0.25);
  return blendHex(palette.panel, palette.border, 0.25);
}

/** Title text color for panes */
export function paneTitleText(focused: boolean, floating = false, palette: ThemeColors = colors): string {
  const background = floating ? floatingPaneTitleBg(focused, palette) : paneTitleBg(focused, palette);
  const preferred = focused
    ? higherContrast(palette.textBright, palette.headerText, background)
    : palette.textDim;
  const fallback = focused
    ? higherContrast(palette.text, "#f2f2f2", background)
    : higherContrast(palette.text, palette.textBright, background);
  return blendForContrast(preferred, background, fallback, focused ? 5.2 : 4.5);
}

/** Returns green for positive, red for negative, neutral for zero */
export function priceColor(value: number, palette: ThemeColors = colors): string {
  if (value > 0) return palette.positive;
  if (value < 0) return palette.negative;
  return palette.neutral;
}

const TONE_TINT = 0.18;

/**
 * The background a tone tints, such as a ticker badge in its day's move or a
 * price that moved since the user last looked. A `strength` under 1 lightens
 * it, for a tint on its way out.
 */
export function toneTintBg(tone: string, strength = 1, palette: ThemeColors = colors): string {
  return blendHex(palette.bg, tone, TONE_TINT * strength);
}
