type CliAlign = "left" | "right" | "center";

export interface CliTableColumn {
  header: string;
  align?: CliAlign;
  width?: number;
  /** Cap for this column when the table is fitted to a terminal. Piped output stays whole. */
  maxWidth?: number;
  /** Dropped, rightmost first, before other columns are shortened to fit a terminal. */
  optional?: boolean;
  /** False keeps the column whole when fitting, for identifiers a user types into the next command. */
  shrink?: boolean;
}

export interface CliTableOptions {
  /** Total width to fit the table into. Defaults to the terminal width; null keeps every cell whole. */
  maxWidth?: number | null;
  indent?: number;
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
let colorEnabledOverride: boolean | null = null;

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

/** Columns of the terminal stdout writes to, or null when output is piped or redirected. */
export function cliTerminalWidth(): number | null {
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
function fitColumnWidths(columns: CliTableColumn[], widths: number[], maxWidth: number): number[] | null {
  const fitted = [...widths];
  let overflow = tableWidth(fitted) - maxWidth;
  if (overflow <= 0) return fitted;
  // Fixed, right-aligned (numeric), and non-shrinking columns keep their width.
  const floors = columns.map((column, index) => (
    column.width != null || column.align === "right" || column.shrink === false
      ? fitted[index]!
      : Math.min(fitted[index]!, Math.max(MIN_SHRUNK_COLUMN_WIDTH, visibleLength(column.header)))
  ));
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

export function renderTable(columns: CliTableColumn[], rows: string[][], options: CliTableOptions = {}): string {
  const indent = " ".repeat(options.indent ?? 0);
  const maxWidth = options.maxWidth === undefined ? cliTerminalWidth() : options.maxWidth;
  const available = maxWidth == null ? null : maxWidth - indent.length;
  let shown = columns.map((column, index) => {
    const cellWidths = rows.map((row) => visibleLength(row[index] ?? ""));
    return { column, index, width: column.width ?? Math.max(visibleLength(column.header), ...cellWidths) };
  });
  // Cells are only cut when the table was fitted to a terminal; piped output keeps them whole.
  let truncate = false;
  if (available != null && tableWidth(shown.map((entry) => entry.width)) > available) {
    while (tableWidth(shown.map((entry) => entry.width)) > available) {
      const dropped = shown.findLast((entry) => entry.column.optional);
      if (!dropped) break;
      shown = shown.filter((entry) => entry !== dropped);
    }
    const capped = shown.map((entry) => (entry.column.maxWidth == null
      ? entry.width
      : Math.min(entry.width, Math.max(entry.column.maxWidth, visibleLength(entry.column.header)))));
    const fitted = fitColumnWidths(shown.map((entry) => entry.column), capped, available);
    // A table that cannot fit even at its narrowest keeps every cell whole rather than losing data and overflowing anyway.
    if (fitted) {
      shown = shown.map((entry, position) => ({ ...entry, width: fitted[position]! }));
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
  return [header, divider, ...rows.map((row) => renderRow(row))].join("\n");
}
