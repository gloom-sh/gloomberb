import { apiClient } from "../../api-client";
import type { MarketContext } from "../types";
import type {
  HeadlessBundleResult,
  HeadlessBundleSection,
  HeadlessPaneColumn,
  HeadlessPaneContext,
  HeadlessPaneDefinition,
  HeadlessPaneEntry,
  HeadlessPaneLoadArgs,
  HeadlessPaneOptionValues,
  HeadlessPaneResult,
  HeadlessPaneRow,
  HeadlessSeriesResult,
  HeadlessSnapshotResult,
} from "../../types/plugin";
import { renderSection, renderTable } from "../../utils/cli-output";
import type { PaneFunctionReport } from "./report";
import type { ResolvedPaneFunction } from "./resolver";

interface SerializableHeadlessColumn {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  width?: number;
  description?: string;
}

export interface LoadedHeadlessPaneModel {
  definition: HeadlessPaneDefinition;
  args: HeadlessPaneLoadArgs;
  result: HeadlessPaneResult;
}

function argumentName(definition: HeadlessPaneDefinition): string {
  return definition.argument.placeholder
    ?? (definition.argument.kind === "free-text" ? "text" : "symbol");
}

function requiredArgumentError(definition: HeadlessPaneDefinition, token: string): Error {
  return new Error(`Usage: gloomberb fn ${token} <${argumentName(definition)}>`);
}

function normalizeSymbol(value: string): string {
  return value.trim().replace(/^\$+/, "").toUpperCase();
}

function normalizeSymbolList(value: string): string[] {
  const symbols: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(/[,\n]/)) {
    const symbol = normalizeSymbol(part);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}

function validateSymbolCount(
  definition: HeadlessPaneDefinition,
  token: string,
  symbols: string[],
): void {
  const minimum = definition.argument.minimum
    ?? (definition.argument.optional ? 0 : 1);
  const maximum = definition.argument.maximum;
  if (symbols.length < minimum) {
    if (minimum <= 1) throw requiredArgumentError(definition, token);
    throw new Error(`${token} requires at least ${minimum} symbols.`);
  }
  if (maximum != null && symbols.length > maximum) {
    throw new Error(`${token} accepts at most ${maximum} symbols.`);
  }
}

export function buildHeadlessPaneLoadArgs(
  definition: HeadlessPaneDefinition,
  token: string,
  rawArgument: string,
  options: HeadlessPaneOptionValues,
): HeadlessPaneLoadArgs {
  const raw = rawArgument.trim();
  switch (definition.argument.kind) {
    case "none":
      if (raw) throw new Error(`${token} does not accept an argument.`);
      return { rawArgument: raw, argument: null, symbols: [], options };
    case "free-text":
      if (!raw && !definition.argument.optional) throw requiredArgumentError(definition, token);
      return { rawArgument: raw, argument: raw || null, symbols: [], options };
    case "ticker": {
      const symbol = normalizeSymbol(raw);
      const symbols = symbol ? [symbol] : [];
      validateSymbolCount(definition, token, symbols);
      return {
        rawArgument: raw,
        argument: symbol || null,
        symbols,
        options,
      };
    }
    case "tickers":
    case "symbol-list": {
      const symbols = normalizeSymbolList(raw);
      validateSymbolCount(definition, token, symbols);
      return {
        rawArgument: raw,
        argument: symbols.length > 0 ? symbols : null,
        symbols,
        options,
      };
    }
    default: {
      const _exhaustive: never = definition.argument.kind;
      return _exhaustive;
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Headless pane load was aborted.");
}

export async function loadHeadlessPaneModel(
  definition: HeadlessPaneDefinition,
  args: HeadlessPaneLoadArgs,
  context: HeadlessPaneContext,
): Promise<HeadlessPaneResult> {
  throwIfAborted(context.signal);
  const result = await definition.load(args, context);
  throwIfAborted(context.signal);
  validateHeadlessResult(definition.shape, result);
  return result;
}

/**
 * Loads the same renderer-neutral model used by `fn`.
 * A future screenshot payload can call this function instead of adding another fetch path.
 */
export async function loadResolvedHeadlessPaneModel(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArgument: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<LoadedHeadlessPaneModel> {
  const definition = resolved.headless;
  if (!definition) throw new Error(`${resolved.token} has no headless pane model.`);
  const args = buildHeadlessPaneLoadArgs(definition, resolved.token, rawArgument, resolved.options);
  const headlessContext: HeadlessPaneContext = {
    marketData: context.dataProvider,
    apiClient,
    config: context.config,
    signal,
  };
  const result = await loadHeadlessPaneModel(definition, args, headlessContext);
  return { definition, args, result };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateHeadlessResult(shape: HeadlessPaneDefinition["shape"], result: unknown): void {
  if (!isRecord(result)) throw new Error(`Headless ${shape} loader returned an invalid result.`);
  const valid = shape === "rows"
    ? Array.isArray(result.rows)
    : shape === "bundle"
      ? Array.isArray(result.sections)
      : shape === "series"
        ? Array.isArray(result.series)
        : Array.isArray(result.items) && result.asOf != null;
  if (!valid) throw new Error(`Headless ${shape} loader returned an invalid result.`);
}

function serializableColumns(columns: HeadlessPaneColumn[]): SerializableHeadlessColumn[] {
  return columns.map((column) => ({
    key: column.key,
    header: column.header,
    ...(column.align ? { align: column.align } : {}),
    ...(column.width != null ? { width: column.width } : {}),
    ...(column.description ? { description: column.description } : {}),
  }));
}

function inferColumns(rows: HeadlessPaneRow[]): HeadlessPaneColumn[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) keys.add(key);
  }
  return [...keys].map((key) => ({ key, header: key }));
}

function columnsFor(
  rows: HeadlessPaneRow[],
  ownColumns: HeadlessPaneColumn[] | undefined,
  fallbackColumns: HeadlessPaneColumn[] | undefined,
): HeadlessPaneColumn[] {
  return ownColumns ?? fallbackColumns ?? inferColumns(rows);
}

function serializeBundleSection(
  section: HeadlessBundleSection,
  fallbackColumns: HeadlessPaneColumn[] | undefined,
): Record<string, unknown> {
  if ("rows" in section && section.rows) {
    const columns = columnsFor(section.rows, section.columns, fallbackColumns);
    return {
      title: section.title,
      columns: serializableColumns(columns),
      rows: section.rows,
    };
  }
  return { title: section.title, entries: section.entries };
}

export function serializeHeadlessPaneResult(
  definition: HeadlessPaneDefinition,
  result: HeadlessPaneResult,
): Record<string, unknown> {
  const common = {
    ...(result.errors ? { errors: result.errors } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
  switch (definition.shape) {
    case "rows": {
      const rowsResult = result as HeadlessPaneResult & { rows: HeadlessPaneRow[]; columns?: HeadlessPaneColumn[] };
      const columns = columnsFor(rowsResult.rows, rowsResult.columns, definition.columns);
      return { ...common, columns: serializableColumns(columns), rows: rowsResult.rows };
    }
    case "bundle": {
      const bundle = result as HeadlessBundleResult;
      return {
        ...common,
        sections: bundle.sections.map((section) => serializeBundleSection(section, definition.columns)),
      };
    }
    case "series": {
      const series = result as HeadlessSeriesResult;
      return { ...common, series: series.series, ...(series.stats ? { stats: series.stats } : {}) };
    }
    case "snapshot": {
      const snapshot = result as HeadlessSnapshotResult;
      const columns = columnsFor(snapshot.items, undefined, definition.columns);
      return {
        ...common,
        asOf: snapshot.asOf,
        columns: serializableColumns(columns),
        items: snapshot.items,
      };
    }
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
}

function displayValue(value: unknown): string {
  if (value == null) return "-";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function renderRows(
  rows: HeadlessPaneRow[],
  ownColumns: HeadlessPaneColumn[] | undefined,
  fallbackColumns: HeadlessPaneColumn[] | undefined,
): string {
  if (rows.length === 0) return "No data.";
  const columns = columnsFor(rows, ownColumns, fallbackColumns);
  return renderTable(
    columns.map((column) => ({
      header: column.header.toUpperCase(),
      align: column.align,
      width: column.width,
    })),
    rows.map((row) => columns.map((column) => {
      const value = row[column.key];
      return column.format ? column.format(value, row) : displayValue(value);
    })),
  );
}

function renderEntries(entries: HeadlessPaneEntry[]): string {
  if (entries.length === 0) return "No data.";
  return renderTable(
    [{ header: "METRIC" }, { header: "VALUE" }],
    entries.map((entry) => [entry.label, entry.formatted ?? displayValue(entry.value)]),
  );
}

function renderBundle(
  definition: HeadlessPaneDefinition,
  result: HeadlessBundleResult,
): string[] {
  return result.sections.flatMap((section, index) => [
    ...(index > 0 ? [""] : []),
    renderSection(section.title),
    "rows" in section && section.rows
      ? renderRows(section.rows, section.columns, definition.columns)
      : renderEntries(section.entries),
  ]);
}

function renderSeries(result: HeadlessSeriesResult): string[] {
  const rows = result.series.map((series) => {
    const latest = [...series.points].reverse().find((point) => (
      point.value != null || point.close != null
    ));
    return {
      series: series.label,
      latest: latest ? displayValue(latest.date) : "-",
      value: latest?.value ?? latest?.close ?? null,
      points: series.points.length,
    };
  });
  const columns: HeadlessPaneColumn[] = [
    { key: "series", header: "Series" },
    { key: "latest", header: "Latest" },
    { key: "value", header: "Value", align: "right" },
    { key: "points", header: "Points", align: "right" },
  ];
  const lines = [renderRows(rows, columns, undefined)];
  if (result.stats) {
    const entries = Array.isArray(result.stats)
      ? result.stats
      : Object.entries(result.stats).map(([label, value]) => ({ label, value }));
    lines.push("", renderSection("Statistics"), renderEntries(entries));
  }
  return lines;
}

function reportTitle(definition: HeadlessPaneDefinition, args: HeadlessPaneLoadArgs, fallback: string): string {
  if (typeof definition.describe === "function") return definition.describe(args);
  return definition.describe ?? fallback;
}

export function renderHeadlessPaneText(
  definition: HeadlessPaneDefinition,
  result: HeadlessPaneResult,
  args: HeadlessPaneLoadArgs,
  fallbackTitle: string,
): string {
  const lines = [reportTitle(definition, args, fallbackTitle), ""];
  switch (definition.shape) {
    case "rows": {
      const rowsResult = result as HeadlessPaneResult & { rows: HeadlessPaneRow[]; columns?: HeadlessPaneColumn[] };
      lines.push(renderRows(rowsResult.rows, rowsResult.columns, definition.columns));
      break;
    }
    case "bundle":
      lines.push(...renderBundle(definition, result as HeadlessBundleResult));
      break;
    case "series":
      lines.push(...renderSeries(result as HeadlessSeriesResult));
      break;
    case "snapshot": {
      const snapshot = result as HeadlessSnapshotResult;
      lines.push(`As of: ${displayValue(snapshot.asOf)}`, "", renderRows(snapshot.items, undefined, definition.columns));
      break;
    }
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
  if (result.errors?.length) lines.push("", `Errors: ${result.errors.join(" ")}`);
  return lines.join("\n").trimEnd();
}

function resultRowCount(definition: HeadlessPaneDefinition, result: HeadlessPaneResult): number {
  switch (definition.shape) {
    case "rows":
      return (result as { rows: HeadlessPaneRow[] }).rows.length;
    case "bundle":
      return (result as HeadlessBundleResult).sections.reduce((count, section) => (
        count + ("rows" in section && section.rows ? section.rows.length : section.entries.length)
      ), 0);
    case "series":
      return (result as HeadlessSeriesResult).series.reduce((count, series) => count + series.points.length, 0);
    case "snapshot":
      return (result as HeadlessSnapshotResult).items.length;
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
}

export async function buildHeadlessFunctionReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArgument: string,
): Promise<PaneFunctionReport> {
  const loaded = await loadResolvedHeadlessPaneModel(resolved, context, rawArgument);
  const rowCount = resultRowCount(loaded.definition, loaded.result);
  const unavailableSymbols = rowCount === 0 ? loaded.args.symbols : [];
  const serialized = serializeHeadlessPaneResult(loaded.definition, loaded.result);
  return {
    data: {
      kind: loaded.definition.shape,
      target: resolved.token,
      capabilityId: resolved.capability.id,
      symbols: loaded.args.symbols,
      options: resolved.options,
      rowCount,
      empty: rowCount === 0,
      complete: unavailableSymbols.length === 0 && !loaded.result.errors?.length,
      unavailableSymbols,
      ...serialized,
    },
    text: renderHeadlessPaneText(
      loaded.definition,
      loaded.result,
      loaded.args,
      resolved.label,
    ),
  };
}
