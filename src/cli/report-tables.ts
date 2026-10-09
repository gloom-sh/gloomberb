/**
 * Reports as flat tables, for `--csv` and `--ndjson`: the columns the text
 * view shows, one row per row it shows, and values a spreadsheet can use.
 * Numbers drop the thousands commas, compact scales and units the text draws
 * (the unit moves into the header, as table CSV exports do), times are ISO,
 * and nothing is a JSON blob. CSV writes a report with several tables as
 * stacked blocks under `# section:` lines and ends with `#` lines for the
 * source, as-of, notes and errors.
 */
import { serializeCsv } from "../utils/csv";
import {
  BLANK_DISPLAY,
  DISPLAY_PLACEHOLDER,
  labelWithUnit,
  parseDisplayNumber,
  type DisplayNumber,
} from "../utils/display-number";
import { isEpochMilliseconds, parseReportTime } from "../utils/utc-time";
import { formatFreshnessLine, type ReportFreshness } from "./pane-functions/freshness";

type CliReportValue = string | number;

/** One table of a report, as CSV and NDJSON write it. */
export interface CliReportTable {
  /** The section title; CSV names it in a `# section:` line when it writes several tables. */
  title: string;
  /** The column names the text view shows, with the unit the cells dropped. */
  columns: string[];
  /** Numbers, ISO times and text; an empty string for a missing value. */
  rows: CliReportValue[][];
}

export interface CliReportTables {
  tables: CliReportTable[];
  /** What CSV writes after the data as `#` lines: source and as-of, completeness, errors, notes. */
  footer: string[];
}

/** A column as a report declares it: the text view draws `format(value, row)`, or the value itself. */
export interface CliReportColumn<Row = Record<string, unknown>> {
  key: string;
  /** The header as the text view prints it. */
  header: string;
  align?: "left" | "right" | "center";
  format?: (value: unknown, row: Row) => string;
}

/** A label/value line of a report. `unit` names the unit of a numeric `value` when `formatted` cannot say it. */
export interface CliReportEntry {
  label: string;
  value: unknown;
  formatted?: string;
  key?: string;
  unit?: string;
}

type Cell =
  | { kind: "blank" }
  | { kind: "text"; text: string; time?: boolean }
  | { kind: "number"; value: number; unit: string }
  /** Text that may read as a number, once the whole column is known. */
  | { kind: "textual"; text: string };

type ResolvedCell = Exclude<Cell, { kind: "textual" }>;

interface ResolvedColumn {
  header: string;
  cells: ResolvedCell[];
}

const BLANK = { kind: "blank" } as const;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// Keys whose epoch-millisecond numbers are times rather than counts or prices.
const TIME_KEY = /(?:At|Time|Timestamp|Updated|AsOf|Date)$|^(?:asOf|date|time|timestamp|updated)$/;
// A value drawn with a change beside it, "416.2 +6.4%" or "1.20 (3%)": the value is the first figure.
const CHANGE_NOTE = /^\(?[+\-\u2212]?[\d.,]+%?\)?$/;
/**
 * How a value relates to the number drawn for it: as is, as a percent of a
 * fraction, or in thousands, millions or billions named by the header.
 */
const DISPLAY_SCALES = [1, 100, 0.01, 1e-3, 1e-6, 1e-9, 1e-12, 1e3, 1e6, 1e4];
// "3M" is as often a tenor as three million.
const BARE_SCALED = /^[+-]?\d+[kKMBT]$/;
// Beside "1Y" or "6W", "3M" is three months.
const TENOR = /^\d+\s*[DWQY]$/i;

/**
 * Some feeds store prices as float32, so 338.93 arrives as 338.929992676. A value
 * that is exactly a float32 reads as the shortest decimal that rounds back to it,
 * which leaves genuine doubles (never exactly float32 unless short) untouched.
 */
export function float32Shortest(value: number): number | null {
  if (Math.fround(value) !== value) return null;
  for (let digits = 1; digits <= 9; digits += 1) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === value) return candidate;
  }
  return null;
}

/**
 * A number without binary floating-point noise (47.350000000000364, 0.0615 * 100),
 * as the text view drops it: twelve significant digits, whole numbers and
 * amounts of a billion or more as they are.
 */
export function exportNumber(value: number): number {
  if (Number.isInteger(value) || Math.abs(value) >= 1e9) return Object.is(value, -0) ? 0 : value;
  const rounded = float32Shortest(value) ?? Number(value.toPrecision(12));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function isoInstant(time: number): string {
  return new Date(time).toISOString().replace(".000Z", "Z");
}

function text(value: string): Cell {
  return { kind: "text", text: value };
}

function time(value: string): Cell {
  return { kind: "text", text: value, time: true };
}

/** A drawn number read back. Leading zeros make a code ("0700", "000001"), not a number. */
function readDisplay(value: string): DisplayNumber | typeof BLANK_DISPLAY | null {
  const trimmed = value.trim();
  if (/^[+-]?0\d/.test(trimmed)) return null;
  return parseDisplayNumber(trimmed);
}

/** The value in the units the text drew, so a fraction drawn as 6.15% exports 6.15, or null when it is not what was drawn. */
function valueAsDrawn(value: number, drawn: DisplayNumber): number | null {
  const target = Number(drawn.number);
  const tolerance = drawn.step * (1 + 1e-9) + Number.EPSILON;
  for (const scale of DISPLAY_SCALES) {
    const scaled = value * scale;
    if (Math.abs(scaled - target) <= tolerance) return exportNumber(scaled);
  }
  return null;
}

function timeCell(instant: number, dateOnly: boolean, shown: string | null, raw?: string): Cell {
  if (!Number.isFinite(instant)) return shown ? { kind: "textual", text: shown } : BLANK;
  // A date the text drew from an instant (a monthly bar) stays the date it shows.
  if (shown != null && DATE_ONLY.test(shown)) return time(shown);
  if (raw != null && shown == null) return time(raw);
  return time(dateOnly ? new Date(instant).toISOString().slice(0, 10) : isoInstant(instant));
}

function numberCell(value: number, shown: string | null, key: string | undefined): Cell {
  if (!Number.isFinite(value)) return shown ? { kind: "textual", text: shown } : BLANK;
  if (key != null && TIME_KEY.test(key) && isEpochMilliseconds(value)) return timeCell(value, false, shown);
  if (shown == null) return { kind: "number", value: exportNumber(value), unit: "" };
  const drawn = readDisplay(shown);
  if (drawn === BLANK_DISPLAY) return BLANK;
  // "3M" drawn from 3 is a tenor or a code, not three million.
  if (drawn && BARE_SCALED.test(shown) && value === Number(shown.replace(/[kKMBT]$/, ""))) return text(shown);
  if (drawn) return { kind: "number", value: valueAsDrawn(value, drawn) ?? Number(drawn.number), unit: drawn.unit };
  // A time drawn as a date or a clock.
  if (isEpochMilliseconds(value)) return timeCell(value, false, shown);
  const [first, ...rest] = shown.split(/\s+/);
  const lead = rest.length > 0 && CHANGE_NOTE.test(rest.join(" ")) ? readDisplay(first!) : null;
  const scaled = lead && lead !== BLANK_DISPLAY ? valueAsDrawn(value, lead) : null;
  if (lead && lead !== BLANK_DISPLAY && scaled != null) return { kind: "number", value: scaled, unit: lead.unit };
  return text(shown);
}

/** Text for a nested value, never JSON: `a, b` for a list, `Key: value` pairs for a record. */
function flattenValue(value: unknown, depth = 0): string {
  if (value == null) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : isoInstant(value.getTime());
  if (typeof value === "number") return Number.isFinite(value) ? String(exportNumber(value)) : "";
  if (Array.isArray(value)) {
    return value.map((item) => flattenValue(item, depth + 1)).filter(Boolean).join(depth === 0 ? "; " : ", ");
  }
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, entry]) => [key, flattenValue(entry, depth + 1)] as const)
      .filter(([, entry]) => entry !== "")
      .map(([key, entry]) => `${key}: ${entry}`)
      .join(", ");
  }
  return String(value);
}

/** JSON text a row or a format handed over, as the flat text of what it holds; null for any other text. */
function flattenJsonText(value: string): string | null {
  if (!/^\s*[{[]/.test(value)) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed != null && typeof parsed === "object" ? flattenValue(parsed) : null;
  } catch {
    return null;
  }
}

/** A cell from its value and, when the column formats it, the text it draws. */
function exportCell(raw: unknown, display: string | null, key?: string): Cell {
  const shown = display?.trim() ?? null;
  if (shown != null && (shown === "" || DISPLAY_PLACEHOLDER.test(shown))) return BLANK;
  const json = flattenJsonText(shown ?? (typeof raw === "string" ? raw : ""));
  if (json != null) return json ? text(json) : BLANK;
  if (raw instanceof Date) return timeCell(raw.getTime(), false, shown);
  if (typeof raw === "number") return numberCell(raw, shown, key);
  if (typeof raw === "string") {
    const value = raw.trim();
    const reportTime = parseReportTime(value);
    if (reportTime) return timeCell(reportTime.time, reportTime.dateOnly, shown, value);
    const drawn = shown ?? value;
    return drawn === "" || DISPLAY_PLACEHOLDER.test(drawn) ? BLANK : { kind: "textual", text: drawn };
  }
  if (typeof raw === "boolean") return text(shown ?? String(raw));
  if (raw == null) return shown == null ? BLANK : { kind: "textual", text: shown };
  if (shown != null) return { kind: "textual", text: shown };
  const flat = flattenValue(raw);
  return flat ? text(flat) : BLANK;
}

/**
 * Text that reads as a number becomes one; text that does not, such as a
 * range "3.75-4.00%" or "N/M", stays as drawn. A bare scaled count ("-106B")
 * becomes a number only beside other figures, never in a column of tenors
 * ("3M, 6M, 1Y"). Identifier columns keep their text.
 */
function resolveColumn(header: string, cells: Cell[], parseText: boolean): ResolvedColumn {
  const textual = cells.flatMap((cell) => cell.kind === "textual" ? [cell] : []);
  const read = parseText ? textual.map((cell) => readDisplay(cell.text)) : [];
  const numeric = read.filter((entry): entry is DisplayNumber => entry != null && entry !== BLANK_DISPLAY);
  const bare = textual.filter((cell, index) => read[index] != null && read[index] !== BLANK_DISPLAY && BARE_SCALED.test(cell.text.trim()));
  const otherFigures = numeric.length > bare.length || cells.some((cell) => cell.kind === "number");
  const convertBare = otherFigures && !textual.some((cell) => TENOR.test(cell.text.trim()));
  let textualIndex = 0;
  return {
    header,
    cells: cells.map((cell): ResolvedCell => {
      if (cell.kind !== "textual") return cell;
      const entry = parseText ? read[textualIndex] : null;
      textualIndex += 1;
      if (entry === BLANK_DISPLAY) return BLANK;
      if (entry == null || (!convertBare && BARE_SCALED.test(cell.text.trim()))) return { kind: "text", text: cell.text };
      return { kind: "number", value: Number(entry.number), unit: entry.unit };
    }),
  };
}

function numberUnits(cells: readonly ResolvedCell[]): Set<string> {
  return new Set(cells.flatMap((cell) => cell.kind === "number" ? [cell.unit] : []));
}

function cellValue(cell: ResolvedCell): CliReportValue {
  return cell.kind === "blank" ? "" : cell.kind === "number" ? cell.value : cell.text;
}

const RANGE = /^[+-]?\d[\d,]*(?:\.\d+)?\s*[-\u2013]\s*[+-]?\d[\d,]*(?:\.\d+)?$/;

/** A range drawn in the unit the header now names ("3.75-4.00%" under "Rate (%)") drops it too. */
function withoutUnit(cell: ResolvedCell, unit: string): CliReportValue {
  if (!unit || cell.kind !== "text") return cellValue(cell);
  const drawn = cell.text.trim();
  const bare = drawn.endsWith(unit) ? drawn.slice(0, -unit.length).trim()
    : drawn.startsWith(unit) ? drawn.slice(unit.length).trim()
      : null;
  return bare != null && RANGE.test(bare) ? bare.replace(/,/g, "") : cell.text;
}

// The first column of a table of metrics, one per row: `Metric, 2025, 2024` or `Indicator, Latest, Previous`.
const METRIC_LABEL = /^(?:metric|indicator|ratio|measure|statistic|line item)s?$/i;

/**
 * In a table of metrics, the columns that mix units keep one per row, and the
 * row's label names it. A symbol or a date in the first column is not a label.
 */
function rowUnits(columns: readonly ResolvedColumn[], mixed: readonly boolean[], rowCount: number): string[] | null {
  const label = columns[0];
  if (!label || mixed[0] || !METRIC_LABEL.test(label.header.trim())) return null;
  if (!label.cells.some((cell) => cell.kind === "text")) return null;
  if (label.cells.some((cell) => cell.kind === "number" || (cell.kind === "text" && cell.time))) return null;
  const units: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const unitsInRow = numberUnits(columns.flatMap((column, index) => mixed[index] ? [column.cells[row] ?? BLANK] : []));
    if (unitsInRow.size > 1) return null;
    units.push([...unitsInRow][0] ?? "");
  }
  return units;
}

/**
 * Numbers are bare, so their unit goes where a spreadsheet reader looks for
 * it: the header when the column has one unit, the row's label in a table of
 * metrics whose rows each have one, and otherwise a `<header> unit` column
 * beside a column that mixes them (a rate in % and a spread in bp).
 */
function assembleTable(title: string, columns: readonly ResolvedColumn[], rowCount: number): CliReportTable {
  const units = columns.map((column) => numberUnits(column.cells));
  const mixed = units.map((columnUnits) => columnUnits.size > 1);
  const byRow = mixed.some(Boolean) ? rowUnits(columns, mixed, rowCount) : null;
  const layout = columns.flatMap((column, index) => {
    const columnUnits = units[index]!;
    const cell = (row: number) => cellValue(column.cells[row] ?? BLANK);
    if (index === 0 && byRow) {
      return [{ header: column.header, value: (row: number) => byRow[row] ? labelWithUnit(String(cell(row)), byRow[row]!).trim() : cell(row) }];
    }
    if (!mixed[index]) {
      const unit = [...columnUnits][0] ?? "";
      return [{ header: labelWithUnit(column.header, unit), value: (row: number) => withoutUnit(column.cells[row] ?? BLANK, unit) }];
    }
    if (byRow) return [{ header: column.header, value: cell }];
    return [
      { header: column.header, value: cell },
      {
        header: `${column.header} unit`,
        value: (row: number) => {
          const resolved = column.cells[row];
          return resolved?.kind === "number" ? resolved.unit : "";
        },
      },
    ];
  });
  return {
    title,
    columns: layout.map((column) => column.header),
    rows: Array.from({ length: rowCount }, (_, row) => layout.map((column) => column.value(row))),
  };
}

// Codes a spreadsheet must not turn into numbers, even when they are digits.
const IDENTIFIER_KEY = /^(?:id|cik|code|cusip|figi|isin|symbol|ticker)$|(?:Id|Cik|Code|Cusip|Figi|Isin|Symbol|Ticker)$/;

/** A table of rows under the columns the text view draws. */
export function exportRowsTable<Row extends Record<string, unknown>>(
  title: string,
  columns: readonly CliReportColumn<Row>[],
  rows: readonly Row[],
): CliReportTable {
  return assembleTable(title, columns.map((column) => resolveColumn(
    column.header,
    rows.map((row) => {
      const value = (row as Record<string, unknown> | undefined)?.[column.key];
      return exportCell(value, column.format ? column.format(value, row) : null, column.key);
    }),
    !IDENTIFIER_KEY.test(column.key),
  )), rows.length);
}

/** Label/value lines as `Metric,Value`; a number's unit moves into its label. */
export function exportEntriesTable(title: string, entries: readonly CliReportEntry[]): CliReportTable {
  return {
    title,
    columns: ["Metric", "Value"],
    rows: entries.map((entry) => {
      if (entry.unit != null && typeof entry.value === "number" && Number.isFinite(entry.value)) {
        return [labelWithUnit(entry.label, entry.unit), exportNumber(entry.value)];
      }
      const [cell] = resolveColumn(entry.label, [exportCell(entry.value, entry.formatted ?? null, entry.key)], true).cells;
      return cell?.kind === "number"
        ? [labelWithUnit(entry.label, cell.unit), cell.value]
        : [entry.label, cellValue(cell ?? BLANK)];
    }),
  };
}

/** A table known only by the text it shows, such as a rendered pane; `instant` is the time behind a shortened one. */
export function exportTextTable(
  title: string,
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<{ text: string; instant?: string } | undefined>>,
): CliReportTable {
  return assembleTable(title, headers.map((header, index) => resolveColumn(
    header,
    rows.map((row) => {
      const cell = row[index];
      if (!cell) return BLANK;
      return cell.instant ? exportCell(cell.instant, null) : exportCell(null, cell.text);
    }),
    true,
  )), rows.length);
}

/** The closing `#` lines: the text view's source and as-of line, then whatever kept the report from being whole. */
export function reportFooterLines(input: {
  freshness?: ReportFreshness;
  /** `true`, or what is missing, such as "19 of 20 available". */
  incomplete?: boolean | string;
  errors?: readonly string[];
  notes?: readonly string[];
}): string[] {
  return [
    ...(input.freshness ? [formatFreshnessLine(input.freshness)] : []),
    ...(input.incomplete ? [typeof input.incomplete === "string" ? `incomplete: ${input.incomplete}` : "incomplete"] : []),
    ...(input.errors ?? []).map((error) => `error: ${error}`),
    ...(input.notes ?? []).map((note) => `note: ${note}`),
  ];
}

function sectionList(tables: readonly CliReportTable[]): string {
  const titles = tables.map((table) => table.title);
  return tables.length === 1
    ? `${titles[0]} (or 1)`
    : `${titles.join(", ")}, or a number from 1 to ${tables.length}`;
}

/**
 * `--section`: one table, by its title (any case) or its 1-based position.
 * Without a selector the report keeps every table.
 */
export function selectReportTables(report: CliReportTables, selector: string | true | undefined): CliReportTables {
  if (selector === undefined) return report;
  if (selector === true || !selector.trim()) throw new Error("--section needs a section title or number.");
  const wanted = selector.trim();
  if (report.tables.length === 0) throw new Error(`No section "${wanted}": this report has no tables.`);
  const index = /^\d+$/.test(wanted)
    ? Number(wanted) - 1
    : report.tables.findIndex((table) => table.title.trim().toLowerCase() === wanted.toLowerCase());
  const table = report.tables[index];
  if (!table) throw new Error(`No section "${wanted}". Sections: ${sectionList(report.tables)}.`);
  return { ...report, tables: [table] };
}

function commentLine(value: string): string {
  return `# ${value.replace(/\s*[\r\n]+\s*/g, " ").trim()}`;
}

/** A row whose first cell starts with `#` (a rank column) quotes it, so no reader takes the row for a comment. */
function csvLine(row: readonly unknown[]): string {
  const line = serializeCsv([row]);
  if (!line.startsWith("#")) return line;
  const first = String(row[0]);
  return `"${first}"${line.slice(first.length)}`;
}

/**
 * One table writes as a plain CSV; several write as blocks, each under a
 * `# section: <title>` line, with a blank line between. The footer follows
 * the data as `#` lines after a blank line.
 */
export function renderReportCsv(report: CliReportTables): string {
  const marked = report.tables.length > 1;
  const blocks = report.tables.map((table) => [
    ...(marked ? [commentLine(`section: ${table.title}`)] : []),
    ...(table.columns.length > 0 ? [[table.columns, ...table.rows].map(csvLine).join("\n")] : []),
  ].join("\n"));
  const footer = report.footer.map(commentLine).join("\n");
  return [blocks.join("\n\n"), footer].filter(Boolean).join("\n\n");
}

/** One JSON object per row, keyed by column; rows of a report with several tables name their section. */
export function renderReportNdjson(report: CliReportTables): string {
  const tagged = report.tables.length > 1;
  return report.tables.flatMap((table) => {
    const sectionKey = table.columns.some((column) => column.toLowerCase() === "section") ? "_section" : "section";
    return table.rows.map((row) => {
      const object: Record<string, CliReportValue | null> = tagged ? { [sectionKey]: table.title } : {};
      table.columns.forEach((column, index) => {
        const value = row[index];
        object[column] = value === undefined || value === "" ? null : value;
      });
      return JSON.stringify(object);
    });
  }).join("\n");
}
