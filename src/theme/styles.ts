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
/**
 * How a pane title is treated.
 *
 * - `bar`: a tinted strip the title sits on. What the app has always drawn.
 * - `embedded`: the title is set into the top rule of a full box, the way a
 *   DOS or BBS screen framed its windows. Needs a border kind.
 * - `rule`: the title, then a rule running to the pane's right edge on the
 *   same row. A printed running head.
 * - `inverted`: the whole row in reverse video.
 * - `inline`: plain text, no fill. `plain` is the same on the DOM side but
 *   the terminal gives it a bold focused title.
 * - `underline`: a rule under the title only.
 */
export type PaneHeaderMode = "bar" | "embedded" | "rule" | "inverted" | "inline" | "underline" | "plain";
/**
 * How the focused pane is told apart.
 *
 * - `border`: only the focused pane draws a box. The terminal default.
 * - `frame`: every pane is boxed; the focused frame brightens.
 * - `header`: the title changes, the frame does not.
 * - `glow`: the body lifts and, on the DOM, a soft ring appears.
 * - `accent`: a mark at the pane's left edge, and the title brightens.
 * - `invert`: reverse video on the header.
 */
export type FocusMode = "border" | "frame" | "header" | "glow" | "accent" | "invert";
export type Density = "compact" | "normal" | "comfortable";
/** `hairline` is a line too, blended most of the way into the background. */
export type SeparatorMode = "lines" | "hairline" | "whitespace";
/**
 * `flat` sits every pane on the app background. `raised` lifts each pane
 * onto a card above a darker (or on a light scheme, greyer) backdrop, so the
 * gutters between panes read as space rather than as lines.
 */
export type SurfaceMode = "flat" | "raised";
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
  surface: SurfaceMode;
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
  /**
   * Pixels between docked panes. The terminal always uses one cell; the DOM
   * can afford a wider gutter when the panes are cards that need air.
   */
  gutter: number;
  shadow: ShadowMode;
  scanlines: boolean;
  /** Darkened corners over the whole app, the way a tube's edges fall off. */
  vignette: boolean;
  glow: boolean;
  transitions: boolean;
}

export interface StyleSpec {
  id: string;
  name: string;
  description: string;
  /**
   * Defined and tested, but not offered to users. A style being worked on
   * can sit here without reaching the picker or being accepted from a config
   * file; opt in for development with GLOOMBERB_THEME_STYLE=<id>. No style
   * is marked this way at the moment.
   */
  experimental?: boolean;
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

/**
 * The look the app has always had: the focused pane is boxed in a single
 * rule, every title sits on a tinted strip behind a `::` grip, and the rows
 * are as tight as the grid allows.
 */
const terminal: StyleSpec = {
  id: "terminal",
  name: "Terminal",
  description: "Boxed focus, title bars, tight rows",
  chrome: {
    paneBorder: "line",
    paneHeader: "bar",
    focus: "border",
    headerGrip: ":: ",
    headerCase: "as-is",
    density: "compact",
    separators: "lines",
    surface: "flat",
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
  effects: { radius: 0, gutter: 8, shadow: "none", scanlines: false, vignette: false, glow: false, transitions: true },
};

/**
 * A monitor from the era the product is named after. Every pane is a
 * double-ruled box with its title set into the top rule in capitals, the way
 * a DOS screen framed its windows; focus brightens the frame and reverses
 * the title. Table headers are reverse video too, the only emphasis a tube
 * had besides brightness. On the DOM the type blooms a little, the corners
 * fall off, and faint scanlines cross the glass. Nothing moves.
 */
const phosphor: StyleSpec = {
  id: "phosphor",
  name: "Phosphor",
  description: "Double-ruled frames, capitals in the rule, a lit tube",
  chrome: {
    paneBorder: "double",
    paneHeader: "embedded",
    focus: "frame",
    headerGrip: "",
    headerCase: "upper",
    density: "compact",
    // The frames already separate the panes; a line in the gutter as well
    // would be three rules where one screen needs two.
    separators: "whitespace",
    surface: "flat",
  },
  content: {
    rowHeight: 1,
    columnGap: 1,
    padX: 1,
    sectionGap: 1,
    table: { header: "inverted", rowRule: false, stripe: false },
    headings: "caps",
    scale: "flat",
  },
  glyphs: "unicode",
  charts: { candles: "ohlc", grid: "lines" },
  typography: { ui: MONO_STACK, mono: MONO_STACK, headingWeight: 700, letterSpacing: "0.06em" },
  effects: { radius: 0, gutter: 6, shadow: "none", scanlines: true, vignette: true, glow: true, transitions: false },
};

/**
 * The look of a current terminal tool: every pane in a rounded single-rule
 * frame with its title set into the top edge, the focused frame in the
 * accent colour and the rest kept quiet. A cell of padding inside each frame,
 * whitespace between them. On the DOM the frames are real rounded borders
 * and nothing casts a shadow.
 */
const rounded: StyleSpec = {
  id: "rounded",
  name: "Rounded",
  description: "Rounded frames on every pane, titles in the edge",
  chrome: {
    paneBorder: "rounded",
    paneHeader: "embedded",
    focus: "frame",
    headerGrip: "",
    headerCase: "as-is",
    density: "normal",
    separators: "whitespace",
    surface: "flat",
  },
  content: {
    rowHeight: 1,
    columnGap: 1,
    padX: 1,
    sectionGap: 1,
    table: { header: "plain", rowRule: false, stripe: false },
    headings: "bold",
    scale: "flat",
  },
  glyphs: "unicode",
  charts: { candles: "filled", grid: "dots" },
  typography: { ui: MONO_STACK, mono: MONO_STACK, headingWeight: 700, letterSpacing: "0" },
  effects: { radius: 8, gutter: 6, shadow: "none", scanlines: false, vignette: false, glow: false, transitions: true },
};

/**
 * Panes as cards. Each one is a raised surface on a darker backdrop, with the
 * gutters left as space rather than drawn as lines, and the focused card
 * carries a soft accent ring. Rows keep the grid's height but columns and
 * padding get a second cell of air, labels are small capitals, and on the
 * DOM the UI is set in a sans face with rounded corners and a soft shadow.
 * Numbers stay monospace and tabular.
 */
const modern: StyleSpec = {
  id: "modern",
  name: "Modern",
  description: "Cards on a backdrop, soft focus ring, roomy columns",
  chrome: {
    paneBorder: "none",
    paneHeader: "plain",
    focus: "glow",
    headerGrip: "",
    headerCase: "as-is",
    density: "comfortable",
    separators: "whitespace",
    surface: "raised",
  },
  content: {
    rowHeight: 1,
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
  effects: { radius: 10, gutter: 12, shadow: "soft", scanlines: false, vignette: false, glow: true, transitions: true },
};

/**
 * A printed page. Every title is a running head: the words, then a rule to
 * the edge of the column. Focus turns the head and its rule to the accent
 * ink. Tables rule under the header and, on the DOM, under every row, so the
 * eye follows a line across rather than a stripe. Headings are small
 * capitals, set in a serif on the DOM, and a floating pane casts the hard
 * offset shadow of a card laid on a desk. Made for the light schemes, though
 * it holds up on the dark ones.
 */
const paper: StyleSpec = {
  id: "paper",
  name: "Paper",
  description: "Running heads, hairline rules, a printed page",
  chrome: {
    paneBorder: "line",
    paneHeader: "rule",
    focus: "header",
    headerGrip: "",
    headerCase: "as-is",
    density: "normal",
    separators: "hairline",
    surface: "flat",
  },
  content: {
    rowHeight: 1,
    columnGap: 2,
    padX: 1,
    sectionGap: 1,
    table: { header: "underline", rowRule: true, stripe: false },
    headings: "caps",
    scale: "subtle",
  },
  glyphs: "unicode",
  charts: { candles: "hollow", grid: "lines" },
  typography: { ui: SERIF_STACK, mono: MONO_STACK, headingWeight: 600, letterSpacing: "0.02em" },
  effects: { radius: 2, gutter: 8, shadow: "hard", scanlines: false, vignette: false, glow: false, transitions: true },
};

/**
 * As little as the grid allows. No frames, no fills, hairline gutters. A
 * pane is its title, set as a quiet label, and the focused one is marked by
 * an accent at its left edge and nothing else. Table headers sit on the body
 * with no plate under them. The DOM sets UI text in a sans face and draws no
 * radius or shadow anywhere.
 */
const minimal: StyleSpec = {
  id: "minimal",
  name: "Minimal",
  description: "No frames, hairline gutters, an accent mark for focus",
  chrome: {
    paneBorder: "none",
    paneHeader: "inline",
    focus: "accent",
    headerGrip: "",
    headerCase: "as-is",
    density: "normal",
    separators: "hairline",
    surface: "flat",
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
  effects: { radius: 0, gutter: 8, shadow: "none", scanlines: false, vignette: false, glow: false, transitions: true },
};

/** In the order the picker lists them: the default first, then by feel. */
export const styles: Record<string, StyleSpec> = {
  terminal,
  phosphor,
  rounded,
  modern,
  paper,
  minimal,
};

export const DEFAULT_STYLE = "terminal";

/**
 * The styles the product offers. Everything user-facing reads this, so the
 * pickers, the presets and config normalisation all light up on their own the
 * day a style stops being experimental.
 */
export function getStyleIds(): string[] {
  return Object.keys(styles).filter((id) => !styles[id]!.experimental);
}

/** Every defined style, experimental ones included. For tests and tooling. */
export function getAllStyleIds(): string[] {
  return Object.keys(styles);
}

/** True for a style the product offers. */
export function hasStyle(id: string): boolean {
  return Object.hasOwn(styles, id) && !styles[id]!.experimental;
}

/** True for any defined style, so `resolveTheme` can still build one. */
export function hasAnyStyle(id: string): boolean {
  return Object.hasOwn(styles, id);
}

/**
 * The style an explicit opt-in asks for, or null. Reading the environment here
 * keeps the gate in one place instead of spread across config and renderers.
 */
export function requestedExperimentalStyle(): string | null {
  const requested = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env?.GLOOMBERB_THEME_STYLE?.trim();
  return requested && hasAnyStyle(requested) ? requested : null;
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


