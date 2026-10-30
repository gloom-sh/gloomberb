import { asciiText, localeReadsUtf8 } from "./ascii-text";
type CliAlign = "left" | "right" | "center";

export interface CliTableColumn {
  header: string;
  align?: CliAlign;
  width?: number;
  /** Cap for this column when the table is fitted to a terminal: longer cells are cut there. Piped output stays whole. */
  maxWidth?: number;
  /** The narrowest a text column wraps to (MIN_WRAPPED_COLUMN_WIDTH unless set), or a `shrink: true` column is cut to; a narrower table moves columns under their rows. */
  minWidth?: number;
  /** Dropped, rightmost first, before any column is cut or moved to fit a terminal. */
  optional?: boolean;
  /** Among optional columns, a higher priority is dropped sooner; equal ones go rightmost first. */
  dropPriority?: number;
  /**
   * By default a fitted table never cuts a cell, so a date, a figure, a
   * symbol or a title stays whole: text wraps in its cell and columns move
   * under their rows. False keeps the column on one line. True is the
   * explicit opt-out: the table cuts the column's cells, down to its header
   * and `minWidth`, before columns move, for free text that names nothing,
   * such as a description.
   */
  shrink?: boolean;
  /**
   * When the table does not fit, columns move to lines under their row, each
   * value whole after its header: first the ones too wide to sit beside the
   * first column, then a higher priority sooner, then long text, then
   * rightmost first. The first column stays.
   */
  stackPriority?: number;
  /** Once moved under the rows, only the first `stackRows` rows print the column; 0 leaves it out. */
  stackRows?: number;
  /**
   * Left out of a table fitted to fewer terminal columns than this, whether
   * or not it would fit: a detail a narrow table has no room for beside what
   * it is about (a filing's acceptance time beside its filed date). Piped
   * output keeps it.
   */
  minTableWidth?: number;
}

export interface CliTableOptions {
  /** Total width to fit the table into. Defaults to the terminal width; null keeps every cell whole. */
  maxWidth?: number | null;
  indent?: number;
  /** Lines printed under each row, by row index, indented and muted: a footnote that belongs to the row. */
  below?: ReadonlyArray<readonly string[] | undefined>;
  /** Each line under a row stays one line, cut to the table's width, rather than wrapping: a story's summary. */
  cutBelow?: boolean;
}

export type CliStatEntry = readonly [label: string, value: string];

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const ANSI_PREFIX = /^\x1b\[[0-9;]*m/;
const ANSI_SPLIT = /(\x1b\[[0-9;]*m)/;
const ELLIPSIS = "…";
const COLUMN_GAP = 2;
// A shrunk text column keeps at least this many cells, or its header width when wider.
const MIN_SHRUNK_COLUMN_WIDTH = 8;
// Text columns first shrink right to left down to this width, then all shrink together.
const SOFT_MIN_COLUMN_WIDTH = 20;
// Text wraps in its cell down to this width, or its longest word, before columns move under the rows.
const MIN_WRAPPED_COLUMN_WIDTH = 16;
// Cells that say "no value": a moved column prints nothing for them.
const EMPTY_CELL = /^(?:|-{1,2}|—|–)$/;
// A date, or a date and time, as reports print them (`2026-10-09`, `2026-10`, `2026-10-09 20:15 UTC`).
const DATE_CELL = /^\d{4}-\d{2}(?:-\d{2})?(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?: ?UTC)?)?(?: \([^)]*\))?$/;
// A number with its sign, currency, unit or range (`-1.0bp`, `$1,200`, `3.75-4.00%`, `481.75c`).
const NUMBER_PART = String.raw`[+\-−±]?[$€£¥]?\d[\d,]*(?:\.\d+)?`;
const NUMBER_TOKEN = new RegExp(String.raw`^\(?${NUMBER_PART}(?:[-–]${NUMBER_PART})?(?:%|¢|[a-zA-Z]{1,3})?\)?$`);
// What may sit between the numbers of one cell (`3.875% 82% / 4.125% 18%`, `+25bp ↑`, plain `+25bp up`).
const NUMBER_JOINER = /^(?:\/|·|→|↑|↓|[-–]|to|up|down)$/;
// What a plain table writes in a cell with no value.
const PLAIN_EMPTY_CELL = "—";
let colorEnabledOverride: boolean | null = null;
let widthOverride: number | null = null;
let plainOverride: boolean | null = null;
/** Whether the terminal reads only ASCII (`localeReadsUtf8`); undefined until first asked. */
let asciiLocale: boolean | undefined;
/** Output is being rendered for a file (`renderForFile`), which has no terminal width. */
let renderingForFile = false;

/** Renders for a file from here on; the function returned puts the terminal's rendering back. */
function enterFileRendering(): () => void {
  const saved = { color: colorEnabledOverride, plain: plainOverride, file: renderingForFile };
  colorEnabledOverride = false;
  plainOverride = true;
  renderingForFile = true;
  return () => {
    colorEnabledOverride = saved.color;
    plainOverride = saved.plain;
    renderingForFile = saved.file;
  };
}

/**
 * Output rendered for a file (`fn --output`) as a redirect gets it: plain,
 * without colour, and fitted to no width but `--width`'s.
 */
export function renderForFile<T>(render: () => T): T {
  const restore = enterFileRendering();
  try {
    return render();
  } finally {
    restore();
  }
}

/**
 * `renderForFile` around work that renders as it loads: a report whose text is
 * drawn while it is built is drawn for the file, though stdout is a terminal.
 */
export async function buildForFile<T>(build: () => Promise<T>): Promise<T> {
  const restore = enterFileRendering();
  try {
    return await build();
  } finally {
    restore();
  }
}

function colorEnabled(): boolean {
  if (colorEnabledOverride != null) return colorEnabledOverride;
  if (plainOverride === true) return false;
  return !!process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

export function setCliColorEnabledOverride(value: boolean | null): void {
  colorEnabledOverride = value;
}

/**
 * Plain output, for a screen reader, very large text or a pipe: tables have
 * no rule under their header, keep every column they have with "—" in an
 * empty cell, and say their arrows in words (`plainWords`), as do the
 * markers the CLI writes itself (`cliArrow`); a user's own text is never
 * rewritten. Colour is off unless `--color` asks for it. The CLI turns it on
 * for NO_COLOR and output that is not a terminal (`plainByDefault`), and
 * `--plain` / `--no-plain` decide it either way; unset, it is off.
 */
export function setCliPlainOverride(value: boolean | null): void {
  plainOverride = value;
}

export function cliPlainEnabled(): boolean {
  return plainOverride === true;
}

/** Tests say whether the terminal reads only ASCII; null asks the environment again. */
export function setCliAsciiLocaleOverride(value: boolean | null): void {
  asciiLocale = value ?? undefined;
}

/**
 * Plain output to a terminal that cannot show UTF-8 (a C locale, a Windows
 * code page such as 437): it is written in ASCII (`asciiText`), so a dash, a
 * euro or a cent sign does not print as `â€”`. Output rendered for a file
 * keeps its UTF-8.
 */
export function cliAsciiEnabled(): boolean {
  if (plainOverride !== true || renderingForFile) return false;
  asciiLocale ??= !localeReadsUtf8();
  return asciiLocale;
}

/**
 * Whether output is plain without `--plain` or `--no-plain`: NO_COLOR is set
 * to a value (an empty one is unset, as the convention says), or stdout is
 * not a terminal.
 */
export function plainByDefault(env: Record<string, string | undefined> = process.env, stdout: { isTTY?: boolean } = process.stdout): boolean {
  return !!env.NO_COLOR || !stdout.isTTY;
}

const ARROW_WORDS: Record<string, string> = { "→": "to", "←": "from", "↑": "up", "↓": "down", "▲": "up", "▼": "down" };
const ARROW = /[←→↑↓▲▼]/;

/**
 * An arrow the CLI writes itself, beside text it did not (`gold → gold's
 * market news`), in words when output is plain: "to" for `→`. Table cells
 * and headers are worded by `renderTable`; nothing else is rewritten.
 */
export function cliArrow(arrow: "→" | "←" | "↑" | "↓"): string {
  return cliPlainEnabled() ? ARROW_WORDS[arrow]! : arrow;
}

/**
 * Arrows as the words they stand for, so a screen reader says them: a range
 * `2026-04-03 → 04-06` reads "2026-04-03 to 04-06", `+25bp ↑` "+25bp up",
 * the keys `←/→` "left/right". Text without an arrow is returned as it is.
 * For a plain table's cells and headers, never a whole output.
 */
export function plainWords(text: string): string {
  if (!ARROW.test(text)) return text;
  return text
    .replace(/←\s*\/\s*→/g, "left/right")
    .replace(/↑\s*\/\s*↓/g, "up/down")
    .replace(/([ \t]*)([←→↑↓▲▼])([ \t]*)/g, (match: string, lead: string, arrow: string, _trail: string, offset: number, whole: string) => {
      // An arrow that starts a line keeps the line's indent; one that ends it leaves no space after its word.
      const atStart = offset === 0 || whole[offset - 1] === "\n";
      const end = offset + match.length;
      const atEnd = end === whole.length || whole[end] === "\n";
      return `${atStart ? lead : " "}${ARROW_WORDS[arrow]}${atEnd ? "" : " "}`;
    });
}

/** A table header's sort mark in words: `MKT VAL ▼` is "MKT VAL (sorted descending)". */
function plainHeader(header: string, ascii: boolean): string {
  const sorted = header.replace(/\s*([▲▼])\s*$/, (_match, mark: string) => ` (sorted ${mark === "▲" ? "ascending" : "descending"})`);
  const worded = plainWords(sorted.trimStart());
  return ascii ? asciiText(worded) : worded;
}

/**
 * A plain table's cell: arrows in words, and "—" for no value. In ASCII
 * (`cliAsciiEnabled`) before the columns are measured, so `EUR211.25` lines
 * up as `€211.25` did.
 */
function plainCell(cell: string, ascii: boolean): string {
  const plain = EMPTY_CELL.test(stripAnsi(cell).trim()) ? PLAIN_EMPTY_CELL : plainWords(cell);
  return ascii ? asciiText(plain) : plain;
}

function applyAnsi(text: string, code: string): string {
  if (!colorEnabled()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export function visibleLength(text: string): number {
  // Bun counts wide glyphs as two cells and skips escape codes; other hosts only need the ASCII case.
  return typeof Bun !== "undefined" ? Bun.stringWidth(text) : stripAnsi(text).length;
}

/** `--width n`: tables, help and wrapped text fit n columns, whether or not stdout is a terminal. */
export function setCliWidthOverride(value: number | null): void {
  widthOverride = value;
}

/** Columns the output is fitted to: `--width`, else the terminal's, or null when output is piped or redirected. */
export function cliTerminalWidth(): number | null {
  if (widthOverride != null) return widthOverride;
  if (renderingForFile || !process.stdout.isTTY) return null;
  const columns = process.stdout.columns;
  return typeof columns === "number" && columns > 0 ? columns : null;
}

function padDisplay(text: string, width: number, align: CliAlign = "left"): string {
  const padding = Math.max(0, width - visibleLength(text));
  if (padding === 0) return text;

  if (align === "right") return `${" ".repeat(padding)}${text}`;
  if (align === "center") {
    const left = Math.floor(padding / 2);
    const right = padding - left;
    return `${" ".repeat(left)}${text}${" ".repeat(right)}`;
  }
  return `${text}${" ".repeat(padding)}`;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Cuts text to `width` cells, ending in an ellipsis, without breaking escape codes or emoji. */
export function truncateDisplay(text: string, width: number): string {
  if (visibleLength(text) <= width) return text;
  if (width <= 0) return "";
  let output = "";
  let used = 0;
  let styled = false;
  // Escape codes pass through at no width; the text between them is cut on whole graphemes.
  for (const part of text.split(ANSI_SPLIT)) {
    if (ANSI_PREFIX.test(part)) {
      output += part;
      styled = true;
      continue;
    }
    for (const { segment } of graphemes.segment(part)) {
      const segmentWidth = visibleLength(segment);
      if (used + segmentWidth > width - 1) return `${output}${ELLIPSIS}${styled ? "\x1b[0m" : ""}`;
      output += segment;
      used += segmentWidth;
    }
  }
  return `${output}${ELLIPSIS}${styled ? "\x1b[0m" : ""}`;
}

/**
 * Word-wraps text to `width` cells. Lines that already fit are kept verbatim, so aligned
 * columns survive; continuation lines keep the paragraph's leading indent.
 */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (visibleLength(paragraph) <= width) {
      lines.push(paragraph);
      continue;
    }
    const indent = /^ */.exec(paragraph)![0];
    const words = paragraph.slice(indent.length).split(/ +/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = indent;
    let lineWidth = indent.length;
    let lineHasWord = false;
    for (const word of words) {
      const wordWidth = visibleLength(word);
      if (lineHasWord && lineWidth + 1 + wordWidth > width) {
        lines.push(line);
        line = indent;
        lineWidth = indent.length;
        lineHasWord = false;
      }
      line += lineHasWord ? ` ${word}` : word;
      lineWidth += (lineHasWord ? 1 : 0) + wordWidth;
      lineHasWord = true;
    }
    lines.push(line);
  }
  return lines;
}

/** One line of text under a table, wrapped to the width the table was fitted to; whole when output is not fitted. */
export function wrapToTerminal(text: string): string {
  const width = cliTerminalWidth();
  return width == null ? text : wrapText(text, width).join("\n");
}

export const cliStyles = {
  bold: (text: string) => applyAnsi(text, "1"),
  dim: (text: string) => applyAnsi(text, "2"),
  muted: (text: string) => applyAnsi(text, "90"),
  accent: (text: string) => applyAnsi(text, "1;36"),
  heading: (text: string) => applyAnsi(text, "1;33"),
  command: (text: string) => applyAnsi(text, "36"),
  success: (text: string) => applyAnsi(text, "32"),
  warning: (text: string) => applyAnsi(text, "33"),
  danger: (text: string) => applyAnsi(text, "31"),
  positive: (text: string) => applyAnsi(text, "32"),
  negative: (text: string) => applyAnsi(text, "31"),
};

export function colorBySign(text: string, value: number | undefined | null): string {
  if (value == null || value === 0) return text;
  return value > 0 ? cliStyles.positive(text) : cliStyles.negative(text);
}

export function renderSection(title: string): string {
  return cliStyles.heading(title);
}

/** One aligned label/value line. Prefer renderStats for a block so every value lines up. */
export function renderStat(label: string, value: string, labelWidth = 16): string {
  return `${cliStyles.muted(padDisplay(label, Math.max(labelWidth, visibleLength(label) + 1)))} ${value}`.trimEnd();
}

export interface CliStatsOptions {
  indent?: number;
  /** Width the block wraps within. Defaults to the terminal width; null never wraps. */
  width?: number | null;
}

/** Cells left for values after a block's labels, for callers that build nested values. */
export function statValueWidth(entries: readonly CliStatEntry[], options: CliStatsOptions = {}): number | null {
  const width = options.width === undefined ? cliTerminalWidth() : options.width;
  if (width == null) return null;
  const labelWidth = Math.max(0, ...entries.map(([label]) => visibleLength(label)));
  return Math.max(20, width - (options.indent ?? 0) - labelWidth - COLUMN_GAP);
}

/** A block of label/value lines aligned on the longest label. Values wrap under themselves. */
export function renderStats(entries: readonly CliStatEntry[], options: CliStatsOptions = {}): string {
  const indent = " ".repeat(options.indent ?? 0);
  const labelWidth = Math.max(0, ...entries.map(([label]) => visibleLength(label)));
  const valueIndent = `${indent}${" ".repeat(labelWidth + COLUMN_GAP)}`;
  const valueWidth = statValueWidth(entries, options);
  return entries.map(([label, value]) => {
    const valueLines = valueWidth == null ? value.split("\n") : wrapText(value, valueWidth);
    const [first = "", ...rest] = valueLines;
    return [
      `${indent}${cliStyles.muted(padDisplay(label, labelWidth))}${" ".repeat(COLUMN_GAP)}${first}`.trimEnd(),
      ...rest.map((line) => `${valueIndent}${line}`.trimEnd()),
    ].join("\n");
  }).join("\n");
}

/** A command line wrapped to `width`, continuation lines indented under the command. */
export function wrapCommandLine(text: string, width: number, indent = 2): string[] {
  const hanging = indent + 4;
  const [first = "", ...rest] = wrapText(text, Math.max(1, width - hanging));
  return [`${" ".repeat(indent)}${first}`, ...rest.map((line) => `${" ".repeat(hanging)}${line}`)];
}

export interface CliDefinitionOptions {
  /** Total width descriptions wrap within. */
  width: number;
  indent?: number;
  termStyle?: (text: string) => string;
  /** Column width for terms; defaults to the longest term so several lists can share one. */
  termWidth?: number;
}

const DEFINITION_GAP = 3;
const MIN_DEFINITION_WIDTH = 24;
const MIN_TERM_WIDTH = 12;
const MAX_TERM_SHARE = 0.4;

/** Terms on the left and their descriptions wrapped in a column on the right, as in help text. */
export function renderDefinitions(entries: ReadonlyArray<readonly [string, string]>, options: CliDefinitionOptions): string[] {
  const indent = options.indent ?? 2;
  const longestTerm = Math.max(0, ...entries.map(([term]) => visibleLength(term)));
  // One long term (an option listing every accepted value) must not push every description aside.
  const termWidth = Math.min(options.termWidth ?? longestTerm, Math.max(MIN_TERM_WIDTH, Math.floor(options.width * MAX_TERM_SHARE)));
  const sideBySide = options.width - (indent + termWidth + DEFINITION_GAP) >= MIN_DEFINITION_WIDTH;
  const descriptionIndent = sideBySide ? indent + termWidth + DEFINITION_GAP : indent + 4;
  const descriptionWidth = Math.max(1, options.width - descriptionIndent);
  const lines: string[] = [];
  for (const [term, description] of entries) {
    const styledTerm = options.termStyle ? options.termStyle(term) : term;
    const described = wrapText(description, descriptionWidth);
    if (!sideBySide || visibleLength(term) > termWidth) {
      // The description goes under its term.
      lines.push(`${" ".repeat(indent)}${styledTerm}`);
      for (const line of described) lines.push(`${" ".repeat(descriptionIndent)}${line}`);
      continue;
    }
    const padding = " ".repeat(termWidth - visibleLength(term) + DEFINITION_GAP);
    const [first = "", ...rest] = described;
    lines.push(`${" ".repeat(indent)}${styledTerm}${padding}${first}`.trimEnd());
    for (const line of rest) lines.push(`${" ".repeat(descriptionIndent)}${line}`);
  }
  return lines;
}

function tableWidth(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + COLUMN_GAP * Math.max(0, widths.length - 1);
}

/** Takes cells from the widest of `candidates` until `overflow` is gone or they reach their floors. */
function shrinkWidest(fitted: number[], floors: number[], candidates: number[], overflow: number): number {
  let remaining = overflow;
  while (remaining > 0) {
    let widest = -1;
    for (const index of candidates) {
      if (fitted[index]! <= floors[index]!) continue;
      if (widest < 0 || fitted[index]! > fitted[widest]!) widest = index;
    }
    if (widest < 0) break;
    fitted[widest] = fitted[widest]! - 1;
    remaining -= 1;
  }
  return remaining;
}

/** Column widths that fit `maxWidth`, or null when even the narrowest allowed widths do not. */
function fitColumnWidths(widths: number[], floors: number[], maxWidth: number): number[] | null {
  const fitted = [...widths];
  let overflow = tableWidth(fitted) - maxWidth;
  if (overflow <= 0) return fitted;
  // Long text columns (titles, descriptions, messages) give way before short values such as dates,
  // statuses, and categories lose a single cell. The rightmost long column goes first.
  const long = fitted.map((width, index) => index).filter((index) => fitted[index]! > SOFT_MIN_COLUMN_WIDTH);
  for (const index of [...long].reverse()) {
    if (overflow <= 0) break;
    const cut = Math.min(overflow, Math.max(0, fitted[index]! - Math.max(floors[index]!, SOFT_MIN_COLUMN_WIDTH)));
    fitted[index] = fitted[index]! - cut;
    overflow -= cut;
  }
  overflow = shrinkWidest(fitted, floors, long, overflow);
  const short = fitted.map((width, index) => index).filter((index) => !long.includes(index));
  overflow = shrinkWidest(fitted, floors, short, overflow);
  return overflow > 0 ? null : fitted;
}

function isWholeValue(text: string): boolean {
  if (DATE_CELL.test(text)) return true;
  const parts = text.split(/ +/);
  return parts.some((part) => NUMBER_TOKEN.test(part)) && parts.every((part) => NUMBER_TOKEN.test(part) || NUMBER_JOINER.test(part));
}

/** Every filled cell is a date or a number, which a cut would change into another one. */
function isWholeColumn(cells: readonly string[]): boolean {
  let filled = false;
  for (const cell of cells) {
    const text = stripAnsi(cell).trim();
    if (EMPTY_CELL.test(text)) continue;
    if (!isWholeValue(text)) return false;
    filled = true;
  }
  return filled;
}

interface TableEntry {
  column: CliTableColumn;
  index: number;
  width: number;
  /** The narrowest the column may get. */
  floor: number;
  /** Text that wraps onto more lines of its cell rather than being cut. */
  wraps: boolean;
  /** Words rather than dates, figures or fixed-width values. */
  text: boolean;
}

/**
 * How narrow a column may get. Cells are whole by default: a date, a figure,
 * a symbol, a name or a title cut short reads as another one. Text wraps in
 * its cell down to its longest word or `minWidth` (MIN_WRAPPED_COLUMN_WIDTH
 * unless set); `shrink: false` keeps it on one line. Only free text marked
 * `shrink: true` is cut, to its header and `minWidth`.
 */
function columnFloor(column: CliTableColumn, width: number, cells: readonly string[], capped: boolean): Pick<TableEntry, "floor" | "wraps" | "text"> {
  if (column.width != null || column.align === "right" || isWholeColumn(cells)) return { floor: width, wraps: false, text: false };
  // Cut at its `maxWidth`, as the column asks.
  if (capped) return { floor: width, wraps: false, text: true };
  if (column.shrink === true) {
    return { floor: Math.min(width, Math.max(MIN_SHRUNK_COLUMN_WIDTH, visibleLength(column.header), column.minWidth ?? 0)), wraps: false, text: true };
  }
  if (column.shrink === false) return { floor: width, wraps: false, text: true };
  const words = cells.flatMap((cell) => stripAnsi(cell).split(/\s+/));
  const longestWord = Math.max(visibleLength(column.header), ...words.map((word) => visibleLength(word)));
  return { floor: Math.min(width, Math.max(longestWord, column.minWidth ?? MIN_WRAPPED_COLUMN_WIDTH)), wraps: true, text: true };
}

/** A cell's text wrapped to `width`, each line closing the colour it opens and the next reopening it, so it never bleeds into the next column. */
function wrapCell(text: string, width: number): string[] {
  const lines = wrapText(text, width);
  if (lines.length < 2 || !text.includes("\x1b[")) return lines;
  let open = "";
  return lines.map((line) => {
    const carried = open;
    for (const code of line.match(ANSI_PATTERN) ?? []) open = code === "\x1b[0m" ? "" : `${open}${code}`;
    return `${carried}${line}${open ? "\x1b[0m" : ""}`;
  });
}

interface TableLayout {
  kept: TableEntry[];
  stacked: TableEntry[];
}

/** Which of two columns moves under the rows sooner: by the first value that differs. */
function movesSooner(left: readonly number[], right: readonly number[]): boolean {
  const at = left.findIndex((value, index) => value !== right[index]);
  return at >= 0 && left[at]! > right[at]!;
}

/**
 * The ways a table too wide can fit `available`, each moving one more column
 * under the rows, where its values print whole. In each, text wraps in its
 * cell and free text marked `shrink: true` is cut, down to their floors.
 * Columns move in this order: the ones too wide to ever sit beside the first
 * column (a long headline, a note), then by `stackPriority`, then long text
 * (a name, a title) before dates and figures, then rightmost first. The
 * first column stays. The list ends at the first layout that keeps every
 * column it shows whole on one line: moving more only adds lines.
 */
function tableLayouts(entries: TableEntry[], available: number): TableLayout[] {
  const fit = (kept: TableEntry[]) => fitColumnWidths(kept.map((entry) => entry.width), kept.map((entry) => entry.floor), available);
  const first = entries[0]!;
  const room = available - first.floor - COLUMN_GAP;
  const order = (entry: TableEntry) => [
    entry.floor > room ? 1 : 0,
    entry.column.stackPriority ?? 0,
    entry.text && entry.width > SOFT_MIN_COLUMN_WIDTH ? 1 : 0,
    entry.index,
  ];
  const layouts: TableLayout[] = [];
  let kept = entries;
  const stacked: TableEntry[] = [];
  for (;;) {
    const widths = fit(kept);
    if (widths) {
      layouts.push({ kept: kept.map((entry, position) => ({ ...entry, width: widths[position]! })), stacked: [...stacked] });
      if (widths.every((width, position) => width >= kept[position]!.width)) break;
    }
    if (kept.length === 1) break;
    const moved = kept.slice(1).reduce((pick, entry) => (movesSooner(order(entry), order(pick)) ? entry : pick));
    kept = kept.filter((entry) => entry !== moved);
    stacked.push(moved);
  }
  // The first column alone is wider than the table may be: text wraps and free text is cut to the
  // whole width; a symbol or a figure stays whole.
  if (layouts.length === 0) layouts.push({ kept: [{ ...first, width: first.wraps || first.column.shrink === true ? available : first.width }], stacked });
  return layouts;
}

function renderTableLayout(
  columns: CliTableColumn[],
  rows: string[][],
  options: CliTableOptions,
  shown: readonly TableEntry[],
  stacked: readonly TableEntry[],
  available: number | null,
  /** Cells wrap or are cut to their column's width: the table was fitted to `available`. */
  fitted: boolean,
): string {
  const indent = " ".repeat(options.indent ?? 0);
  const renderRow = (cells: string[], style?: (text: string) => string) => {
    const columnLines = shown.map(({ index, width, wraps }) => {
      const cell = cells[index] ?? "";
      if (!fitted) return [cell];
      return wraps ? wrapCell(cell, width) : [truncateDisplay(cell, width)];
    });
    // A cell that wraps makes its row taller; the other cells sit on the row's first line.
    const height = Math.max(1, ...columnLines.map((lines) => lines.length));
    return Array.from({ length: height }, (_, line) => {
      const rendered = shown.map(({ column, width }, position) => {
        const cell = columnLines[position]![line] ?? "";
        // The last left-aligned column is not padded so lines carry no trailing spaces.
        const padded = position === shown.length - 1 && (column.align ?? "left") === "left"
          ? cell
          : padDisplay(cell, width, column.align ?? "left");
        return style && (line === 0 || cell) ? style(padded) : padded;
      });
      return `${indent}${rendered.join(" ".repeat(COLUMN_GAP))}`.trimEnd();
    }).join("\n");
  };

  const header = renderRow(columns.map((column) => column.header), cliStyles.bold);
  // A plain table has no rule under its header: a screen reader reads it as a row of dashes.
  const divider = cliPlainEnabled() ? [] : [`${indent}${shown.map(({ width }) => cliStyles.muted("─".repeat(width))).join(" ".repeat(COLUMN_GAP))}`];
  const belowIndent = `${indent}${" ".repeat(COLUMN_GAP)}`;
  const belowWidth = Math.max(1, (available ?? 0) - COLUMN_GAP);
  const renderBelow = (index: number) => (options.below?.[index] ?? []).flatMap((line) => (
    available == null ? [line] : options.cutBelow ? [truncateDisplay(line, belowWidth)] : wrapText(line, belowWidth)
  )).map((line) => `${belowIndent}${cliStyles.muted(line)}`.trimEnd());
  // Columns moved under the rows print there as `Header value`, as many to a line as fit.
  const renderStacked = (cells: string[], rowIndex: number): string[] => {
    const lines: string[] = [];
    let line = "";
    for (const { column, index } of stacked) {
      const value = cells[index] ?? "";
      if (rowIndex >= (column.stackRows ?? Infinity) || EMPTY_CELL.test(stripAnsi(value).trim())) continue;
      const piece = `${cliStyles.muted(column.header)} ${value}`;
      if (line && visibleLength(line) + COLUMN_GAP + visibleLength(piece) <= belowWidth) {
        line += `${" ".repeat(COLUMN_GAP)}${piece}`;
        continue;
      }
      if (line) lines.push(line);
      line = piece;
      if (visibleLength(piece) <= belowWidth) continue;
      // Too long for one line: the value wraps under itself, or under its header when the header is long too.
      const hangs = visibleLength(column.header) + 1 <= belowWidth / 2;
      const valueIndent = " ".repeat(hangs ? visibleLength(column.header) + 1 : COLUMN_GAP);
      const [first = "", ...rest] = wrapText(value, Math.max(1, belowWidth - valueIndent.length));
      lines.push(
        ...hangs ? [`${cliStyles.muted(column.header)} ${first}`] : [cliStyles.muted(column.header), `${valueIndent}${first}`],
        ...rest.map((part) => `${valueIndent}${part}`),
      );
      line = "";
    }
    if (line) lines.push(line);
    return lines.map((text) => `${belowIndent}${text}`.trimEnd());
  };
  return [header, ...divider, ...rows.flatMap((row, index) => [renderRow(row), ...renderStacked(row, index), ...renderBelow(index)])].join("\n");
}

/**
 * A table fitted to the terminal (or `--width`), or whole when output is
 * piped. A table too wide never cuts a cell short, unless its column is free
 * text marked `shrink: true`: text wraps in its cell and columns move under
 * their rows, each value whole after its header. Of the ways that fit, the
 * one with the fewest lines prints, the one that moves fewer columns on a tie.
 * Plain output (`setCliPlainOverride`) has no rule under the header, words
 * for arrows and "—" in every empty cell.
 */
export function renderTable(columns: CliTableColumn[], rows: string[][], options: CliTableOptions = {}): string {
  if (cliPlainEnabled()) {
    const ascii = cliAsciiEnabled();
    columns = columns.map((column) => ({ ...column, header: plainHeader(column.header, ascii) }));
    rows = rows.map((row) => columns.map((_, index) => plainCell(row[index] ?? "", ascii)));
    if (options.below) options = { ...options, below: options.below.map((lines) => lines?.map((line) => ascii ? asciiText(plainWords(line)) : plainWords(line))) };
  }
  const maxWidth = options.maxWidth === undefined ? cliTerminalWidth() : options.maxWidth;
  const available = maxWidth == null ? null : maxWidth - (options.indent ?? 0);
  let shown = columns.map((column, index) => {
    const cellWidths = rows.map((row) => visibleLength(row[index] ?? ""));
    return { column, index, width: column.width ?? Math.max(visibleLength(column.header), ...cellWidths), floor: 0, wraps: false, text: false };
  }).filter(({ column }) => maxWidth == null || column.minTableWidth == null || maxWidth >= column.minTableWidth);
  // Cells are only cut or wrapped when the table is fitted to a terminal; piped output keeps them whole.
  if (available == null || tableWidth(shown.map((entry) => entry.width)) <= available) {
    return renderTableLayout(columns, rows, options, shown, [], available, false);
  }
  while (tableWidth(shown.map((entry) => entry.width)) > available) {
    const dropped = shown.reduce<(typeof shown)[number] | undefined>((pick, entry) => (
      entry.column.optional && (!pick || (entry.column.dropPriority ?? 0) >= (pick.column.dropPriority ?? 0)) ? entry : pick
    ), undefined);
    if (!dropped) break;
    shown = shown.filter((entry) => entry !== dropped);
  }
  const entries = shown.map((entry) => {
    const width = entry.column.maxWidth == null
      ? entry.width
      : Math.min(entry.width, Math.max(entry.column.maxWidth, visibleLength(entry.column.header)));
    return { ...entry, width, ...columnFloor(entry.column, width, rows.map((row) => row[entry.index] ?? ""), width < entry.width) };
  });
  let best = "";
  let bestLines = Infinity;
  for (const layout of tableLayouts(entries, available)) {
    const stacked = layout.stacked.filter((entry) => entry.column.stackRows !== 0).sort((left, right) => left.index - right.index);
    const text = renderTableLayout(columns, rows, options, layout.kept, stacked, available, true);
    const lines = text.split("\n").length;
    if (lines < bestLines) {
      best = text;
      bestLines = lines;
    }
  }
  return best;
}
