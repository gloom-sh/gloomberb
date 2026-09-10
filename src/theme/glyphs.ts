import type { GlyphMode, PaneBorderKind } from "./styles";

/**
 * The terminal's half of a style. Every glyph the shared tier draws comes from
 * here, so a style that declares `glyphs: "ascii"` genuinely renders on a
 * 7-bit font, and a style that declares `paneBorder: "heavy"` gets heavy
 * corners everywhere a pane, a dialog or a drop overlay draws a box.
 *
 * Two axes: the repertoire (`unicode` / `ascii` / `nerd`) picks the marks, and
 * the border kind picks the box-drawing set. They are separate because a style
 * can want rounded corners with plain arrows, or ascii marks inside a line box.
 * `ascii` collapses both: every box set degrades to `+-|` when the repertoire
 * cannot promise anything better.
 */

export interface BorderChars {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  teeLeft: string;
  teeRight: string;
  cross: string;
}

export interface GlyphSet {
  mode: GlyphMode;
  border: BorderChars;
  /** True when the style asked for no pane border at all. */
  borderless: boolean;
  arrow: { up: string; down: string; left: string; right: string };
  /** Solid triangles, for a sort indicator in a column header. */
  triangle: { up: string; down: string };
  /** Disclosure triangles for expandable rows. */
  caret: { collapsed: string; expanded: string };
  bullet: string;
  /** Quieter than `bullet`, for secondary list marks. */
  dot: string;
  diamond: string;
  circle: { filled: string; hollow: string };
  star: { filled: string; hollow: string };
  check: string;
  cross: string;
  checkbox: { checked: string; unchecked: string };
  /** Dark-scheme marker in the theme picker. */
  moon: string;
  bolt: string;
  /** Bottom-left growing blocks, low to high. Index 0 is the empty cell. */
  sparkline: readonly string[];
  /** Left-to-right filling blocks for bar meters. */
  bar: { full: string; half: string; halfRight: string };
  spinner: readonly string[];
  /** Resize affordance in the bottom-right corner of a floating pane. */
  resizeGrip: string;
  /** Marks a pane whose subject follows another pane. */
  link: string;
  ellipsis: string;
}

const BORDERS: Record<PaneBorderKind, BorderChars> = {
  none: {
    topLeft: " ", topRight: " ", bottomLeft: " ", bottomRight: " ",
    horizontal: " ", vertical: " ", teeLeft: " ", teeRight: " ", cross: " ",
  },
  line: {
    topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘",
    horizontal: "─", vertical: "│", teeLeft: "├", teeRight: "┤", cross: "┼",
  },
  double: {
    topLeft: "╔", topRight: "╗", bottomLeft: "╚", bottomRight: "╝",
    horizontal: "═", vertical: "║", teeLeft: "╠", teeRight: "╣", cross: "╬",
  },
  rounded: {
    topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯",
    horizontal: "─", vertical: "│", teeLeft: "├", teeRight: "┤", cross: "┼",
  },
  heavy: {
    topLeft: "┏", topRight: "┓", bottomLeft: "┗", bottomRight: "┛",
    horizontal: "━", vertical: "┃", teeLeft: "┣", teeRight: "┫", cross: "╋",
  },
  ascii: {
    topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+",
    horizontal: "-", vertical: "|", teeLeft: "+", teeRight: "+", cross: "+",
  },
};

/** OpenTUI's own name for the border set, for `borderStyle` on a Box. */
const OPENTUI_BORDER_STYLE: Record<PaneBorderKind, "single" | "double" | "rounded" | "heavy"> = {
  none: "single",
  line: "single",
  double: "double",
  rounded: "rounded",
  heavy: "heavy",
  ascii: "single",
};

const UNICODE_MARKS = {
  arrow: { up: "↑", down: "↓", left: "←", right: "→" },
  triangle: { up: "▲", down: "▼" },
  caret: { collapsed: "▸", expanded: "▾" },
  bullet: "•",
  dot: "·",
  diamond: "◆",
  circle: { filled: "●", hollow: "○" },
  star: { filled: "★", hollow: "☆" },
  check: "✓",
  cross: "✗",
  checkbox: { checked: "✓", unchecked: " " },
  moon: "☾",
  bolt: "⚡",
  sparkline: [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const,
  bar: { full: "█", half: "▌", halfRight: "▐" },
  spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const,
  resizeGrip: "◢",
  // Not the emoji link, which renders double-width in a terminal.
  link: "⧉",
  ellipsis: "...",
} as const;

const ASCII_MARKS = {
  arrow: { up: "^", down: "v", left: "<", right: ">" },
  triangle: { up: "^", down: "v" },
  caret: { collapsed: ">", expanded: "v" },
  bullet: "*",
  dot: ".",
  diamond: "+",
  circle: { filled: "o", hollow: "." },
  star: { filled: "*", hollow: "-" },
  check: "x",
  cross: "X",
  checkbox: { checked: "x", unchecked: " " },
  moon: "*",
  bolt: "!",
  sparkline: [" ", ".", ".", ":", ":", "|", "|", "#", "#"] as const,
  bar: { full: "#", half: "=", halfRight: "=" },
  spinner: ["|", "/", "-", "\\"] as const,
  resizeGrip: "/",
  link: "=",
  ellipsis: "...",
} as const;

/**
 * Nerd fonts add private-use marks, not a different grid, so only the handful
 * where a patched glyph reads better than the plain one is overridden and the
 * rest falls through to unicode. A partial font then leaves a tofu box rather
 * than a hole in the layout, because every one of these is a single cell.
 *
 * Written as escapes on purpose: private-use code points do not survive every
 * editor and pipeline that touches this file, and a silently emptied glyph
 * would collapse a column.
 */
const NERD_MARKS = {
  ...UNICODE_MARKS,
  // nf-fa-angle_right / angle_down
  caret: { collapsed: "\uf105", expanded: "\uf107" },
  // nf-oct-dot_fill
  bullet: "\uf444",
  // nf-fa-check / nf-fa-times
  check: "\uf00c",
  cross: "\uf00d",
  // nf-fa-check_square_o / nf-fa-square_o
  checkbox: { checked: "\uf046", unchecked: "\uf096" },
  // nf-fa-bolt, which unlike the emoji bolt is a single cell
  bolt: "\uf0e7",
  // nf-fa-link
  link: "\uf0c1",
} as const;

const MARKS: Record<GlyphMode, typeof UNICODE_MARKS> = {
  unicode: UNICODE_MARKS,
  ascii: ASCII_MARKS as unknown as typeof UNICODE_MARKS,
  nerd: NERD_MARKS as unknown as typeof UNICODE_MARKS,
};

const cache = new Map<string, GlyphSet>();

export function resolveGlyphs(mode: GlyphMode, border: PaneBorderKind): GlyphSet {
  const key = `${mode}:${border}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const marks = MARKS[mode] ?? UNICODE_MARKS;
  // A repertoire that cannot promise box drawing overrides the border set.
  const borderChars = mode === "ascii" && border !== "none" ? BORDERS.ascii : BORDERS[border] ?? BORDERS.line;
  const set: GlyphSet = {
    mode,
    border: borderChars,
    borderless: border === "none",
    ...marks,
  };
  cache.set(key, set);
  return set;
}

/** OpenTUI `borderStyle` for a style's pane border. */
export function openTuiBorderStyle(border: PaneBorderKind): "single" | "double" | "rounded" | "heavy" {
  return OPENTUI_BORDER_STYLE[border] ?? "single";
}

/** Custom border characters for OpenTUI when the plain sets are not enough. */
export function borderCharsFor(border: PaneBorderKind, mode: GlyphMode): BorderChars {
  return resolveGlyphs(mode, border).border;
}

/** Picks a sparkline block for a 0..1 ratio. */
export function sparklineBlock(glyphs: GlyphSet, ratio: number): string {
  const steps = glyphs.sparkline.length - 1;
  const index = Math.max(0, Math.min(steps, Math.round(ratio * steps)));
  return glyphs.sparkline[index]!;
}

export const BORDER_KINDS = Object.keys(BORDERS) as PaneBorderKind[];
