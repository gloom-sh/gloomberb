import type { CliGlobalOptions } from "./options";
import { renderTable, type CliTableColumn } from "../utils/cli-output";
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
}

export interface CliResultRenderOptions<T = unknown, Row = Record<string, unknown>> {
  text?: (data: T) => string;
  columns?: CliResultColumn<Row>[];
  rows?: (data: T) => Row[];
}

interface CliResultJsonEnvelope<T> extends CliResult<T> {
  ok: true;
  columns?: Array<Pick<CliResultColumn, "key" | "header" | "align" | "width">>;
}

function applyLimit<T>(data: T, limit?: number): T {
  if (!Array.isArray(data) || limit == null) return data;
  return data.slice(0, limit) as T;
}

function asRows<T, Row>(data: T, limit?: number, rows?: (data: T) => Row[]): Row[] {
  const resolvedRows = rows ? rows(data) : (Array.isArray(data) ? data : [data]) as Row[];
  return limit == null ? resolvedRows : resolvedRows.slice(0, limit);
}

function normalizeCell(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

function renderTextTable<Row extends Record<string, unknown>>(
  rows: Row[],
  columns?: CliResultColumn<Row>[],
): string {
  const resolvedColumns = columns && columns.length > 0
    ? columns
    : inferColumns(rows as Record<string, unknown>[]) as CliResultColumn<Row>[];
  return renderTable(
    resolvedColumns.map((column) => ({
      header: column.header,
      align: column.align,
      width: column.width,
    })),
    rows.map((row) => resolvedColumns.map((column) => normalizeCell(column.value ? column.value(row) : row[column.key]))),
  );
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
  return renderTextTable(rows as Row[], renderOptions.columns);
}

export function printCliResult<T, Row extends Record<string, unknown> = Record<string, unknown>>(
  result: CliResult<T>,
  options: CliGlobalOptions,
  renderOptions: CliResultRenderOptions<T, Row> = {},
): void {
  if (options.quiet && options.format === "text") return;
  const output = serializeCliResult(result, options, renderOptions);
  if (output) console.log(output);
}

export function serializeCliError(error: CliErrorObject, options: CliGlobalOptions): string {
  if (options.format === "json" || options.format === "ndjson") {
    return JSON.stringify({ ok: false, error }, null, options.format === "json" ? 2 : 0);
  }
  return error.details == null ? error.message : `${error.message}\n${String(error.details)}`;
}
