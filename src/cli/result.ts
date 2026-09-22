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

export interface CliResult<T = unknown> {
  data: T;
  metadata?: Record<string, unknown>;
  warnings?: string[];
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
}

interface CliResultJsonEnvelope<T> extends CliResult<T> {
  ok: true;
  columns?: Array<Pick<CliResultColumn, "key" | "header" | "align" | "width">>;
}

type TextCellContext = "table" | "record";

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const TIME_KEY = /(?:At|Time|Timestamp)$/;
const IDENTIFIER_KEY = /^id$|Id$/;
// Epoch milliseconds between 2001 and 2286, so counts and prices are never read as dates.
const EPOCH_MS_MIN = 1e12;
const EPOCH_MS_MAX = 1e13;
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

function applyLimit<T>(data: T, limit?: number): T {
  if (!Array.isArray(data) || limit == null) return data;
  return data.slice(0, limit) as T;
}

function asRows<T, Row>(data: T, limit?: number, rows?: (data: T) => Row[]): Row[] {
  const resolvedRows = rows ? rows(data) : (Array.isArray(data) ? data : [data]) as Row[];
  return limit == null ? resolvedRows : resolvedRows.slice(0, limit);
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

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
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
  if (value instanceof Date) return formatLocalDateTime(value);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (key && TIME_KEY.test(key) && value >= EPOCH_MS_MIN && value < EPOCH_MS_MAX) {
      return formatLocalDateTime(new Date(value));
    }
    return formatTextNumber(value);
  }
  if (typeof value === "string") {
    return ISO_DATE_TIME.test(value) ? formatLocalDateTime(new Date(value)) || value : value;
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
    const numeric = values.length > 0 && values.every((value) => typeof value === "number" && !(
      TIME_KEY.test(column.key) && value >= EPOCH_MS_MIN && value < EPOCH_MS_MAX
    ));
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

export function serializeCliResult<T, Row extends Record<string, unknown> = Record<string, unknown>>(
  result: CliResult<T>,
  options: CliGlobalOptions,
  renderOptions: CliResultRenderOptions<T, Row> = {},
): string {
  if (options.format === "json") {
    const columns = serializeColumns(renderOptions.columns);
    const envelope: CliResultJsonEnvelope<T> = {
      ok: true,
      ...result,
      data: applyLimit(result.data, options.limit),
      ...(columns?.length ? { columns } : {}),
    };
    return JSON.stringify(envelope, null, 2);
  }

  const rows = asRows(result.data, options.limit, renderOptions.rows);
  if (options.format === "ndjson") {
    return rows.map((row) => JSON.stringify(row)).join("\n");
  }
  if (options.format === "csv") {
    return renderCsv(rows as Row[], renderOptions.columns);
  }
  if (renderOptions.text) {
    return renderOptions.text(result.data);
  }
  if (rows.length === 0) {
    return cliStyles.muted(renderOptions.empty ?? "No results.");
  }
  const layout = renderOptions.layout
    ?? (!renderOptions.rows && isPlainObject(result.data) ? "record" : "table");
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
  // Structured formats carry warnings in the envelope; text mode would otherwise lose them.
  if (options.format === "text") {
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
