import { blendHex } from "./color-utils";
import type { Theme } from "./themes";

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

/** A row or control under the pointer: halfway from the background to the selection. */
export function hoverColour(palette: Palette): string {
  return blendHex(palette.bg, palette.selected, 0.5);
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
  ];
}

/** The palette entries styles.css reads as they are. */
const PALETTE_VARIABLES: Array<[keyof Palette, string]> = [
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
