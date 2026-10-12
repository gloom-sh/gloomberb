type CliAlign = "left" | "right" | "center";

export interface CliTableColumn {
  header: string;
  align?: CliAlign;
  width?: number;
  /** Cap for this column when the table is fitted to a terminal. Piped output stays whole. */
  maxWidth?: number;
  /** The narrowest a text column is cut to, so it never shrinks to a stub that reads like another row's; a narrower table moves columns under their rows. */
  minWidth?: number;
  /** Dropped, rightmost first, before other columns are shortened to fit a terminal. */
  optional?: boolean;
  /** Among optional columns, a higher priority is dropped sooner; equal ones go rightmost first. */
  dropPriority?: number;
  /** False keeps the column whole when fitting, for identifiers a user types into the next command. */
  shrink?: boolean;
  /**
   * When the table cannot fit even with its text shortened, columns move to
   * lines under their row, each value after its header: a higher priority
   * moves sooner, equal ones go rightmost first. The first column stays.
   */
  stackPriority?: number;
  /** Once moved under the rows, only the first `stackRows` rows print the column; 0 leaves it out. */
  stackRows?: number;
}

export interface CliTableOptions {
  /** Total width to fit the table into. Defaults to the terminal width; null keeps every cell whole. */
  maxWidth?: number | null;
  indent?: number;
  /** Lines printed under each row, by row index, indented and muted: a footnote that belongs to the row. */
  below?: ReadonlyArray<readonly string[] | undefined>;
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
// Cells that say "no value": a moved column prints nothing for them.
const EMPTY_CELL = /^(?:|-{1,2}|—|–)$/;
// A date, or a date and time, as reports print them (`2026-10-09`, `2026-10`, `2026-10-09 20:15 UTC`).
const DATE_CELL = /^\d{4}-\d{2}(?:-\d{2})?(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?: ?UTC)?)?(?: \([^)]*\))?$/;
// A number with its sign, currency, unit or range (`-1.0bp`, `$1,200`, `3.75-4.00%`, `481.75c`).
const NUMBER_PART = String.raw`[+\-−±]?[$€£¥]?\d[\d,]*(?:\.\d+)?`;
const NUMBER_TOKEN = new RegExp(String.raw`^\(?${NUMBER_PART}(?:[-–]${NUMBER_PART})?(?:%|¢|[a-zA-Z]{1,3})?\)?$`);
// What may sit between the numbers of one cell (`3.875% 82% / 4.125% 18%`, `+25bp ↑`).
const NUMBER_JOINER = /^(?:\/|·|→|↑|↓|[-–])$/;
let colorEnabledOverride: boolean | null = null;
let widthOverride: number | null = null;

function colorEnabled(): boolean {
  if (colorEnabledOverride != null) return colorEnabledOverride;
  return !!process.stdout.isTTY && process.env.NO_COLOR !== "1" && process.env.TERM !== "dumb";
}

export function setCliColorEnabledOverride(value: boolean | null): void {
  colorEnabledOverride = value;
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
  if (!process.stdout.isTTY) return null;
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
  /** The narrowest the column may be cut to. */
  floor: number;
  /** Every filled cell is a date or a figure. */
  figures: boolean;
}

/** The narrowest a column may get: whole for figures and ids; text keeps its header and its `minWidth`. */
function columnFloor(column: CliTableColumn, width: number): number {
  if (column.width != null || column.align === "right" || column.shrink === false) return width;
  return Math.min(width, Math.max(MIN_SHRUNK_COLUMN_WIDTH, visibleLength(column.header), column.minWidth ?? 0));
}

/**
 * The columns that stay in the table, at widths that fit `available`, and the
 * ones moved under each row. Text shrinks first, as it always has. A table
 * still too wide keeps every date and figure whole and moves columns under
 * the rows, by `stackPriority`, then rightmost first, until the rest fits.
 * Null when the first column alone does not fit.
 */
function fitTableLayout(entries: TableEntry[], available: number): { kept: TableEntry[]; stacked: TableEntry[] } | null {
  const fit = (kept: TableEntry[], wholeFigures: boolean) => fitColumnWidths(
    kept.map((entry) => entry.width),
    kept.map((entry) => (wholeFigures && entry.figures ? entry.width : entry.floor)),
    available,
  );
  let kept = entries;
  const stacked: TableEntry[] = [];
  let widths = fit(kept, false);
  if (!widths) widths = fit(kept, true);
  while (!widths && kept.length > 1) {
    const moved = kept.slice(1).reduce((pick, entry) => (
      (entry.column.stackPriority ?? 0) >= (pick.column.stackPriority ?? 0) ? entry : pick
    ));
    kept = kept.filter((entry) => entry !== moved);
    stacked.push(moved);
    widths = fit(kept, true);
  }
  if (!widths) return null;
  const fitted = widths;
  return { kept: kept.map((entry, position) => ({ ...entry, width: fitted[position]! })), stacked };
}

export function renderTable(columns: CliTableColumn[], rows: string[][], options: CliTableOptions = {}): string {
  const indent = " ".repeat(options.indent ?? 0);
  const maxWidth = options.maxWidth === undefined ? cliTerminalWidth() : options.maxWidth;
  const available = maxWidth == null ? null : maxWidth - indent.length;
  let shown = columns.map((column, index) => {
    const cellWidths = rows.map((row) => visibleLength(row[index] ?? ""));
    return { column, index, width: column.width ?? Math.max(visibleLength(column.header), ...cellWidths) };
  });
  let stacked: Array<(typeof shown)[number]> = [];
  // Cells are only cut when the table was fitted to a terminal; piped output keeps them whole.
  let truncate = false;
  if (available != null && tableWidth(shown.map((entry) => entry.width)) > available) {
    while (tableWidth(shown.map((entry) => entry.width)) > available) {
      const dropped = shown.reduce<(typeof shown)[number] | undefined>((pick, entry) => (
        entry.column.optional && (!pick || (entry.column.dropPriority ?? 0) >= (pick.column.dropPriority ?? 0)) ? entry : pick
      ), undefined);
      if (!dropped) break;
      shown = shown.filter((entry) => entry !== dropped);
    }
    const layout = fitTableLayout(shown.map((entry) => {
      const width = entry.column.maxWidth == null
        ? entry.width
        : Math.min(entry.width, Math.max(entry.column.maxWidth, visibleLength(entry.column.header)));
      return { ...entry, width, floor: columnFloor(entry.column, width), figures: isWholeColumn(rows.map((row) => row[entry.index] ?? "")) };
    }), available);
    // A first column that cannot fit even alone keeps every cell whole rather than losing data and overflowing anyway.
    if (layout) {
      shown = layout.kept;
      stacked = layout.stacked.filter((entry) => entry.column.stackRows !== 0).sort((left, right) => left.index - right.index);
      truncate = true;
    }
  }

  const renderRow = (cells: string[], style?: (text: string) => string) => {
    const rendered = shown.map(({ column, index, width }, position) => {
      const cell = truncate ? truncateDisplay(cells[index] ?? "", width) : cells[index] ?? "";
      // The last left-aligned column is not padded so lines carry no trailing spaces.
      const padded = position === shown.length - 1 && (column.align ?? "left") === "left"
        ? cell
        : padDisplay(cell, width, column.align ?? "left");
      return style ? style(padded) : padded;
    });
    return `${indent}${rendered.join(" ".repeat(COLUMN_GAP))}`.trimEnd();
  };

  const header = renderRow(columns.map((column) => column.header), cliStyles.bold);
  const divider = `${indent}${shown.map(({ width }) => cliStyles.muted("─".repeat(width))).join(" ".repeat(COLUMN_GAP))}`;
  const belowIndent = `${indent}${" ".repeat(COLUMN_GAP)}`;
  const belowWidth = Math.max(1, (available ?? 0) - COLUMN_GAP);
  const renderBelow = (index: number) => (options.below?.[index] ?? []).flatMap((line) => (
    available == null ? [line] : wrapText(line, belowWidth)
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
  return [header, divider, ...rows.flatMap((row, index) => [renderRow(row), ...renderStacked(row, index), ...renderBelow(index)])].join("\n");
}
