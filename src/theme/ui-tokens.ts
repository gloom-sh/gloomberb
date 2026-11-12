import { blendForContrast, blendHex, contrastRatio, higherContrast } from "./color-utils";
import { SUBTLE_TEXT_MIN, type Theme } from "./themes";

type Palette = Readonly<Omit<Theme, "name" | "description">>;

/**
 * The desktop and web design tokens: one type scale, two weights, one spacing
 * scale, the radii, one elevation and one hairline, and the colours the theme
 * names through roles rather than raw palette entries. docs/pane-conventions.md
 * ("Tokens") says which element takes which. styles.css defines the same
 * values as CSS variables (`--gloom-type-*`, `--gloom-space-*`,
 * `--gloom-radius-*`, `--gloom-elevation`, `--gloom-hairline` and the colour
 * roles below), so a component styles itself with `var(...)` and follows the
 * theme and FONT+ without counting pixels. The terminal draws in cells and
 * takes none of these.
 */

/** Type sizes in px at the default 12px app size; FONT+ scales them all. */
export const TYPE = {
  /** Key caps only. */
  caption: 10,
  /** Everything that is not reading text: chrome, tables, controls, tabs, footers, labels, metadata. */
  ui: 12,
  /** Reading text in a reader column. */
  body: 14,
  /** A heading in reading text (also set apart by weight, colour and space: 14 to 16 is a 14% step). */
  heading: 16,
  /** A reader's title. */
  title: 20,
} as const;

/** The two weights. */
export const WEIGHT = { regular: 400, bold: 700 } as const;

/** The spacing scale, in px. 8 is one cell, the pane's inset. */
export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Every radius in use: bars and tables, small marks (key caps, chips), controls, floating surfaces, dots. */
export const RADIUS = { none: 0, sm: 3, md: 6, lg: 8, full: 999 } as const;

/** The border of a control (button, field, select, checkbox) and of a floating surface. */
export function controlBorderColour(palette: Palette): string {
  return blendHex(palette.border, palette.borderFocused, 0.18);
}

/** Dialogs, menus, popovers, toasts, the command bar and cards: one surface above the panes. */
export function surfaceRaisedColour(palette: Palette): string {
  return blendHex(palette.panel, palette.bg, 0.12);
}

/** What a field is sunk into: the darkest surface of the theme. */
function surfaceSunkenColour(palette: Palette): string {
  return palette.bg;
}

/**
 * Placeholder text in every field, the command bar's prompt included: the
 * muted text, which a theme keeps at the subtle-text contrast against the page
 * and its panels. A field on a surface of its own (the header, the command
 * bar) passes that surface, and the colour is lifted only as far as it needs
 * to keep the same contrast there.
 */
export function placeholderColour(palette: Palette, surface: string = palette.bg): string {
  return blendForContrast(
    palette.textMuted,
    surface,
    higherContrast(palette.text, palette.textBright, surface),
    SUBTLE_TEXT_MIN,
  );
}

/** A row or control under the pointer: halfway from the background to the selection. */
export function hoverColour(palette: Palette): string {
  return blendHex(palette.bg, palette.selected, 0.5);
}

/**
 * The least contrast the inactive selection keeps with the page and with a
 * panel, either of which a list sits on: below it the row reads as a shadow
 * in a theme whose selection sits close to its background (high contrast,
 * blue, midnight).
 */
export const INACTIVE_SELECTION_MIN = 1.3;
/** The least contrast any text keeps on the inactive selection, tones and muted text included. */
export const INACTIVE_SELECTION_TEXT_MIN = 3;
/** How far from the panel toward the selection the inactive selection starts, steps and stops. */
const INACTIVE_SELECTION_BLEND = { from: 0.35, step: 0.01, to: 0.6 } as const;

const inactiveSelectionCache = new Map<string, string>();

/**
 * The chosen row of a list or table whose pane does not have the keyboard:
 * from a third of the way from the panel to the selection, as far on as it
 * takes to stand apart from the page and a panel (INACTIVE_SELECTION_MIN),
 * and never past 0.6, so the row still says where the cursor is without
 * reading as the one the keys move.
 */
export function inactiveSelectionColour(palette: Palette): string {
  const key = `${palette.panel}|${palette.bg}|${palette.selected}`;
  const cached = inactiveSelectionCache.get(key);
  if (cached) return cached;
  const { from, step, to } = INACTIVE_SELECTION_BLEND;
  let fill = blendHex(palette.panel, palette.selected, to);
  for (let ratio = from; ratio < to; ratio = Math.round((ratio + step) * 100) / 100) {
    const candidate = blendHex(palette.panel, palette.selected, ratio);
    if (contrastRatio(candidate, palette.bg) >= INACTIVE_SELECTION_MIN && contrastRatio(candidate, palette.panel) >= INACTIVE_SELECTION_MIN) {
      fill = candidate;
      break;
    }
  }
  if (inactiveSelectionCache.size > 64) inactiveSelectionCache.clear();
  inactiveSelectionCache.set(key, fill);
  return fill;
}

/**
 * A row's text colour on the inactive selection: as it is where it reads at
 * INACTIVE_SELECTION_TEXT_MIN, lifted toward black or white only as far as
 * it takes where it does not (a muted label, a theme's down tone).
 */
export function inactiveSelectionTextColour(color: string, palette: Palette): string {
  const fill = inactiveSelectionColour(palette);
  return blendForContrast(color, fill, higherContrast("#000000", "#ffffff", fill), INACTIVE_SELECTION_TEXT_MIN);
}

/**
 * The colour roles the palette names indirectly, as `--gloom-*` variables:
 * styles.css and inline styles read these, never a blend of their own.
 */
function roleColours(palette: Palette): Array<[string, string]> {
  return [
    ["--gloom-surface-raised", surfaceRaisedColour(palette)],
    ["--gloom-surface-sunken", surfaceSunkenColour(palette)],
    ["--gloom-control-border", controlBorderColour(palette)],
    ["--gloom-accent", palette.borderFocused],
    ["--gloom-link", palette.text],
    ["--gloom-link-hover", palette.textBright],
    ["--gloom-error", palette.negative],
    ["--gloom-locked", palette.textDim],
    ["--gloom-placeholder", placeholderColour(palette)],
  ];
}

/** A theme's own colours: the derived ones it may leave out (the tones in a selected row) are not variables. */
type PaletteColour = { [K in keyof Palette]-?: undefined extends Palette[K] ? never : K }[keyof Palette];

/** The palette entries styles.css reads as they are. */
const PALETTE_VARIABLES: Array<[PaletteColour, string]> = [
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

/** Every custom property a theme sets on the document root, which the desktop and web stylesheet draws with. */
export function themeCssVariables(palette: Palette): Array<[string, string]> {
  return [
    ...PALETTE_VARIABLES.map(([key, name]): [string, string] => [name, palette[key]]),
    ["--gloom-hover-bg", hoverColour(palette)],
    ...roleColours(palette),
  ];
}
