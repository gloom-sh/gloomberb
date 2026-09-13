import {
  blendForContrast,
  blendForContrastOnSurfaces,
  blendHex,
  contrastRatio,
  higherContrast,
  relativeLuminance,
} from "./color-utils";
import { openTuiBorderStyle, resolveGlyphs, type GlyphSet } from "./glyphs";
import { DEFAULT_SCHEME, getScheme, type Theme } from "./schemes";
import {
  DEFAULT_STYLE,
  densityPadding,
  getStyle,
  type Density,
  type FocusMode,
  type PaneBorderKind,
  type PaneHeaderMode,
  type SeparatorMode,
  type StyleSpec,
  type SurfaceMode,
  type TableHeaderMode,
  type TypeRole,
} from "./styles";

export type ThemePalette = Readonly<Omit<Theme, "name" | "description">>;

/** Soft violet the AI section is tinted with, before per-scheme contrast fixup. */
export const ASSIST_ACCENT = "#a877ff";

const BODY_TEXT_MIN = 4.5;
const SUBTLE_TEXT_MIN = 3.6;
const TITLE_TEXT_MIN = 4.5;

export interface SurfaceTokens {
  app: string;
  /**
   * What the shell paints behind and between panes. The app background for
   * a flat style; a step darker (or greyer) than the cards for a raised one.
   */
  backdrop: string;
  panel: string;
  raised: string;
  overlay: string;
  hover: string;
  selected: string;
  selectedText: string;
}

export interface TextTokens {
  primary: string;
  dim: string;
  muted: string;
  bright: string;
  accent: string;
  positive: string;
  negative: string;
  neutral: string;
  warning: string;
}

export interface PaneChromeTokens {
  borderKind: PaneBorderKind;
  /** The set a Box's `borderStyle` prop should use for this style. */
  boxBorderStyle: "single" | "double" | "rounded" | "heavy";
  headerMode: PaneHeaderMode;
  focusMode: FocusMode;
  separators: SeparatorMode;
  surface: SurfaceMode;
  density: Density;
  grip: string;
  upperCaseTitles: boolean;
  /** Cells, not pixels: density has to stay on the terminal grid. */
  padding: { x: number; y: number };
  rowHeight: number;
  /** False when the style draws no pane box, so callers can skip the frame. */
  drawsBorder: boolean;
  /**
   * True when every docked pane is a closed box: top rule, side rules and
   * bottom rule, focused or not. The terminal draws the sides in the columns
   * it already keeps clear of content.
   */
  framed: boolean;
  /** True when the header should be painted with reverse video. */
  invertHeader: boolean;
  /** True when the header carries a rule on its bottom edge. */
  underlineHeader: boolean;
  /** True when the title is followed by a rule to the pane's right edge. */
  ruleHeader: boolean;
  /** True when focus is a mark at the pane's left edge. */
  accentFocus: boolean;
}

export interface PaneStateColors {
  idle: string;
  focused: string;
}

export interface PaneTokens {
  chrome: PaneChromeTokens;
  border: { idle: string; focused: string; selected: string };
  /** The gutter between docked panes, at rest and while being dragged. */
  divider: { idle: string; active: string };
  body: { bg: PaneStateColors };
  floatingBody: { bg: PaneStateColors };
  title: {
    bg: PaneStateColors;
    floatingBg: PaneStateColors;
    text: PaneStateColors;
    floatingText: PaneStateColors;
    grip: PaneStateColors;
    /** The rule after a `rule` header, and the accent mark of `accent` focus. */
    rule: PaneStateColors;
  };
  footer: { bg: PaneStateColors; text: string; border: PaneStateColors };
}

export type CommandBarBadgeTone = "command" | "instrument" | "document" | "assist";

export interface CommandBarTokens {
  bg: string;
  panelBg: string;
  inputBg: string;
  border: string;
  borderFocused: string;
  text: string;
  headingText: string;
  subtleText: string;
  accentText: string;
  matchText: string;
  selectedBg: string;
  selectedText: string;
  hoverBg: string;
  badge: Record<CommandBarBadgeTone, string>;
}

export interface TableTokens {
  headerBg: string;
  headerText: string;
  border: string;
  row: { hover: string; selected: string; selectedText: string; stripe: string | null };
  /** Structure, in cells, so a table lays out the same in both renderers. */
  layout: {
    headerMode: TableHeaderMode;
    rowHeight: number;
    columnGap: number;
    padX: number;
    rowRule: boolean;
    /** Hairline under the header row; null when the style draws none. */
    headerRule: string | null;
  };
}

/**
 * Treatment for one semantic type role. Attributes and case are all the
 * terminal has, and they are enough to carry the decision; the DOM reads the
 * same role off a data attribute and adds size and face in CSS.
 */
export interface TypeTreatment {
  /** TextAttributes bitmask. */
  attributes: number;
  transform: "none" | "upper";
}

export type TypeTokens = Record<TypeRole, TypeTreatment>;

export interface ListTokens {
  bg: string;
  text: string;
  detailText: string;
  hoverBg: string;
  selectedBg: string;
  selectedText: string;
}

export type BadgeTone = "neutral" | "accent" | "positive" | "negative" | "warning";

export interface BadgeFill {
  bg: string;
  fg: string;
}

export interface BadgeTokens {
  subtle: Record<BadgeTone, BadgeFill>;
  solid: Record<BadgeTone, BadgeFill>;
}

export type ButtonVariantToken = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonFill {
  bg: string;
  fg: string;
  border: string;
  hoverBg: string;
}

export interface ButtonTokens extends Record<ButtonVariantToken, ButtonFill> {
  disabled: ButtonFill;
}

export interface DialogTokens {
  /** The dialog box itself, as the terminal draws it. */
  bg: string;
  border: string;
  /**
   * The elevated modal panel the DOM uses for onboarding and the sign-in gate.
   * A separate surface from `bg` on purpose: the two were always different, and
   * collapsing them into one moved the terminal's dialogs off the app
   * background.
   */
  surfaceBg: string;
  surfaceBorder: string;
  titleText: string;
  bodyText: string;
  subtleText: string;
  backdrop: string;
}

export interface ToastTokens {
  bg: string;
  border: string;
  titleText: string;
  bodyText: string;
  subtleText: string;
  accent: { info: string; success: string; error: string };
}

export interface ChartTokens {
  indicator: readonly string[];
  grid: string;
  axis: string;
  crosshair: string;
}

export interface ThemeTokens {
  surface: SurfaceTokens;
  text: TextTokens;
  type: TypeTokens;
  /** Content rhythm in cells: rows, gaps, section spacing. */
  spacing: { rowHeight: number; columnGap: number; padX: number; sectionGap: number };
  pane: PaneTokens;
  commandBar: CommandBarTokens;
  table: TableTokens;
  list: ListTokens;
  badge: BadgeTokens;
  button: ButtonTokens;
  dialog: DialogTokens;
  toast: ToastTokens;
  chart: ChartTokens;
  focus: { ring: string; accent: string };
}

export interface ResolvedTheme {
  /** `<style>:<scheme>`, the identity a memo or a snapshot keys on. */
  id: string;
  schemeId: string;
  styleId: string;
  scheme: Theme;
  palette: ThemePalette;
  style: StyleSpec;
  glyphs: GlyphSet;
  tokens: ThemeTokens;
  dark: boolean;
}

function paletteOf(scheme: Theme): ThemePalette {
  const { name: _name, description: _description, ...palette } = scheme;
  return Object.freeze(palette);
}

/* -------------------------------------------------------------------------- */
/* Pane recipes                                                               */
/* -------------------------------------------------------------------------- */

/** The lighter of the scheme's two surfaces, which is what a card is made of. */
function lighterSurface(palette: ThemePalette): string {
  return relativeLuminance(palette.panel) > relativeLuminance(palette.bg) ? palette.panel : palette.bg;
}

function darkerSurface(palette: ThemePalette): string {
  return relativeLuminance(palette.panel) > relativeLuminance(palette.bg) ? palette.bg : palette.panel;
}

/**
 * What the shell paints behind the panes. A raised style pushes it a step
 * past the darker surface so a card sits visibly above it; on a light scheme
 * that step is towards the border grey rather than towards black, since a
 * white card on a dark field is a different product.
 */
function backdrop(palette: ThemePalette, style: StyleSpec, dark: boolean): string {
  if (style.chrome.surface !== "raised") return palette.bg;
  const base = darkerSurface(palette);
  return dark ? blendHex(base, "#000000", 0.32) : blendHex(base, palette.border, 0.38);
}

/** The card surface of a raised style: the lighter surface, lifted a touch. */
function cardSurface(palette: ThemePalette, dark: boolean): string {
  const base = lighterSurface(palette);
  return dark ? blendHex(base, palette.textBright, 0.025) : base;
}

function paneBodyBg(palette: ThemePalette, style: StyleSpec, focused: boolean, floating: boolean): string {
  const dark = relativeLuminance(palette.text) > relativeLuminance(palette.bg);
  if (style.chrome.surface === "raised") {
    // A card is the same surface focused or not; the ring and the title
    // carry focus. A floating card sits a step higher than a docked one.
    const card = cardSurface(palette, dark);
    const lifted = floating ? blendHex(card, palette.textBright, dark ? 0.03 : 0) : card;
    return focused && style.chrome.focus === "glow" ? blendHex(lifted, palette.borderFocused, 0.04) : lifted;
  }
  const lift = floating ? 0.08 : 0.06;
  const rest = floating ? 0.18 : 0.08;
  switch (style.chrome.focus) {
    case "glow":
      // Borderless styles have nothing but the surface to carry focus, so the
      // focused body lifts further and the idle body sits flat on the app bg.
      return focused
        ? blendHex(palette.bg, palette.borderFocused, floating ? 0.1 : 0.07)
        : blendHex(palette.panel, palette.border, floating ? 0.14 : 0.04);
    case "header":
    case "accent":
      // Focus is carried entirely by the title, so both bodies match, and a
      // flat style keeps them on the app background itself.
      return floating ? blendHex(palette.panel, palette.border, 0.14) : palette.bg;
    case "frame":
      // The frame carries focus; the body stays put so the box reads as one.
      return floating ? blendHex(palette.panel, palette.border, 0.12) : palette.bg;
    default:
      return focused ? blendHex(palette.bg, palette.borderFocused, lift) : blendHex(palette.panel, palette.border, rest);
  }
}

function barTitleBg(palette: ThemePalette, focused: boolean, floating: boolean): string {
  if (focused) return blendHex(palette.bg, palette.borderFocused, floating ? 0.25 : 0.22);
  return blendHex(palette.panel, palette.border, floating ? 0.25 : 0.15);
}

function barTitleText(palette: ThemePalette, background: string, focused: boolean): string {
  const preferred = focused
    ? higherContrast(palette.textBright, palette.headerText, background)
    : palette.textDim;
  const fallback = focused
    ? higherContrast(palette.text, "#f2f2f2", background)
    : higherContrast(palette.text, palette.textBright, background);
  return blendForContrast(preferred, background, fallback, focused ? 5.2 : 4.5);
}

/**
 * The title bar background per header mode. `bar` keeps the tinted strip the
 * app has always had; `inverted` fills it with the title's own ink; the rest
 * sit flush on the body so the header reads as type rather than as chrome.
 */
function paneTitleBg(
  palette: ThemePalette,
  style: StyleSpec,
  focused: boolean,
  floating: boolean,
): string {
  const mode = style.chrome.paneHeader;
  const body = paneBodyBg(palette, style, focused, floating);
  if (mode === "bar") return barTitleBg(palette, focused, floating);
  if (mode === "inverted") {
    // Reverse video: the strip takes the ink colour and the text takes the body.
    const ink = focused
      ? higherContrast(palette.borderFocused, palette.textBright, body)
      : higherContrast(palette.textDim, palette.border, body);
    return blendForContrast(ink, body, higherContrast("#ffffff", "#000000", body), 3.0);
  }
  // `embedded`, `rule`, `underline`, `inline` and `plain` all sit the title on
  // the body: the header reads as type, not as a plate.
  return body;
}

function paneTitleText(
  palette: ThemePalette,
  style: StyleSpec,
  focused: boolean,
  floating: boolean,
): string {
  const mode = style.chrome.paneHeader;
  const background = paneTitleBg(palette, style, focused, floating);
  if (mode === "bar") return barTitleText(palette, background, focused);
  if (mode === "inverted") {
    const body = paneBodyBg(palette, style, focused, floating);
    return blendForContrast(body, background, higherContrast("#ffffff", "#000000", background), 4.5);
  }
  const extreme = higherContrast("#ffffff", "#000000", background);
  if (mode === "embedded") {
    // Set into the rule, the title is part of the frame and takes its ink:
    // the frame colour at rest, and the brightest ink when the frame lights.
    const preferred = focused ? palette.textBright : palette.textDim;
    return blendForContrast(preferred, background, higherContrast(palette.text, extreme, background), focused ? TITLE_TEXT_MIN + 0.7 : TITLE_TEXT_MIN);
  }
  if (mode === "rule") {
    // A running head is body ink at rest and accent ink when it is the page
    // being read, and the rule after it follows.
    const preferred = focused ? higherContrast(palette.borderFocused, palette.textBright, background) : palette.text;
    return blendForContrast(preferred, background, higherContrast(palette.text, extreme, background), focused ? TITLE_TEXT_MIN + 0.7 : TITLE_TEXT_MIN);
  }
  const preferred = focused
    ? higherContrast(palette.textBright, palette.borderFocused, background)
    : mode === "plain" || mode === "inline" ? palette.textDim : palette.text;
  const fallback = higherContrast(palette.text, extreme, background);
  return blendForContrast(preferred, background, fallback, focused ? TITLE_TEXT_MIN + 0.7 : TITLE_TEXT_MIN);
}

function paneGrip(palette: ThemePalette, style: StyleSpec, focused: boolean): string {
  const background = paneTitleBg(palette, style, focused, false);
  if (style.chrome.paneHeader === "inverted") return paneTitleText(palette, style, focused, false);
  const preferred = focused ? palette.borderFocused : palette.textMuted;
  return blendForContrast(preferred, background, higherContrast(palette.text, palette.textBright, background), 3.0);
}

/**
 * The rule that trails a running head, and the mark that flags accent focus.
 * At rest it is the frame colour; focused it is the accent, floored so a
 * scheme whose accent is close to its surface still shows the change.
 */
function paneRule(palette: ThemePalette, style: StyleSpec, focused: boolean): string {
  const background = paneTitleBg(palette, style, focused, false);
  if (!focused) return blendHex(palette.border, background, style.chrome.separators === "hairline" ? 0.35 : 0);
  return blendForContrast(palette.borderFocused, background, higherContrast(palette.textBright, palette.text, background), 3.0);
}

function paneBorder(palette: ThemePalette, style: StyleSpec): PaneTokens["border"] {
  const focusedBorder = palette.borderFocused;
  switch (style.chrome.focus) {
    case "header":
    case "accent":
      // The border is decoration once the header carries focus, so it stays put.
      return { idle: palette.border, focused: palette.border, selected: focusedBorder };
    case "glow":
      return {
        idle: blendHex(palette.border, palette.bg, 0.45),
        focused: blendHex(palette.borderFocused, palette.bg, 0.35),
        selected: focusedBorder,
      };
    case "frame":
      // Every pane is boxed, so the idle frame is quieter than a lone border
      // would be and the focused one is the accent at full strength.
      return {
        idle: blendHex(palette.border, palette.textDim, 0.25),
        focused: focusedBorder,
        selected: focusedBorder,
      };
    default:
      return { idle: palette.border, focused: focusedBorder, selected: focusedBorder };
  }
}

/** The gutter between docked panes: a line, a hairline, or the backdrop itself. */
function paneDivider(palette: ThemePalette, style: StyleSpec, backdropColor: string): PaneTokens["divider"] {
  const active = palette.borderFocused;
  switch (style.chrome.separators) {
    case "whitespace":
      return { idle: backdropColor, active };
    case "hairline":
      return { idle: blendHex(palette.border, backdropColor, 0.55), active };
    default:
      return { idle: palette.border, active };
  }
}

/* -------------------------------------------------------------------------- */
/* Command bar recipes                                                        */
/* -------------------------------------------------------------------------- */

function commandBarBg(palette: ThemePalette, style: StyleSpec): string {
  const base = higherContrast(palette.commandBg, palette.panel, palette.bg);
  const accent = higherContrast(palette.textBright, palette.borderFocused, base);
  const separated = blendForContrast(base, palette.bg, accent, 1.45);
  // Borderless styles lean on elevation instead of a rule, so the sheet has to
  // separate from the app background by more than the terminal's hairline does.
  if (style.chrome.paneBorder === "none") return blendForContrast(separated, palette.bg, accent, 1.9);
  return separated;
}

function commandBarPanelBg(palette: ThemePalette, style: StyleSpec): string {
  return blendHex(commandBarBg(palette, style), palette.panel, 0.28);
}

function commandBarSelectedBg(palette: ThemePalette, style: StyleSpec): string {
  const base = commandBarBg(palette, style);
  const accent = higherContrast(palette.selectedText, palette.textBright, palette.selected);
  return blendForContrast(palette.selected, base, accent, 1.45);
}

function commandBarText(palette: ThemePalette, style: StyleSpec): string {
  const base = commandBarBg(palette, style);
  const fallback = higherContrast(palette.textBright, "#f2f2f2", base);
  return blendForContrast(palette.text, base, fallback, 5.4);
}

function commandBarSubtleText(palette: ThemePalette, style: StyleSpec): string {
  const base = commandBarBg(palette, style);
  const fallback = higherContrast(commandBarText(palette, style), "#d8d8d8", base);
  return blendForContrast(palette.textDim, base, fallback, 4.1);
}

function commandBarBadgeHue(tone: CommandBarBadgeTone, palette: ThemePalette): string {
  if (tone === "instrument") return palette.warning;
  if (tone === "document") return palette.neutral;
  if (tone === "assist") return ASSIST_ACCENT;
  return palette.borderFocused;
}

function buildCommandBar(palette: ThemePalette, style: StyleSpec): CommandBarTokens {
  const bg = commandBarBg(palette, style);
  const panelBg = commandBarPanelBg(palette, style);
  const selectedBg = commandBarSelectedBg(palette, style);
  const hoverBg = blendHex(bg, selectedBg, 0.45);
  const text = commandBarText(palette, style);
  const subtleText = commandBarSubtleText(palette, style);
  const surfaces = [bg, panelBg, hoverBg, selectedBg] as const;
  const extreme = higherContrast("#ffffff", "#000000", bg);
  const selectedTextPreferred = higherContrast(palette.selectedText, palette.text, selectedBg);
  const selectedTextFallback = higherContrast(
    higherContrast(palette.textBright, palette.text, selectedBg),
    higherContrast("#ffffff", "#000000", selectedBg),
    selectedBg,
  );
  const headingFallback = higherContrast(
    higherContrast(palette.textDim, palette.text, bg),
    higherContrast(palette.textBright, palette.selectedText, bg),
    bg,
  );
  return {
    bg,
    panelBg,
    inputBg: blendHex(panelBg, palette.bg, 0.22),
    border: palette.commandBorder,
    borderFocused: palette.borderFocused,
    text,
    headingText: blendForContrast(palette.textMuted, bg, headingFallback, SUBTLE_TEXT_MIN),
    subtleText,
    accentText: blendForContrastOnSurfaces(ASSIST_ACCENT, [bg, panelBg], extreme, SUBTLE_TEXT_MIN),
    matchText: blendForContrastOnSurfaces(palette.warning, [bg, panelBg, selectedBg], extreme, SUBTLE_TEXT_MIN),
    selectedBg,
    selectedText: blendForContrast(selectedTextPreferred, selectedBg, selectedTextFallback, BODY_TEXT_MIN),
    hoverBg,
    badge: {
      command: blendForContrastOnSurfaces(blendHex(commandBarBadgeHue("command", palette), subtleText, 0.4), surfaces, extreme, SUBTLE_TEXT_MIN),
      instrument: blendForContrastOnSurfaces(blendHex(commandBarBadgeHue("instrument", palette), subtleText, 0.4), surfaces, extreme, SUBTLE_TEXT_MIN),
      document: blendForContrastOnSurfaces(blendHex(commandBarBadgeHue("document", palette), subtleText, 0.4), surfaces, extreme, SUBTLE_TEXT_MIN),
      assist: blendForContrastOnSurfaces(blendHex(commandBarBadgeHue("assist", palette), subtleText, 0.4), surfaces, extreme, SUBTLE_TEXT_MIN),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Type recipes                                                               */
/* -------------------------------------------------------------------------- */

// Mirrors ui/host's TextAttributes without importing the UI layer into theming.
const BOLD = 1 << 0;
const DIM = 1 << 1;
const ITALIC = 1 << 2;
const UNDERLINE = 1 << 3;

/**
 * How each role reads, derived from the style's heading treatment rather than
 * enumerated per style, so a new style cannot forget a role.
 */
function buildType(style: StyleSpec): TypeTokens {
  const { headings } = style.content;
  const heading: TypeTreatment = headings === "caps"
    ? { attributes: BOLD, transform: "upper" }
    : headings === "underline"
      ? { attributes: UNDERLINE, transform: "none" }
      : { attributes: BOLD, transform: "none" };
  return {
    display: { attributes: BOLD, transform: "none" },
    heading,
    // A caps style labels its columns in caps too, which is where most of the
    // label role actually shows up.
    label: headings === "caps"
      ? { attributes: 0, transform: "upper" }
      : { attributes: 0, transform: "none" },
    body: { attributes: 0, transform: "none" },
    value: { attributes: BOLD, transform: "none" },
    // Print sets its asides in italic; a terminal font may not have one, in
    // which case the renderer falls back to plain and nothing shifts.
    caption: headings === "underline"
      ? { attributes: ITALIC, transform: "none" }
      : { attributes: DIM, transform: "none" },
    numeric: { attributes: 0, transform: "none" },
  };
}

/* -------------------------------------------------------------------------- */
/* Chart recipes                                                              */
/* -------------------------------------------------------------------------- */

function chartIndicatorPalette(palette: ThemePalette): string[] {
  const accent = higherContrast(palette.warning, palette.borderFocused, palette.bg);
  const candidates = [
    palette.warning,
    blendHex(palette.borderFocused, palette.warning, 0.38),
    blendHex(palette.warning, palette.textBright, 0.42),
    blendHex(palette.borderFocused, palette.textBright, 0.38),
    palette.neutral,
    blendHex(palette.warning, palette.neutral, 0.52),
    blendHex(palette.borderFocused, palette.neutral, 0.46),
  ];
  return candidates.map((candidate) => {
    const color = blendForContrast(
      candidate,
      palette.bg,
      higherContrast(accent, palette.textBright, palette.bg),
      3.6,
    );
    if (![palette.positive, palette.negative, palette.text].includes(color)) return color;
    return blendForContrast(blendHex(color, accent, 0.55), palette.bg, palette.textBright, 3.6);
  });
}

/* -------------------------------------------------------------------------- */
/* Token tree                                                                 */
/* -------------------------------------------------------------------------- */

function buildTokens(palette: ThemePalette, style: StyleSpec): ThemeTokens {
  const { chrome, content } = style;
  const dark = relativeLuminance(palette.text) > relativeLuminance(palette.bg);
  const padding = densityPadding(chrome.density);
  const hover = blendHex(palette.bg, palette.selected, 0.5);
  const border = paneBorder(palette, style);
  const backdropColor = backdrop(palette, style, dark);
  const bodyBg = {
    idle: paneBodyBg(palette, style, false, false),
    focused: paneBodyBg(palette, style, true, false),
  };
  const floatingBodyBg = {
    idle: paneBodyBg(palette, style, false, true),
    focused: paneBodyBg(palette, style, true, true),
  };
  const commandBar = buildCommandBar(palette, style);
  const extremeOnBg = higherContrast("#ffffff", "#000000", palette.bg);
  const accent = palette.borderFocused;

  // The scheme was normalized against `bg` and `panel`. A style is free to sit
  // pane bodies on a blend of the two, so the shared text roles are re-floored
  // against the surfaces this style actually produces before anything reads
  // them. Only the tokens move; the scheme's own palette is left alone.
  const bodySurfaces = [palette.bg, palette.panel, bodyBg.idle, bodyBg.focused, floatingBodyBg.idle, floatingBodyBg.focused];
  const onBody = (base: string, fallback: string, min: number) =>
    blendForContrastOnSurfaces(base, bodySurfaces, fallback, min);
  const textPrimary = onBody(palette.text, higherContrast(palette.textBright, extremeOnBg, palette.bg), BODY_TEXT_MIN);
  const textDim = onBody(palette.textDim, higherContrast(textPrimary, palette.textBright, palette.bg), BODY_TEXT_MIN);
  const textMuted = onBody(palette.textMuted, higherContrast(textDim, textPrimary, palette.bg), SUBTLE_TEXT_MIN);

  // These reproduce the badge recipe the app has always used. The pair is
  // already contrast-safe by construction: a subtle badge tints the background
  // towards its own hue and then writes in that hue.
  const badgeSubtle = (_tone: BadgeTone, hue: string): BadgeFill => ({
    bg: blendHex(palette.bg, hue, 0.28),
    fg: hue,
  });
  const badgeSolid = (tone: BadgeTone, hue: string): BadgeFill => (
    tone === "neutral"
      ? { bg: palette.selected, fg: palette.selectedText }
      : { bg: hue, fg: palette.bg }
  );
  const badgeHues: Record<BadgeTone, string> = {
    neutral: textDim,
    accent,
    positive: palette.positive,
    negative: palette.negative,
    warning: palette.warning,
  };

  const buttonFill = (hue: string): ButtonFill => ({
    bg: hue,
    fg: palette.bg,
    border: hue,
    hoverBg: blendHex(hue, extremeOnBg, 0.14),
  });

  const dialogBg = palette.bg;
  const dialogSurfaceBg = blendHex(palette.panel, palette.bg, 0.12);

  return {
    surface: {
      app: palette.bg,
      backdrop: backdropColor,
      panel: palette.panel,
      raised: blendHex(palette.panel, palette.border, 0.18),
      overlay: blendHex(palette.bg, palette.panel, 0.6),
      hover,
      selected: palette.selected,
      selectedText: palette.selectedText,
    },
    type: buildType(style),
    spacing: {
      rowHeight: style.content.rowHeight,
      columnGap: style.content.columnGap,
      padX: style.content.padX,
      sectionGap: style.content.sectionGap,
    },
    text: {
      primary: textPrimary,
      dim: textDim,
      muted: textMuted,
      bright: palette.textBright,
      accent,
      positive: palette.positive,
      negative: palette.negative,
      neutral: palette.neutral,
      warning: palette.warning,
    },
    pane: {
      chrome: {
        borderKind: chrome.paneBorder,
        boxBorderStyle: openTuiBorderStyle(chrome.paneBorder),
        headerMode: chrome.paneHeader,
        focusMode: chrome.focus,
        separators: chrome.separators,
        surface: chrome.surface,
        density: chrome.density,
        grip: chrome.headerGrip,
        upperCaseTitles: chrome.headerCase === "upper",
        padding,
        rowHeight: content.rowHeight,
        drawsBorder: chrome.paneBorder !== "none",
        framed: chrome.paneBorder !== "none" && (chrome.focus === "frame" || chrome.paneHeader === "embedded"),
        invertHeader: chrome.paneHeader === "inverted",
        underlineHeader: chrome.paneHeader === "underline",
        ruleHeader: chrome.paneHeader === "rule",
        accentFocus: chrome.focus === "accent",
      },
      border,
      divider: paneDivider(palette, style, backdropColor),
      body: { bg: bodyBg },
      floatingBody: { bg: floatingBodyBg },
      title: {
        bg: {
          idle: paneTitleBg(palette, style, false, false),
          focused: paneTitleBg(palette, style, true, false),
        },
        floatingBg: {
          idle: paneTitleBg(palette, style, false, true),
          focused: paneTitleBg(palette, style, true, true),
        },
        text: {
          idle: paneTitleText(palette, style, false, false),
          focused: paneTitleText(palette, style, true, false),
        },
        floatingText: {
          idle: paneTitleText(palette, style, false, true),
          focused: paneTitleText(palette, style, true, true),
        },
        grip: {
          idle: paneGrip(palette, style, false),
          focused: paneGrip(palette, style, true),
        },
        rule: {
          idle: paneRule(palette, style, false),
          focused: paneRule(palette, style, true),
        },
      },
      footer: {
        bg: bodyBg,
        text: textMuted,
        border: { idle: border.idle, focused: border.focused },
      },
    },
    commandBar,
    table: {
      // A plain or underlined header sits on the body; only a filled one gets
      // its own plate, and an inverted one takes the ink.
      // `filled` is the plain panel the app has always used for a table
      // header; the other modes are what a style changes it to.
      // An inverted header is a plate of dim ink with the body showing
      // through as text: enough to read as reverse video, not so bright that
      // every table shouts. Floored against its own text, not the body.
      headerBg: content.table.header === "filled"
        ? palette.panel
        : content.table.header === "inverted"
          ? blendForContrast(blendHex(textDim, bodyBg.idle, 0.45), bodyBg.idle, higherContrast("#ffffff", "#000000", bodyBg.idle), 3.0)
          : bodyBg.idle,
      headerText: content.table.header === "inverted" ? bodyBg.idle : textDim,
      border: chrome.separators === "lines" ? palette.border : blendHex(palette.border, palette.bg, 0.6),
      row: {
        hover,
        selected: palette.selected,
        selectedText: palette.selectedText,
        stripe: content.table.stripe ? blendHex(palette.bg, palette.panel, 0.55) : null,
      },
      layout: {
        headerMode: content.table.header,
        rowHeight: content.rowHeight,
        columnGap: content.columnGap,
        padX: content.padX,
        rowRule: content.table.rowRule,
        headerRule: content.table.header === "underline" || content.table.rowRule
          ? blendHex(palette.border, palette.bg, 0.25)
          : null,
      },
    },
    list: {
      bg: bodyBg.idle,
      text: textPrimary,
      detailText: textDim,
      hoverBg: hover,
      selectedBg: palette.selected,
      selectedText: palette.selectedText,
    },
    badge: {
      subtle: {
        neutral: badgeSubtle("neutral", badgeHues.neutral),
        accent: badgeSubtle("accent", badgeHues.accent),
        positive: badgeSubtle("positive", badgeHues.positive),
        negative: badgeSubtle("negative", badgeHues.negative),
        warning: badgeSubtle("warning", badgeHues.warning),
      },
      solid: {
        neutral: badgeSolid("neutral", badgeHues.neutral),
        accent: badgeSolid("accent", badgeHues.accent),
        positive: badgeSolid("positive", badgeHues.positive),
        negative: badgeSolid("negative", badgeHues.negative),
        warning: badgeSolid("warning", badgeHues.warning),
      },
    },
    // Unchanged from the pre-split recipe: a button's fill is a scheme
    // decision, not a style one, so no style varies it. Only the radius and
    // shadow move, and those come from the DOM vars.
    button: {
      primary: buttonFill(accent),
      secondary: {
        bg: palette.panel,
        fg: textPrimary,
        border: palette.border,
        hoverBg: hover,
      },
      ghost: {
        bg: palette.bg,
        fg: textDim,
        border: "transparent",
        hoverBg: hover,
      },
      danger: buttonFill(palette.negative),
      disabled: {
        bg: palette.panel,
        fg: textMuted,
        border: palette.border,
        hoverBg: palette.panel,
      },
    },
    dialog: {
      bg: dialogBg,
      border: chrome.focus === "glow" ? blendHex(palette.border, palette.bg, 0.3) : palette.borderFocused,
      surfaceBg: dialogSurfaceBg,
      surfaceBorder: blendHex(palette.border, palette.borderFocused, 0.18),
      titleText: palette.textBright,
      bodyText: textPrimary,
      subtleText: textMuted,
      backdrop: palette.bg,
    },
    toast: {
      bg: palette.panel,
      border: palette.border,
      titleText: palette.textBright,
      bodyText: palette.text,
      subtleText: palette.textDim,
      accent: { info: accent, success: palette.positive, error: palette.negative },
    },
    chart: {
      indicator: Object.freeze(chartIndicatorPalette(palette)),
      grid: blendHex(palette.bg, palette.border, chrome.separators === "lines" ? 0.8 : 0.5),
      axis: palette.textMuted,
      crosshair: palette.borderFocused,
    },
    focus: { ring: palette.borderFocused, accent },
  };
}

/* -------------------------------------------------------------------------- */
/* Contrast audit                                                             */
/* -------------------------------------------------------------------------- */

interface ContrastCheck {
  label: string;
  fg: string;
  bg: string;
  min: number;
}

function contrastChecks(tokens: ThemeTokens): ContrastCheck[] {
  const { pane, commandBar, dialog, list, table } = tokens;
  return [
    { label: "pane.title.text.idle", fg: pane.title.text.idle, bg: pane.title.bg.idle, min: TITLE_TEXT_MIN },
    { label: "pane.title.text.focused", fg: pane.title.text.focused, bg: pane.title.bg.focused, min: TITLE_TEXT_MIN },
    { label: "pane.title.floatingText.idle", fg: pane.title.floatingText.idle, bg: pane.title.floatingBg.idle, min: TITLE_TEXT_MIN },
    { label: "pane.title.floatingText.focused", fg: pane.title.floatingText.focused, bg: pane.title.floatingBg.focused, min: TITLE_TEXT_MIN },
    { label: "text.primary on pane.body.idle", fg: tokens.text.primary, bg: pane.body.bg.idle, min: BODY_TEXT_MIN },
    { label: "text.primary on pane.body.focused", fg: tokens.text.primary, bg: pane.body.bg.focused, min: BODY_TEXT_MIN },
    { label: "text.muted on pane.body.idle", fg: tokens.text.muted, bg: pane.body.bg.idle, min: SUBTLE_TEXT_MIN },
    { label: "commandBar.text", fg: commandBar.text, bg: commandBar.bg, min: BODY_TEXT_MIN },
    { label: "commandBar.subtleText", fg: commandBar.subtleText, bg: commandBar.bg, min: SUBTLE_TEXT_MIN },
    { label: "commandBar.selectedText", fg: commandBar.selectedText, bg: commandBar.selectedBg, min: BODY_TEXT_MIN },
    { label: "commandBar.accentText", fg: commandBar.accentText, bg: commandBar.bg, min: SUBTLE_TEXT_MIN },
    { label: "dialog.bodyText", fg: dialog.bodyText, bg: dialog.bg, min: BODY_TEXT_MIN },
    { label: "dialog.subtleText", fg: dialog.subtleText, bg: dialog.bg, min: SUBTLE_TEXT_MIN },
    { label: "list.selectedText", fg: list.selectedText, bg: list.selectedBg, min: BODY_TEXT_MIN },
    { label: "table.row.selectedText", fg: table.row.selectedText, bg: table.row.selected, min: BODY_TEXT_MIN },
    { label: "text.primary on table.row.hover", fg: tokens.text.primary, bg: table.row.hover, min: SUBTLE_TEXT_MIN },
  ];
}

export interface ContrastFailure {
  label: string;
  ratio: number;
  min: number;
  fg: string;
  bg: string;
}

/**
 * Reports rather than repairs. `normalizeTheme` already pulled the scheme's own
 * colours onto their surfaces; by the time a style has recombined them a silent
 * second fixup would only hide which recipe produced an unreadable pair.
 */
export function auditContrast(tokens: ThemeTokens): ContrastFailure[] {
  const failures: ContrastFailure[] = [];
  for (const check of contrastChecks(tokens)) {
    const ratio = contrastRatio(check.fg, check.bg);
    if (ratio + 0.005 < check.min) {
      failures.push({ label: check.label, ratio, min: check.min, fg: check.fg, bg: check.bg });
    }
  }
  return failures;
}

let warnedThemes: Set<string> | null = null;

function warnOnContrastFailures(id: string, tokens: ThemeTokens): void {
  const failures = auditContrast(tokens);
  if (failures.length === 0) return;
  warnedThemes ??= new Set();
  if (warnedThemes.has(id)) return;
  warnedThemes.add(id);
  for (const failure of failures) {
    console.warn(
      `[theme] ${id}: ${failure.label} contrast ${failure.ratio.toFixed(2)}:1 is below ${failure.min}:1 `
      + `(${failure.fg} on ${failure.bg})`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                 */
/* -------------------------------------------------------------------------- */

const resolvedCache = new Map<string, ResolvedTheme>();

export function resolveTheme(schemeId: string, styleId: string = DEFAULT_STYLE): ResolvedTheme {
  const key = `${styleId}:${schemeId}`;
  const cached = resolvedCache.get(key);
  if (cached) return cached;
  const scheme = getScheme(schemeId);
  const style = getStyle(styleId);
  const palette = paletteOf(scheme);
  const tokens = buildTokens(palette, style);
  warnOnContrastFailures(key, tokens);
  const resolved: ResolvedTheme = {
    id: key,
    schemeId,
    styleId,
    scheme,
    palette,
    style,
    glyphs: resolveGlyphs(style.glyphs, style.chrome.paneBorder),
    tokens,
    dark: relativeLuminance(palette.text) > relativeLuminance(palette.bg),
  };
  resolvedCache.set(key, resolved);
  return resolved;
}

export const DEFAULT_RESOLVED_THEME = resolveTheme(DEFAULT_SCHEME, DEFAULT_STYLE);

const paletteTokenCache = new WeakMap<object, Map<string, ThemeTokens>>();

/**
 * Tokens for a palette that is not one of the registered schemes. The helper
 * facade in `colors.ts` accepts an arbitrary palette, and a caller that passes
 * one still deserves style-aware answers rather than the current theme's.
 */
export function resolveTokensForPalette(palette: ThemePalette, styleId: string): ThemeTokens {
  let byStyle = paletteTokenCache.get(palette);
  if (!byStyle) {
    byStyle = new Map();
    paletteTokenCache.set(palette, byStyle);
  }
  const cached = byStyle.get(styleId);
  if (cached) return cached;
  const tokens = buildTokens(palette, getStyle(styleId));
  byStyle.set(styleId, tokens);
  return tokens;
}
