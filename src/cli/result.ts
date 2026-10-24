import type { CliGlobalOptions } from "./options";
import {
  cliPlainEnabled,
  cliStyles,
  cliTerminalWidth,
  renderStats,
  renderTable,
  statValueWidth,
  visibleLength,
  wrapText,
  wrapToTerminal,
  type CliStatEntry,
  type CliTableColumn,
} from "../utils/cli-output";
import { serializeCsv } from "../utils/csv";
import { formatUtcTime, isEpochMilliseconds, isZonedIsoDateTime } from "../utils/utc-time";
import { formatFreshnessLine, withSavedCopy, type ReportFreshness } from "./pane-functions/freshness";
import { withSearchHints, type FredSeriesCheck } from "./not-a-ticker";
import { renderReportCsv, renderReportNdjson, withCsvFooter, type CliReportTables } from "./report-tables";
import {
  EXPORT_IDENTITY_COLUMNS,
  exportIdentityCells,
  exportIdentityFields,
  exportSource,
  exportSourceLines,
  type ExportIdentity,
  type ExportSource,
} from "./export-source";
import { windowRows, type RowWindow, type RowWindowOptions } from "./row-window";

export interface CliResult<T = unknown> {
  data: T;
  metadata?: Record<string, unknown>;
  warnings?: string[];
  /**
   * Source, as-of and status of market data, as every `fn` report states them
   * (docs/usage.md#how-current-a-report-is): the last line of the text output
   * and `metadata.freshness` in JSON. Exports cite it too (`exportSource`):
   * CSV ends with it as `#` lines, or `tables` footer does, and JSON carries
   * it as `source`. NDJSON stays rows only. CSV and NDJSON rows end with the
   * fixed columns of `EXPORT_IDENTITY_COLUMNS`, its source and as-of among them.
   */
  freshness?: ReportFreshness;
  /**
   * What exports cite (CSV's closing `#` lines, JSON's `source`) when the text
   * does not end with `freshness`: an `fn` report states its own, and
   * `fear-greed` prints its row alone.
   */
  exportFreshness?: ReportFreshness;
  /**
   * Why a result that still prints counts as a failure (a report with no
   * data): the command exits 1, and JSON says `ok: false` with this as
   * `error` beside the data, so the envelope and the exit status agree.
   */
  failure?: CliErrorObject;
}

export interface CliErrorObject {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  /** What the failure says beside its message, such as the `tickerChange` of a symbol whose company moved. */
  [field: string]: unknown;
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
  /** Text-mode line printed under the rows, such as where a listing stops. Not printed with no rows: say it in `empty`. */
  footnote?: string;
  /** Text-mode block printed under the rows and footnote, for figures about a row that are not columns. */
  details?: (data: T) => string;
  /**
   * The row key holding each row's date, which makes the rows a dated series:
   * `--tail` keeps the newest rows whichever way the series runs, and a
   * `--limit` that keeps the oldest says so, under the text table and as
   * `metadata.rows` in JSON.
   */
  dateKey?: string;
  /**
   * The row key that splits the rows into series of their own, each windowed
   * apart: with `symbol`, `--tail 5` keeps every symbol's newest five rows.
   */
  seriesKey?: string;
  /** How many rows to show when neither `--limit` nor `--tail` is given; every row when absent. */
  defaultLimit?: number;
  /**
   * What CSV and NDJSON write instead of the rows: a report's tables as the
   * text view shows them, CSV with its `# section:` and closing `#` lines.
   */
  tables?: CliReportTables;
  /**
   * What the rows are of, for the fixed columns (`EXPORT_IDENTITY_COLUMNS`)
   * CSV and NDJSON end every row with when the result cites a source: one
   * identity for every row, or each row's own. Without it a row's own
   * `symbol` and `currency` fields say it, as far as they go.
   */
  exportIdentity?: ExportIdentity | ((row: Row) => ExportIdentity);
  /** What CSV says after the source lines as `# note:` lines: what the rows do not show, such as where a series begins. */
  exportNotes?: readonly string[];
  /**
   * Why a row's figures are empty (`Not a ticker: ZZZZQQ.`, `Chg%: no previous
   * close`), for the `status` column CSV writes after the row's own columns and
   * the `status` field of an NDJSON row; empty for a whole row. The column is
   * there whenever this is, with rows or without, so the header never depends
   * on what loaded. A figure that is no number (NaN) is written empty and,
   * without a reason here, named as `<header>: not available`.
   */
  exportStatus?: (row: Row) => string | null | undefined;
}

interface CliResultJsonEnvelope<T> extends Omit<CliResult<T>, "freshness" | "exportFreshness" | "failure"> {
  ok: boolean;
  error?: CliErrorObject;
  /** Where the data comes from, as CSV's closing `#` lines say it. */
  source?: ExportSource;
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
  renderOptions: Pick<CliResultRenderOptions, "dateKey" | "defaultLimit" | "seriesKey">,
): RowWindow<Row> {
  const { dateKey, seriesKey } = renderOptions;
  const dateOf = dateKey ? (row: Row) => (isPlainObject(row) ? row[dateKey] : undefined) : undefined;
  const windowOptions = rowWindowOptions(options, renderOptions);
  if (!seriesKey) return windowRows(rows, windowOptions, dateOf);
  const series = new Map<unknown, Row[]>();
  for (const row of rows) {
    const key = isPlainObject(row) ? row[seriesKey] : undefined;
    const group = series.get(key);
    if (group) group.push(row);
    else series.set(key, [row]);
  }
  const windows = [...series.values()].map((group) => windowRows(group, windowOptions, dateOf));
  const count = windowOptions.tail ?? windowOptions.limit;
  return {
    rows: windows.flatMap((window) => window.rows),
    total: rows.length,
    kept: windows.find((window) => window.kept)?.kept ?? null,
    note: windows.some((window) => window.note)
      ? `showing the oldest ${count} ${count === 1 ? "row" : "rows"} of each ${seriesKey}; --tail ${count} for the latest` : null,
  };
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
  const missing = context === "record" ? cliPlainEnabled() ? "—" : cliStyles.muted("-") : "";
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

/** A number a spreadsheet cannot read: NaN or an infinity, which exports write empty, never as the word. */
function isNonFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && !Number.isFinite(value);
}

/**
 * What a row's status cell says: the command's reason, else the figures
 * written empty for being no number. Empty when nothing is missing.
 */
function exportStatusText(reason: string | null | undefined, blanked: readonly string[]): string {
  const own = reason?.trim();
  if (own) return own;
  return blanked.length > 0 ? `${blanked.join(", ")}: not available` : "";
}

/** `status`, or `value_status` beside a column of the table's own named Status. */
function statusHeader(headers: readonly string[]): string {
  return headers.some((header) => header.trim().toLowerCase() === "status") ? "value_status" : "status";
}

function renderCsv<Row extends Record<string, unknown>>(
  rows: Row[],
  columns?: CliResultColumn<Row>[],
  identity?: (row: Row) => string[],
  status?: (row: Row) => string | null | undefined,
): string {
  const resolvedColumns = columns && columns.length > 0
    ? columns
    : inferColumns(rows as Record<string, unknown>[]) as CliResultColumn<Row>[];
  const headers = resolvedColumns.map((column) => column.header);
  return serializeCsv([
    [...headers, ...status ? [statusHeader(headers)] : [], ...identity ? EXPORT_IDENTITY_COLUMNS : []],
    ...rows.map((row) => {
      const values = resolvedColumns.map((column) => (column.value ? column.value(row) : row[column.key]));
      const blanked = resolvedColumns.flatMap((column, index) => isNonFiniteNumber(values[index]) ? [column.header] : []);
      return [
        ...values.map((value) => isNonFiniteNumber(value) ? "" : value),
        ...status ? [exportStatusText(status(row), blanked)] : [],
        ...identity?.(row) ?? [],
      ];
    }),
  ]);
}

/**
 * The key an NDJSON row says why its figures are empty under: `status`, or
 * `value_status` beside a field of the row's own that the export writes under
 * that name (an order's status), as CSV's header does.
 */
function ndjsonStatusKey(rows: readonly unknown[], columns?: readonly CliResultColumn<never>[]): string {
  const own = columns && columns.length > 0
    ? columns.some((column) => column.key === "status")
    : rows.some((row) => isPlainObject(row) && "status" in row);
  return own ? "value_status" : "status";
}

/** An NDJSON row: a figure that is no number is null, and the row says why its figures are empty when the command does. */
function ndjsonRow<Row extends Record<string, unknown>>(row: Row, status: ((row: Row) => string | null | undefined) | undefined, statusKey: string): Record<string, unknown> {
  const blanked = Object.entries(row).flatMap(([key, value]) => isNonFiniteNumber(value) ? [key] : []);
  const own = blanked.length > 0 ? { ...row, ...Object.fromEntries(blanked.map((key) => [key, null])) } : row;
  return status ? { ...own, [statusKey]: exportStatusText(status(row), blanked) || null } : own;
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** What a row is of: as the command says, else its own `symbol` and `currency` fields. */
function rowIdentity<Row extends Record<string, unknown>>(
  row: Row,
  declared: CliResultRenderOptions<unknown, Row>["exportIdentity"],
): ExportIdentity {
  if (typeof declared === "function") return declared(row);
  return declared ?? { symbolOrSeries: stringField(row, "symbol"), currencyOrUnit: stringField(row, "currency") };
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
  // A column no row fills is noise in a table; exports keep it, and so does plain output, whose
  // tables keep one shape from query to query with "—" in the empty cells.
  const filled = resolvedColumns
    .map((column, index) => ({ column, index }))
    .filter(({ column, index }) => cliPlainEnabled() || column.width != null || cells.some((row) => row[index] !== ""));
  const shown = filled.length > 0 ? filled : resolvedColumns.map((column, index) => ({ column, index }));
  return renderTable(
    shown.map(({ column }) => ({
      header: column.header,
      align: column.align,
      width: column.width,
      maxWidth: column.maxWidth,
      minWidth: column.minWidth,
      optional: column.optional,
      dropPriority: column.dropPriority,
      shrink: column.shrink,
      stackPriority: column.stackPriority,
      stackRows: column.stackRows,
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

/**
 * The closing source, as-of and status line of a text result, for output
 * printed without `printResult`; `shown` is the data the line is drawn from,
 * which says whether it came from a saved copy.
 */
export function cliFreshnessFooter(freshness: ReportFreshness, shown?: unknown): string {
  return cliStyles.muted(wrapToTerminal(formatFreshnessLine(withSavedCopy(freshness, shown))));
}

export function serializeCliResult<T, Row extends Record<string, unknown> = Record<string, unknown>>(
  result: CliResult<T>,
  options: CliGlobalOptions,
  renderOptions: CliResultRenderOptions<T, Row> = {},
): string {
  const { freshness: reported, exportFreshness, failure, ...rest } = result;
  // Rows shown from a saved copy, its refresh having failed, say so in place of live or delayed.
  const freshness = reported && withSavedCopy(reported, result.data);
  const cited = freshness ?? (exportFreshness && withSavedCopy(exportFreshness, result.data));
  if (options.format === "json") {
    const columns = serializeColumns(renderOptions.columns);
    const window = Array.isArray(result.data) ? windowed(result.data as unknown[], options, renderOptions) : null;
    const cut = window ? cutMetadata(window) : null;
    const envelope: CliResultJsonEnvelope<T> = {
      ok: !failure,
      ...(failure ? { error: failure } : {}),
      ...rest,
      ...(freshness || cut ? { metadata: { ...rest.metadata, ...(freshness ? { freshness } : {}), ...(cut ? { rows: cut } : {}) } } : {}),
      data: window ? window.rows as T : result.data,
      ...(cited ? { source: exportSource(cited) } : {}),
      ...(columns?.length ? { columns } : {}),
    };
    return JSON.stringify(envelope, null, 2);
  }
  const body = serializeCliRows(rest, options, renderOptions, cited);
  if (options.format !== "text" || !freshness) return body;
  return body ? `${body}\n\n${cliFreshnessFooter(freshness)}` : cliFreshnessFooter(freshness);
}

function serializeCliRows<T, Row extends Record<string, unknown>>(
  result: CliResult<T>,
  options: CliGlobalOptions,
  renderOptions: CliResultRenderOptions<T, Row>,
  cited?: ReportFreshness,
): string {
  if (renderOptions.tables && (options.format === "csv" || options.format === "ndjson")) {
    // A report's tables name what they are of, else the command's one identity for every row does.
    const declared = renderOptions.exportIdentity;
    const tables = renderOptions.tables.identity || !declared || typeof declared === "function"
      ? renderOptions.tables
      : { ...renderOptions.tables, identity: declared };
    return options.format === "csv" ? renderReportCsv(tables, cited) : renderReportNdjson(tables, cited);
  }
  const window = windowed(asRows(result.data, renderOptions.rows), options, renderOptions);
  const rows = window.rows;
  const status = renderOptions.exportStatus;
  if (options.format === "ndjson") {
    const statusKey = ndjsonStatusKey(rows, renderOptions.columns as readonly CliResultColumn<never>[] | undefined);
    return rows.map((row) => {
      if (!isPlainObject(row)) return JSON.stringify(row);
      const fields = ndjsonRow(row as Row, status, statusKey);
      return JSON.stringify(cited ? { ...fields, ...exportIdentityFields(cited, rowIdentity(row as Row, renderOptions.exportIdentity)) } : fields);
    }).join("\n");
  }
  if (options.format === "csv") {
    if (!cited) return renderCsv(rows as Row[], renderOptions.columns, undefined, status);
    const csv = renderCsv(rows as Row[], renderOptions.columns, (row) => exportIdentityCells(cited, rowIdentity(row, renderOptions.exportIdentity)), status);
    return withCsvFooter(csv, [...exportSourceLines(cited), ...(renderOptions.exportNotes ?? []).map((note) => `note: ${note}`)]);
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
  const notes = [window.note, renderOptions.footnote].filter((note): note is string => !!note);
  const details = renderOptions.details?.(result.data) ?? "";
  const body = [table, ...notes.map((note) => cliStyles.muted(note)), ...details ? ["", details] : []].join("\n");
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

/** Settles once the result `printCliResult` last wrote has left the process: a pipe can hold it back. */
let stdoutWritten: Promise<void> = Promise.resolve();

/**
 * For a command that must exit before its event loop empties: exiting while
 * a pipe still holds part of the output would cut it off.
 */
export function cliOutputWritten(): Promise<void> {
  return stdoutWritten;
}

export function printCliResult<T, Row extends Record<string, unknown> = Record<string, unknown>>(
  result: CliResult<T>,
  options: CliGlobalOptions,
  renderOptions: CliResultRenderOptions<T, Row> = {},
  args: readonly string[] = [],
  isFredSeries?: FredSeriesCheck,
): void {
  if (options.quiet && options.format === "text") return;
  // JSON keeps the router's own words; everything else is for a person, so a "Not a ticker" gets its hint.
  const hinted = (text: string) => options.format === "json" ? text : withSearchHints(text, args, isFredSeries);
  const output = hinted(serializeCliResult(result, options, renderOptions));
  // Bun's console writer can truncate a large pipe write after stdout has been
  // initialized. The stream queues the remaining bytes until the reader drains.
  if (output && !process.stdout.write(`${output}\n`)) {
    stdoutWritten = new Promise((resolve) => process.stdout.once("drain", () => resolve()));
  }
  // JSON carries warnings in its envelope. Text, CSV and NDJSON are only the
  // rows, so a warning goes to stderr, out of a file the rows are piped into.
  if (options.format !== "json" && !options.quiet) {
    for (const warning of result.warnings ?? []) {
      console.error(`${cliStyles.warning("warning:")} ${hinted(warning)}`);
    }
  }
}

export function serializeCliError(error: CliErrorObject, options: CliGlobalOptions): string {
  if (options.format === "json" || options.format === "ndjson") {
    return JSON.stringify({ ok: false, error }, null, options.format === "json" ? 2 : 0);
  }
  return error.details == null ? error.message : `${error.message}\n${String(error.details)}`;
}
