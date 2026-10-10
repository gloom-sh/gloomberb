import type { CliGlobalOptions } from "./options";
import {
  cliStyles,
  cliTerminalWidth,
  renderStats,
  renderTable,
  statValueWidth,
  visibleLength,
  wrapText,
  type CliStatEntry,
  type CliTableColumn,
} from "../utils/cli-output";
import { serializeCsv } from "../utils/csv";
import { formatUtcTime, isEpochMilliseconds, isZonedIsoDateTime } from "../utils/utc-time";
import { formatFreshnessLine, type ReportFreshness } from "./pane-functions/freshness";
import { renderReportCsv, renderReportNdjson, type CliReportTables } from "./report-tables";
import { windowRows, type RowWindow, type RowWindowOptions } from "./row-window";

export interface CliResult<T = unknown> {
  data: T;
  metadata?: Record<string, unknown>;
  warnings?: string[];
  /**
   * Source, as-of and status of market data, as every `fn` report states them
   * (docs/usage.md#how-current-a-report-is): the last line of the text output
   * and `metadata.freshness` in JSON. CSV and NDJSON stay rows only, unless
   * the command passes `tables`, whose footer carries it.
   */
  freshness?: ReportFreshness;
}

export interface CliErrorObject {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

export interface CliResultColumn<Row = Record<string, unknown>> extends CliTableColumn {
  key: string;
  value?: (row: Row) => unknown;
  /** Text-mode display of the cell. CSV, NDJSON and JSON keep the raw value. */
  format?: (value: unknown, row: Row) => string;
}

export interface CliResultRenderOptions<T = unknown, Row = Record<string, unknown>> {
  text?: (data: T) => string;
  columns?: CliResultColumn<Row>[];
  /** Columns for text mode only. CSV and the JSON envelope keep `columns`, or the data keys without them. */
  textColumns?: CliResultColumn<Row>[];
  rows?: (data: T) => Row[];
  /**
   * How text mode lays rows out. "record" prints each row as aligned label/value lines, which
   * suits a single result. Defaults to "record" when data is one object and "table" otherwise.
   */
  layout?: "table" | "record";
  /** Text-mode message when there are no rows. */
  empty?: string;
  /** Text-mode block printed above the rows, for figures that are not rows. */
  summary?: (data: T) => string;
  /** Text-mode line printed first, naming what the result is about, such as the listing a symbol resolved to. */
  heading?: string;
  /**
   * The row key holding each row's date, which makes the rows a dated series:
   * `--tail` keeps the newest rows whichever way the series runs, and a
   * `--limit` that keeps the oldest says so, under the text table and as
   * `metadata.rows` in JSON.
   */
  dateKey?: string;
  /** How many rows to show when neither `--limit` nor `--tail` is given; every row when absent. */
  defaultLimit?: number;
  /**
   * What CSV and NDJSON write instead of the rows: a report's tables as the
   * text view shows them, CSV with its `# section:` and closing `#` lines.
   */
  tables?: CliReportTables;
}

interface CliResultJsonEnvelope<T> extends Omit<CliResult<T>, "freshness"> {
  ok: true;
  columns?: Array<Pick<CliResultColumn, "key" | "header" | "align" | "width">>;
}

type TextCellContext = "table" | "record";

// Keys whose epoch-millisecond numbers are times rather than counts or prices.
const TIME_KEY = /(?:At|Time|Timestamp|Updated|AsOf)$|^(?:asOf|timestamp)$/;
const IDENTIFIER_KEY = /^id$|Id$/;
const KEY_ACRONYMS: Record<string, string> = {
  api: "API",
  cik: "CIK",
  eps: "EPS",
  fx: "FX",
  ibkr: "IBKR",
  id: "ID",
  ids: "IDs",
  ui: "UI",
  url: "URL",
  usd: "USD",
};

function rowWindowOptions(options: CliGlobalOptions, renderOptions: Pick<CliResultRenderOptions, "defaultLimit">): RowWindowOptions {
  return options.tail != null ? { tail: options.tail } : { limit: options.limit ?? renderOptions.defaultLimit };
}

function windowed<Row>(
  rows: readonly Row[],
  options: CliGlobalOptions,
  renderOptions: Pick<CliResultRenderOptions, "dateKey" | "defaultLimit">,
): RowWindow<Row> {
  const { dateKey } = renderOptions;
  const dateOf = dateKey ? (row: Row) => (isPlainObject(row) ? row[dateKey] : undefined) : undefined;
  return windowRows(rows, rowWindowOptions(options, renderOptions), dateOf);
}

function asRows<T, Row>(data: T, rows?: (data: T) => Row[]): Row[] {
  return rows ? rows(data) : (Array.isArray(data) ? data : [data]) as Row[];
}

/** What JSON says about rows the window cut, under `metadata.rows`. */
function cutMetadata(window: RowWindow<unknown>) {
  if (window.rows.length >= window.total) return null;
  return { shown: window.rows.length, total: window.total, kept: window.kept, ...(window.note ? { note: window.note } : {}) };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
}

function normalizeCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Turns a camelCase data key into a Title Case label: `dataDir` becomes "Data Dir". */
export function humanizeCliKey(key: string): string {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(key)) return key;
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(" ")
    .map((word) => KEY_ACRONYMS[word.toLowerCase()] ?? `${word[0]!.toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(" ");
}

function isTimeValue(key: string | undefined, value: number): boolean {
  return key != null && TIME_KEY.test(key) && isEpochMilliseconds(value);
}

// Six significant digits hide float noise (0.9499999999999886) without cutting real precision;
// values of 1000 or more keep cents instead, so 46206.69 and 99999.99 stay as they are.
function formatTextNumber(value: number): string {
  if (!Number.isFinite(value) || Number.isInteger(value)) return String(value);
  return String(Math.abs(value) >= 1000 ? Number(value.toFixed(2)) : Number(value.toPrecision(6)));
}

/** `width` is the room a record value has, so nested blocks wrap inside it. */
function formatTextValue(
  value: unknown,
  key: string | undefined,
  context: TextCellContext,
  depth = 0,
  width: number | null = null,
): string {
  const missing = context === "record" ? cliStyles.muted("-") : "";
  if (value == null || value === "") return missing;
  // Times print in UTC with the zone named, never in the host's zone; JSON and CSV keep the raw value.
  if (value instanceof Date) return formatUtcTime(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return isTimeValue(key, value) ? formatUtcTime(value) : formatTextNumber(value);
  if (typeof value === "string") {
    // A date and time without a zone stays as the source wrote it: its zone is unknown.
    return isZonedIsoDateTime(value) ? formatUtcTime(value) : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return context === "record" ? cliStyles.muted("none") : "";
    if (value.every((item) => item == null || typeof item !== "object")) {
      return value.map((item) => formatTextValue(item, undefined, "table")).join(", ");
    }
    if (context === "record" && depth < 2) {
      // One bulleted item per object, continuation lines under the item, so items stay apart.
      return value.flatMap((item) => {
        const text = isPlainObject(item) ? formatInlineObject(item) : normalizeCell(item);
        const [first = "", ...rest] = width == null ? [text] : wrapText(text, Math.max(1, width - 2));
        return [`- ${first}`, ...rest.map((line) => `  ${line}`)];
      }).join("\n");
    }
    return JSON.stringify(value);
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return context === "record" ? cliStyles.muted("none") : "";
    if (context === "record" && depth < 2) {
      const labels = entries.map(([entryKey]) => [humanizeCliKey(entryKey), ""] as const);
      const nestedWidth = statValueWidth(labels, { width });
      return renderStats(entries.map(([entryKey, entryValue], index) => [
        labels[index]![0],
        formatTextValue(entryValue, entryKey, "record", depth + 1, nestedWidth),
      ]), { width });
    }
    return JSON.stringify(value);
  }
  return String(value);
}

function formatInlineObject(value: Record<string, unknown>): string {
  return Object.entries(value)
    .filter(([, entryValue]) => !isEmptyTextValue(entryValue) && !(isPlainObject(entryValue) && Object.keys(entryValue).length === 0))
    .map(([entryKey, entryValue]) => `${entryKey}: ${formatTextValue(entryValue, entryKey, "table", 2)}`)
    .join(", ");
}

function inferColumns(rows: Record<string, unknown>[]): CliResultColumn<Record<string, unknown>>[] {
  const keys = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === "object" && !Array.isArray(row)) {
      for (const key of Object.keys(row)) keys.add(key);
    }
  }
  return [...keys].map((key) => ({ key, header: key }));
}

function isEmptyTextValue(value: unknown): boolean {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function inferTextColumns(rows: Record<string, unknown>[]): CliResultColumn<Record<string, unknown>>[] {
  return inferColumns(rows).map((column) => {
    const values = rows.map((row) => row?.[column.key]).filter((value) => !isEmptyTextValue(value));
    const numeric = values.length > 0 && values.every((value) => typeof value === "number" && !isTimeValue(column.key, value));
    return {
      ...column,
      header: humanizeCliKey(column.key),
      ...(numeric ? { align: "right" as const } : {}),
      // IDs are what a user types into the next command, so they stay whole.
      ...(IDENTIFIER_KEY.test(column.key) ? { shrink: false } : {}),
    };
  });
}

function serializeColumns<Row>(columns?: CliResultColumn<Row>[]) {
  return columns?.map((column) => ({
    key: column.key,
    header: column.header,
    ...(column.align ? { align: column.align } : {}),
    ...(column.width ? { width: column.width } : {}),
  }));
}

function renderCsv<Row extends Record<string, unknown>>(
  rows: Row[],
  columns?: CliResultColumn<Row>[],
): string {
  const resolvedColumns = columns && columns.length > 0
    ? columns
    : inferColumns(rows as Record<string, unknown>[]) as CliResultColumn<Row>[];
  return serializeCsv([
    resolvedColumns.map((column) => column.header),
    ...rows.map((row) => resolvedColumns.map((column) => (
      column.value ? column.value(row) : row[column.key]
    ))),
  ]);
}

function textColumns<Row extends Record<string, unknown>>(
  rows: Row[],
  columns?: CliResultColumn<Row>[],
): CliResultColumn<Row>[] {
  return columns && columns.length > 0
    ? columns
    : inferTextColumns(rows as Record<string, unknown>[]) as CliResultColumn<Row>[];
}

function formatTextCell<Row extends Record<string, unknown>>(
  column: CliResultColumn<Row>,
  row: Row,
  context: TextCellContext,
  width: number | null = null,
): string {
  const value = column.value ? column.value(row) : row?.[column.key];
  if (column.format) return column.format(value, row);
  return formatTextValue(value, column.key, context, 0, width);
}

function renderTextTable<Row extends Record<string, unknown>>(
  rows: Row[],
  columns?: CliResultColumn<Row>[],
): string {
  const resolvedColumns = textColumns(rows, columns);
  const cells = rows.map((row) => resolvedColumns.map((column) => formatTextCell(column, row, "table")));
  // A column no row fills is noise in a table; exports keep it.
  const filled = resolvedColumns
    .map((column, index) => ({ column, index }))
    .filter(({ column, index }) => column.width != null || cells.some((row) => row[index] !== ""));
  const shown = filled.length > 0 ? filled : resolvedColumns.map((column, index) => ({ column, index }));
  return renderTable(
    shown.map(({ column }) => ({
      header: column.header,
      align: column.align,
      width: column.width,
      maxWidth: column.maxWidth,
      optional: column.optional,
      dropPriority: column.dropPriority,
      shrink: column.shrink,
    })),
    cells.map((row) => shown.map(({ index }) => row[index]!)),
  );
}

function renderTextRecords<Row extends Record<string, unknown>>(
  rows: Row[],
  columns?: CliResultColumn<Row>[],
): string {
  const resolvedColumns = textColumns(rows, columns);
  const valueWidth = statValueWidth(resolvedColumns.map((column) => [column.header, ""] as const));
  return rows
    .map((row) => renderStats(resolvedColumns.map((column): CliStatEntry => [
      column.header,
      formatTextCell(column, row, "record", valueWidth),
    ])))
    .join("\n\n");
}

function overflowsTerminal<Row extends Record<string, unknown>>(rows: Row[]): boolean {
  const terminalWidth = cliTerminalWidth();
  if (terminalWidth == null) return false;
  const columns = textColumns(rows);
  const width = columns.reduce((sum, column) => sum + Math.max(
    visibleLength(column.header),
    ...rows.map((row) => visibleLength(formatTextCell(column, row, "table"))),
  ), 0) + 2 * Math.max(0, columns.length - 1);
  return width > terminalWidth;
}

/** The closing source, as-of and status line of a text result, for output printed without `printResult`. */
export function cliFreshnessFooter(freshness: ReportFreshness): string {
  return cliStyles.muted(formatFreshnessLine(freshness));
}

export function serializeCliResult<T, Row extends Record<string, unknown> = Record<string, unknown>>(
  result: CliResult<T>,
  options: CliGlobalOptions,
  renderOptions: CliResultRenderOptions<T, Row> = {},
): string {
  const { freshness, ...rest } = result;
  if (options.format === "json") {
    const columns = serializeColumns(renderOptions.columns);
    const window = Array.isArray(result.data) ? windowed(result.data as unknown[], options, renderOptions) : null;
    const cut = window ? cutMetadata(window) : null;
    const envelope: CliResultJsonEnvelope<T> = {
      ok: true,
      ...rest,
      ...(freshness || cut ? { metadata: { ...rest.metadata, ...(freshness ? { freshness } : {}), ...(cut ? { rows: cut } : {}) } } : {}),
      data: window ? window.rows as T : result.data,
      ...(columns?.length ? { columns } : {}),
    };
    return JSON.stringify(envelope, null, 2);
  }
  const body = serializeCliRows(rest, options, renderOptions);
  if (options.format !== "text" || !freshness) return body;
  return body ? `${body}\n\n${cliFreshnessFooter(freshness)}` : cliFreshnessFooter(freshness);
}

function serializeCliRows<T, Row extends Record<string, unknown>>(
  result: CliResult<T>,
  options: CliGlobalOptions,
  renderOptions: CliResultRenderOptions<T, Row>,
): string {
  if (renderOptions.tables && options.format === "csv") return renderReportCsv(renderOptions.tables);
  if (renderOptions.tables && options.format === "ndjson") return renderReportNdjson(renderOptions.tables);
  const window = windowed(asRows(result.data, renderOptions.rows), options, renderOptions);
  const rows = window.rows;
  if (options.format === "ndjson") {
    return rows.map((row) => JSON.stringify(row)).join("\n");
  }
  if (options.format === "csv") {
    return renderCsv(rows as Row[], renderOptions.columns);
  }
  if (renderOptions.text) {
    return renderOptions.text(result.data);
  }
  const summary = renderOptions.summary?.(result.data) ?? "";
  const withHeading = (text: string) => renderOptions.heading ? `${renderOptions.heading}\n${text}` : text;
  if (rows.length === 0) {
    return withHeading(summary || cliStyles.muted(renderOptions.empty ?? "No results."));
  }
  const table = renderTextRows(rows as Row[], result.data, renderOptions);
  const body = window.note ? `${table}\n${cliStyles.muted(window.note)}` : table;
  return withHeading(summary ? `${summary}\n\n${body}` : body);
}

function renderTextRows<T, Row extends Record<string, unknown>>(
  rows: Row[],
  data: T,
  renderOptions: CliResultRenderOptions<T, Row>,
): string {
  const layout = renderOptions.layout
    ?? (!renderOptions.rows && isPlainObject(data) ? "record" : "table");
  const columns = renderOptions.textColumns ?? renderOptions.columns;
  if (!renderOptions.layout && rows.length === 1 && !columns?.length && overflowsTerminal(rows as Row[])) {
    // One row that cannot fit as a table reads better as label/value lines than cut off.
    return renderTextRecords(rows as Row[]);
  }
  return layout === "record"
    ? renderTextRecords(rows as Row[], columns)
    : renderTextTable(rows as Row[], columns);
}

export function printCliResult<T, Row extends Record<string, unknown> = Record<string, unknown>>(
  result: CliResult<T>,
  options: CliGlobalOptions,
  renderOptions: CliResultRenderOptions<T, Row> = {},
): void {
  if (options.quiet && options.format === "text") return;
  const output = serializeCliResult(result, options, renderOptions);
  // Bun's console writer can truncate a large pipe write after stdout has been
  // initialized. The stream queues the remaining bytes until the reader drains.
  if (output) process.stdout.write(`${output}\n`);
  // JSON carries warnings in its envelope. Text, CSV and NDJSON are only the
  // rows, so a warning goes to stderr, out of a file the rows are piped into.
  if (options.format !== "json" && !options.quiet) {
    for (const warning of result.warnings ?? []) {
      console.error(`${cliStyles.warning("warning:")} ${warning}`);
    }
  }
}

export function serializeCliError(error: CliErrorObject, options: CliGlobalOptions): string {
  if (options.format === "json" || options.format === "ndjson") {
    return JSON.stringify({ ok: false, error }, null, options.format === "json" ? 2 : 0);
  }
  return error.details == null ? error.message : `${error.message}\n${String(error.details)}`;
}
