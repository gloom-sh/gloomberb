/**
 * The structural half of a theme. A scheme says what the colours are; a style
 * says what the product is made of: whether panes have borders, how a title bar
 * is treated, how focus is signalled, how tight the grid is, which glyph
 * repertoire is safe, and (DOM only) the type and material of the surfaces.
 *
 * Everything in `chrome`, `glyphs` and `charts` has to be expressible in
 * terminal cells, because the TUI is the tier both hosts share. `typography`
 * and `effects` are additive: the DOM reads them, the terminal ignores them,
 * and no style is allowed to depend on them to stay coherent.
 *
 * The vocabulary is enumerated on purpose. A style picks from a fixed set of
 * recipes rather than supplying colours or pixel values, so a new style cannot
 * quietly break the contrast floors or the cell grid.
 */

export type PaneBorderKind = "none" | "line" | "double" | "rounded" | "heavy" | "ascii";
export type PaneHeaderMode = "bar" | "inverted" | "inline" | "underline" | "plain";
export type FocusMode = "border" | "header" | "glow" | "invert";
export type Density = "compact" | "normal" | "comfortable";
export type SeparatorMode = "lines" | "whitespace";
export type GlyphMode = "unicode" | "ascii" | "nerd";
export type CandleMode = "filled" | "hollow" | "ohlc";
export type ChartGridMode = "none" | "dots" | "lines";
export type ShadowMode = "none" | "soft" | "hard";
export type HeaderCase = "upper" | "as-is";
export type TableHeaderMode = "filled" | "inverted" | "underline" | "plain";
export type HeadingTreatment = "bold" | "caps" | "underline";
/** How far the DOM type sizes spread apart. The terminal is always flat. */
export type TypeScale = "flat" | "subtle" | "wide";

/**
 * The semantic roles content is set in. A pane says what a run of text *is*
 * and the style decides how it reads, which is what lets a style reach past
 * the pane frame into the numbers and labels that fill the screen.
 *
 * `numeric` is deliberately separate from `value`: a finance terminal aligns
 * columns on the digit, so numbers stay monospace and tabular in every style,
 * including the ones that set the rest of the UI in a proportional face.
 */
export type TypeRole = "display" | "heading" | "label" | "body" | "value" | "caption" | "numeric";

export interface StyleChrome {
  paneBorder: PaneBorderKind;
  paneHeader: PaneHeaderMode;
  focus: FocusMode;
  /** Prefix in front of a pane title. Empty is a legitimate answer. */
  headerGrip: string;
  headerCase: HeaderCase;
  density: Density;
  separators: SeparatorMode;
}

export interface StyleCharts {
  candles: CandleMode;
  grid: ChartGridMode;
}

/**
 * How a table treats its own structure. Separate from `chrome.separators`,
 * which governs the gaps between panes; this is the grid inside one.
 */
export interface StyleTable {
  header: TableHeaderMode;
  /**
   * A hairline under every body row. DOM only, and deliberately so: a rule is
   * thinner than a cell, and spending a whole terminal row on one would change
   * the density rather than decorate it. The terminal carries a table's
   * identity through the header treatment, striping and row height instead.
   */
  rowRule: boolean;
  /** Alternating row tint. Works in both renderers, being a fill not a line. */
  stripe: boolean;
}

/**
 * The content half of a style: the rhythm and emphasis of everything inside a
 * pane. All of it is expressed in cells or in text attributes, so the terminal
 * carries the whole decision and the DOM only adds size and face on top.
 */
export interface StyleContent {
  /** Row height in cells for lists and tables. */
  rowHeight: 1 | 2;
  /** Cells between table columns. */
  columnGap: 1 | 2;
  /** Cells of padding inside a content region. */
  padX: 1 | 2;
  /** Cells between one section and the next. */
  sectionGap: 1 | 2;
  table: StyleTable;
  headings: HeadingTreatment;
  scale: TypeScale;
}

/** DOM only. The terminal has one font and one cell, and ignores all of it. */
export interface StyleTypography {
  ui: string;
  mono: string;
  headingWeight: number;
  letterSpacing: string;
}

/** DOM only. Material, not layout: nothing here moves a cell boundary. */
export interface StyleEffects {
  radius: number;
  shadow: ShadowMode;
  scanlines: boolean;
  glow: boolean;
  transitions: boolean;
}

export interface StyleSpec {
  id: string;
  name: string;
  description: string;
  chrome: StyleChrome;
  content: StyleContent;
  glyphs: GlyphMode;
  charts: StyleCharts;
  typography: StyleTypography;
  effects: StyleEffects;
}

const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace';
const SANS_STACK = '"Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif';
const SERIF_STACK = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif';

const terminal: StyleSpec = {
  id: "terminal",
  name: "Terminal",
  description: "Line-boxed panes, title bars, tight rows",
  chrome: {
    paneBorder: "line",
    paneHeader: "bar",
    focus: "border",
    headerGrip: ":: ",
    headerCase: "as-is",
    density: "compact",
    separators: "lines",
  },
  content: {
    rowHeight: 1,
    columnGap: 1,
    padX: 1,
    sectionGap: 1,
    table: { header: "filled", rowRule: false, stripe: false },
    headings: "bold",
    scale: "flat",
  },
  glyphs: "unicode",
  charts: { candles: "filled", grid: "dots" },
  typography: { ui: MONO_STACK, mono: MONO_STACK, headingWeight: 700, letterSpacing: "0" },
  effects: { radius: 0, shadow: "none", scanlines: false, glow: false, transitions: true },
};

const phosphor: StyleSpec = {
  id: "phosphor",
  name: "Phosphor",
  description: "CRT revival: heavy rules, reversed caps, scanlines",
  chrome: {
    paneBorder: "heavy",
    paneHeader: "inverted",
    focus: "invert",
    headerGrip: "",
    headerCase: "upper",
    density: "compact",
    separators: "lines",
  },
  content: {
    rowHeight: 1,
    columnGap: 1,
    padX: 1,
    sectionGap: 1,
    // A CRT has one weight and one size, so emphasis is reverse video and caps.
    table: { header: "inverted", rowRule: false, stripe: false },
    headings: "caps",
    scale: "flat",
  },
  glyphs: "ascii",
  charts: { candles: "ohlc", grid: "lines" },
  typography: { ui: MONO_STACK, mono: MONO_STACK, headingWeight: 700, letterSpacing: "0.08em" },
  effects: { radius: 0, shadow: "none", scanlines: true, glow: true, transitions: false },
};

const modern: StyleSpec = {
  id: "modern",
  name: "Modern",
  description: "Borderless surfaces, whitespace separators, roomy rows",
  chrome: {
    paneBorder: "none",
    paneHeader: "plain",
    focus: "glow",
    headerGrip: "",
    headerCase: "as-is",
    density: "comfortable",
    separators: "whitespace",
  },
  content: {
    // Rows get a second cell of air, which is the whole point of the style and
    // also its cost: a positions table shows about half as many holdings.
    rowHeight: 2,
    columnGap: 2,
    padX: 2,
    sectionGap: 2,
    table: { header: "plain", rowRule: false, stripe: true },
    headings: "caps",
    scale: "wide",
  },
  glyphs: "unicode",
  charts: { candles: "hollow", grid: "none" },
  typography: { ui: SANS_STACK, mono: MONO_STACK, headingWeight: 600, letterSpacing: "0" },
  effects: { radius: 8, shadow: "soft", scanlines: false, glow: true, transitions: true },
};

const paper: StyleSpec = {
  id: "paper",
  name: "Paper",
  description: "Thin rules, underlined headings, printed shadows",
  chrome: {
    paneBorder: "line",
    paneHeader: "underline",
    focus: "header",
    headerGrip: "",
    headerCase: "as-is",
    density: "normal",
    separators: "lines",
  },
  content: {
    rowHeight: 1,
    columnGap: 2,
    padX: 1,
    sectionGap: 1,
    table: { header: "underline", rowRule: true, stripe: false },
    headings: "underline",
    scale: "subtle",
  },
  glyphs: "unicode",
  charts: { candles: "hollow", grid: "lines" },
  typography: { ui: SERIF_STACK, mono: MONO_STACK, headingWeight: 600, letterSpacing: "0.01em" },
  effects: { radius: 2, shadow: "hard", scanlines: false, glow: false, transitions: true },
};

const minimal: StyleSpec = {
  id: "minimal",
  name: "Minimal",
  description: "No chrome at all; the focused pane is the only marked one",
  chrome: {
    paneBorder: "none",
    paneHeader: "inline",
    focus: "header",
    headerGrip: "",
    headerCase: "as-is",
    density: "normal",
    separators: "whitespace",
  },
  content: {
    rowHeight: 1,
    columnGap: 2,
    padX: 1,
    sectionGap: 2,
    table: { header: "plain", rowRule: false, stripe: false },
    headings: "bold",
    scale: "subtle",
  },
  glyphs: "unicode",
  charts: { candles: "filled", grid: "none" },
  typography: { ui: SANS_STACK, mono: MONO_STACK, headingWeight: 600, letterSpacing: "0" },
  effects: { radius: 4, shadow: "none", scanlines: false, glow: false, transitions: true },
};

export const styles: Record<string, StyleSpec> = {
  terminal,
  phosphor,
  modern,
  paper,
  minimal,
};

export const DEFAULT_STYLE = "terminal";

export function getStyleIds(): string[] {
  return Object.keys(styles);
}

export function hasStyle(id: string): boolean {
  return Object.hasOwn(styles, id);
}

export function getStyle(id: string): StyleSpec {
  return styles[id] ?? styles[DEFAULT_STYLE]!;
}

/** Horizontal and vertical padding in cells, so density stays on the grid. */
export function densityPadding(density: Density): { x: number; y: number } {
  if (density === "compact") return { x: 1, y: 0 };
  if (density === "comfortable") return { x: 2, y: 1 };
  return { x: 1, y: 1 };
}


