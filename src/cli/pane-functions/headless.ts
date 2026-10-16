import { getSharedRegistry } from "../../plugins/registry";
import { findCachedPortfolioAccount } from "../../plugins/builtin/portfolio-list/cached-account";
import { parsePublicTickerKey } from "../../utils/exchanges";
import { findNamedCollection } from "../../portfolio/collection-name";
import { apiClient } from "../../api-client";
import type { MarketContext } from "../types";
import type {
  HeadlessArgumentExpansion,
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
  HeadlessRowsResult,
  HeadlessSeries,
  HeadlessSeriesResult,
  HeadlessSnapshotResult,
} from "../../types/plugin";
import { cliStyles, renderSection, renderStats, renderTable, wrapToTerminal } from "../../utils/cli-output";
import { humanizeCliKey } from "../result";
import {
  exportEntriesTable,
  exportNumber,
  exportRowsTable,
  float32Shortest,
  reportFooterLines,
  type CliReportTable,
  type CliReportTables,
} from "../report-tables";
import type { ExportIdentity } from "../export-source";
import { observationDate } from "../../time-series/price-comparison";
import type { ResolvedSeries } from "../../time-series/types";
import type { PaneFunctionReport } from "./report";
import type { ResolvedPaneFunction } from "./resolver";
import { isRecord } from "../../utils/guards";
import { splitSymbolArgs } from "../symbol-args";
import { formatUtcTime, localTimeSuffix } from "../../utils/utc-time";
import { deriveHeadlessFreshness, formatFreshnessLine, staleRowsText, type ReportFreshness } from "./freshness";
import { accessGateStatus, errorsAccessGate, isProLock } from "./access-gate";
import { lockedHeadlessReport } from "./lock-note";

interface SerializableHeadlessColumn {
  key: string;
  header: string;
  align?: "left" | "right" | "center";
  width?: number;
  description?: string;
  /** The row field that names this column's unit. */
  unitKey?: string;
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
  for (const part of splitSymbolArgs([value])) {
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

async function loadHeadlessPaneModel(
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

type HeadlessMarketContext = Pick<MarketContext, "config" | "store" | "refresh"> & Partial<Pick<MarketContext, "persistence" | "seriesCapabilities">> & {
  dataProvider: HeadlessPaneContext["marketData"];
};

/** What a headless loader reads the market, the account and the saved collections through. */
function createHeadlessPaneContext(
  resolved: ResolvedPaneFunction,
  context: HeadlessMarketContext,
  signal: AbortSignal,
): HeadlessPaneContext {
  return {
    marketData: context.dataProvider,
    apiClient,
    config: context.config,
    signal,
    ...(context.refresh ? { refresh: true } : {}),
    settings: resolved.instance.settings,
    capabilities: getSharedRegistry() ?? context.seriesCapabilities,
    async resolvePortfolio(id) {
      const portfolio = findNamedCollection(context.config.portfolios, id);
      if (!portfolio) return null;
      const tickers = (await context.store.loadAllTickers()).filter(row => row.metadata.portfolios.includes(portfolio.id));
      return { portfolio, tickers, account: findCachedPortfolioAccount(context.config, portfolio, context.persistence?.resources) };
    },
    async resolveWatchlist(id) {
      const watchlist = findNamedCollection(context.config.watchlists, id);
      if (!watchlist) return null;
      return (await context.store.loadAllTickers()).filter(row => row.metadata.watchlists.includes(watchlist.id));
    },
    async resolveInstrument(key) {
      const parsed = parsePublicTickerKey(key);
      const ticker = await context.store.loadTicker(key)
        ?? (key !== parsed.symbol ? await context.store.loadTicker(parsed.symbol) : null);
      return { symbol: parsed.symbol, exchange: parsed.exchange ?? ticker?.metadata.exchange };
    },
  };
}

/**
 * The argument a function widens before it runs (`expandArgument`, RV's
 * `--peers`), with the settings that say how; null when it runs as typed.
 */
export async function expandResolvedArgument(
  resolved: ResolvedPaneFunction,
  context: HeadlessMarketContext,
  rawArgument: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<HeadlessArgumentExpansion | null> {
  const definition = resolved.headless;
  if (!definition?.expandArgument) return null;
  const args = buildHeadlessPaneLoadArgs(definition, resolved.token, rawArgument, resolved.options);
  const expansion = await definition.expandArgument(args, createHeadlessPaneContext(resolved, context, signal));
  throwIfAborted(signal);
  return expansion;
}

/**
 * Loads the same renderer-neutral model used by `fn`.
 * Both reports and screenshot payloads execute this loader.
 */
export async function loadResolvedHeadlessPaneModel(
  resolved: ResolvedPaneFunction,
  context: HeadlessMarketContext,
  rawArgument: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<LoadedHeadlessPaneModel> {
  const definition = resolved.headless;
  if (!definition) throw new Error(`${resolved.token} has no headless pane model.`);
  const args = buildHeadlessPaneLoadArgs(definition, resolved.token, rawArgument, resolved.options);
  const result = await loadHeadlessPaneModel(definition, args, createHeadlessPaneContext(resolved, context, signal));
  return { definition, args, result };
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
    ...(column.unitKey ? { unitKey: column.unitKey } : {}),
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
      ...(section.unit ? { unit: section.unit } : {}),
      ...(section.empty && section.rows.length === 0 ? { empty: section.empty } : {}),
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
    ...(result.notes?.length ? { notes: result.notes } : {}),
    ...(result.warnings?.length ? { warnings: result.warnings } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
  switch (definition.shape) {
    case "rows": {
      const rowsResult = result as HeadlessRowsResult;
      const columns = columnsFor(rowsResult.rows, rowsResult.columns, definition.columns);
      return {
        ...common,
        columns: serializableColumns(columns),
        rows: rowsResult.rows,
        ...(rowsResult.empty && rowsResult.rows.length === 0 ? { empty: rowsResult.empty } : {}),
      };
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
  if (value instanceof Date) return displayTime(value.getTime());
  if (typeof value === "number") return displayNumber(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && ISO_INSTANT.test(value)) return displayInstant(value);
  return String(value);
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Providers hand some instants over as ISO strings; print them in UTC like Date
 * values, keeping seconds and milliseconds only when the source carries them
 * (tape prints), never SIP nanoseconds.
 */
function displayInstant(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const iso = new Date(time).toISOString();
  if (iso.slice(17, 23) === "00.000") return displayTime(time);
  return `${iso.slice(0, iso.endsWith(".000Z") ? 19 : 23).replace("T", " ")} UTC${localTimeSuffix(time)}`;
}

/** Drops binary floating-point noise (4.019999999999996) without rounding real digits. */
function displayNumber(value: number): string {
  if (!Number.isFinite(value) || Number.isInteger(value) || Math.abs(value) >= 1e9) return String(value);
  return String(float32Shortest(value) ?? Number(value.toPrecision(12)));
}

function displayTime(time: number): string {
  if (!Number.isFinite(time)) return "-";
  return formatUtcTime(new Date(time));
}

const CALENDAR_RESOLUTIONS = new Set(["1d", "1wk", "1mo"]);

type SeriesPointDate = HeadlessSeries["points"][number]["date"];

function seriesPointTime(date: SeriesPointDate): number {
  return date instanceof Date ? date.getTime() : typeof date === "number" ? date : Date.parse(date);
}

function isDateOnly(date: SeriesPointDate): boolean {
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/** Session bars are dated by the trading date the chart and comparison notice use, not the bar's open instant. */
function calendarSeries(series: HeadlessSeries): (HeadlessSeries & Partial<Pick<ResolvedSeries, "historyResolution" | "timeBasis">>) | null {
  const resolved = series as HeadlessSeries & Partial<Pick<ResolvedSeries, "historyResolution" | "timeBasis">>;
  return resolved.historyResolution && CALENDAR_RESOLUTIONS.has(resolved.historyResolution) ? resolved : null;
}

function seriesPointDate(series: HeadlessSeries, date: SeriesPointDate): string {
  const time = seriesPointTime(date);
  if (!Number.isFinite(time)) return typeof date === "string" ? date : "-";
  const calendar = calendarSeries(series);
  return calendar ? observationDate(time, calendar) : formatUtcTime({ time, dateOnly: isDateOnly(date) });
}

/** The same date for a spreadsheet: the trading date, the calendar date, or the ISO instant. */
function seriesPointExportDate(series: HeadlessSeries, date: SeriesPointDate): string {
  const time = seriesPointTime(date);
  if (!Number.isFinite(time)) return typeof date === "string" ? date : "";
  const calendar = calendarSeries(series);
  if (calendar) return observationDate(time, calendar);
  return isDateOnly(date) ? date as string : new Date(time).toISOString().replace(".000Z", "Z");
}

/**
 * A latest value as the series report prints it: percentages and multiples
 * (P/E, EV/EBITDA, one series over another) to two decimals, which a multiple
 * under 0.1 trades for three significant digits so a small ratio is not
 * flattened to 0.03. The exports keep every digit. Any other unit prints as
 * loaded, without float noise.
 */
function seriesValue(series: HeadlessSeries, value: number | null): string {
  if (value == null) return "-";
  if (!Number.isFinite(value)) return displayNumber(value);
  const unit = series.unit?.trim();
  if (unit === "%") return value.toFixed(2);
  if (unit?.toLowerCase() === "x") return value !== 0 && Math.abs(value) < 0.1 ? value.toPrecision(3) : value.toFixed(2);
  return displayNumber(value);
}

function renderRows(
  rows: HeadlessPaneRow[],
  ownColumns: HeadlessPaneColumn[] | undefined,
  fallbackColumns: HeadlessPaneColumn[] | undefined,
  empty?: string,
): string {
  if (rows.length === 0) return empty ?? "No data.";
  const all = columnsFor(rows, ownColumns, fallbackColumns);
  const columns = all.filter((column) => !column.underRow);
  const under = all.filter((column) => column.underRow);
  const cell = (row: HeadlessPaneRow, column: HeadlessPaneColumn) => {
    const value = row[column.key];
    const format = column.textFormat ?? column.format;
    return format ? format(value, row) : displayValue(value);
  };
  return renderTable(
    columns.map((column) => ({
      header: displayedHeader(column),
      align: column.align,
      width: column.width,
      shrink: column.shrink,
      minWidth: column.minWidth,
      stackPriority: column.stackPriority,
      stackRows: column.stackRows,
    })),
    rows.map((row) => columns.map((column) => cell(row, column))),
    {
      below: under.length === 0 ? undefined : rows.map((row) => under.flatMap((column) => (
        row[column.key] == null || row[column.key] === "" ? [] : cell(row, column).split("\n")
      ))),
    },
  );
}

function renderEntries(entries: HeadlessPaneEntry[]): string {
  if (entries.length === 0) return "No data.";
  return renderStats(entries.map((entry) => [entry.label, entry.formatted ?? displayValue(entry.value)]));
}

function statisticsEntries(stats: NonNullable<HeadlessSeriesResult["stats"]>): HeadlessPaneEntry[] {
  return Array.isArray(stats) ? stats : Object.entries(stats).map(([label, value]) => ({ label, value }));
}

function renderBundle(
  definition: HeadlessPaneDefinition,
  result: HeadlessBundleResult,
): string[] {
  return result.sections.flatMap((section, index) => [
    ...(index > 0 ? [""] : []),
    renderSection(section.title),
    "rows" in section && section.rows
      ? renderRows(section.textRows ?? section.rows, section.textColumns ?? section.columns, definition.columns, section.empty)
      : renderEntries(section.textEntries ?? section.entries),
  ]);
}

function renderSeries(result: HeadlessSeriesResult): string[] {
  const rows = result.series.map((series) => {
    const latest = [...series.points].reverse().find((point) => (
      point.value != null || point.close != null
    ));
    return {
      series: series.label,
      latest: latest ? seriesPointDate(series, latest.date) : "-",
      value: seriesValue(series, latest?.value ?? latest?.close ?? null),
      unit: series.unit?.trim() || null,
      points: series.points.length,
    };
  });
  const columns: HeadlessPaneColumn[] = [
    { key: "series", header: "Series" },
    { key: "latest", header: "Latest", shrink: false },
    { key: "value", header: "Value", align: "right" },
    ...(rows.some((row) => row.unit) ? [{ key: "unit", header: "Unit" }] : []),
    { key: "points", header: "Points", align: "right" },
  ];
  const lines = [renderRows(rows, columns, undefined)];
  if (result.stats) {
    lines.push("", renderSection("Statistics"), renderEntries(statisticsEntries(result.stats)));
  }
  return lines;
}

/** A column's header as reports print it: title-cased unless the column keeps it literal. */
function displayedHeader(column: HeadlessPaneColumn): string {
  return column.literalHeader ? column.header : humanizeCliKey(column.header);
}

/** The headers the text table prints. */
function displayedColumns(columns: HeadlessPaneColumn[]): HeadlessPaneColumn[] {
  return columns.map((column) => ({ ...column, header: displayedHeader(column) }));
}

const SERIES_FIELDS = ["value", "open", "high", "low", "close", "volume"] as const;

/**
 * Every point of a series: its date (the trading date for session bars) and
 * its values, in the series' unit, which the export's `currency_or_unit`
 * column names beside the bare `Value`, `Open`... headers.
 */
function seriesTable(series: HeadlessSeries): CliReportTable {
  const fields = SERIES_FIELDS.filter((field) => series.points.some((point) => point[field] != null));
  const dates = series.points.map((point) => seriesPointExportDate(series, point.date));
  const header = (field: (typeof SERIES_FIELDS)[number]) => `${field[0]!.toUpperCase()}${field.slice(1)}`;
  return {
    title: series.label,
    identity: {
      ...(series.symbol?.trim() ? { symbolOrSeries: series.symbol.trim() } : {}),
      ...(series.unit?.trim() ? { currencyOrUnit: series.unit.trim() } : {}),
      ...(series.interval?.trim() ? { interval: series.interval.trim() } : {}),
    },
    columns: [dates.every((date) => date.length <= 10) ? "Date" : "Time", ...fields.map(header)],
    rows: series.points.map((point, index) => [
      dates[index]!,
      ...fields.map((field) => {
        const value = point[field];
        return typeof value === "number" && Number.isFinite(value) ? exportNumber(value) : "";
      }),
    ]),
  };
}

/** What a report leaves out, for the closing `# incomplete` line. */
function incompleteDetail(
  result: HeadlessPaneResult,
  status: { complete: boolean; unavailableSymbols: string[] },
): boolean | string {
  if (status.complete) return false;
  const requested = result.metadata?.requested;
  const available = result.metadata?.available;
  if (typeof requested === "number" && typeof available === "number" && available < requested) {
    return `${available} of ${requested} available`;
  }
  return status.unavailableSymbols.length > 0 ? `no data for ${status.unavailableSymbols.join(", ")}` : true;
}

/** What Gloom Pro would unlock apart from what failed: a lock is not an error, though it stays in `errors` for JSON. */
function splitErrors(result: HeadlessPaneResult): { locked: string[]; failed: string[] } {
  const errors = result.errors ?? [];
  return { locked: errors.filter(isProLock), failed: errors.filter((error) => !isProLock(error)) };
}

/**
 * Why a report with nothing in it is empty, when its pane gave no reason of
 * its own: the free view left it empty (the report carries a Pro line), or the
 * symbols asked for are not covered by the function (or hold nothing for the
 * options chosen). Null when something has
 * rows, a table states its own reason, an error explains it, or no symbol was
 * asked for (a board that is empty says nothing about coverage).
 */
function emptyReportReason(
  definition: HeadlessPaneDefinition,
  result: HeadlessPaneResult,
  args: HeadlessPaneLoadArgs,
  token: string | undefined,
): string | null {
  if (resultRowCount(definition, result) > 0) return null;
  const ownReason = definition.shape === "rows" ? !!(result as HeadlessRowsResult).empty
    : definition.shape === "bundle" && (result as HeadlessBundleResult).sections.some((section) => "empty" in section && !!section.empty);
  const { locked, failed } = splitErrors(result);
  if (ownReason || failed.length) return null;
  if (locked.length) return "Locked: Gloom Pro";
  const symbols = result.symbols ?? args.symbols;
  if (!symbols.length) return null;
  // An option the reader chose (a range, a tab) can leave a covered symbol empty, so coverage is not claimed then.
  const narrowed = definition.options.some((option) => {
    const value = args.options[option.key];
    return value !== undefined && value !== "" && String(value) !== String(option.defaultValue ?? "");
  });
  return narrowed ? `No data for ${symbols.join(", ")} with these options.` : `No data for ${symbols.join(", ")}: not covered${token ? ` by ${token}` : ""}.`;
}

function textNotices(result: HeadlessPaneResult): string[] {
  const notices = result.metadata?.notices;
  if (!Array.isArray(notices)) return [];
  return [...new Set(notices.filter((notice): notice is string => typeof notice === "string" && notice.trim().length > 0))];
}

/**
 * The tables of a headless report for `--csv` and `--ndjson`, with the text
 * view's columns: a rows or snapshot report is one table, a bundle one per
 * section (key/value sections as `Metric,Value`), a series report one per
 * series with every point, then its statistics. The footer carries the text
 * view's closing line, notices, notes and errors.
 */
export function headlessReportTables(
  definition: HeadlessPaneDefinition,
  result: HeadlessPaneResult,
  args: HeadlessPaneLoadArgs,
  fallbackTitle: string,
  freshness: ReportFreshness,
  status: { complete: boolean; unavailableSymbols: string[] },
): CliReportTables {
  const title = reportTitle(definition, args, result, fallbackTitle);
  let tables: CliReportTable[];
  switch (definition.shape) {
    case "rows": {
      const rowsResult = result as HeadlessPaneResult & { rows: HeadlessPaneRow[]; columns?: HeadlessPaneColumn[] };
      const columns = displayedColumns(columnsFor(rowsResult.rows, rowsResult.columns, definition.columns));
      tables = [exportRowsTable(title, columns, rowsResult.rows)];
      break;
    }
    case "bundle":
      tables = (result as HeadlessBundleResult).sections.map((section) => {
        if (!("rows" in section && section.rows)) return exportEntriesTable(section.title, section.entries);
        const table = exportRowsTable(section.title, displayedColumns(columnsFor(section.rows, section.columns, definition.columns)), section.rows);
        return section.unit?.trim() ? { ...table, identity: { currencyOrUnit: section.unit.trim() } } : table;
      });
      break;
    case "series": {
      const seriesResult = result as HeadlessSeriesResult;
      tables = seriesResult.series.map(seriesTable);
      if (seriesResult.stats) tables.push(exportEntriesTable("Statistics", statisticsEntries(seriesResult.stats)));
      break;
    }
    case "snapshot": {
      const snapshot = result as HeadlessSnapshotResult;
      tables = [exportRowsTable(title, displayedColumns(columnsFor(snapshot.items, undefined, definition.columns)), snapshot.items)];
      break;
    }
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
  const { locked, failed } = splitErrors(result);
  return {
    tables,
    identity: reportIdentity(definition, result, args),
    footer: reportFooterLines({
      freshness,
      incomplete: incompleteDetail(result, status),
      locked,
      errors: failed,
      notes: [...textNotices(result), ...(result.notes ?? [])],
    }),
  };
}

/**
 * What a report's exported rows are of when it is about one symbol or series:
 * the one a chart's series were asked as, else the one symbol asked for or
 * resolved. A series table names its own symbol, unit and interval.
 */
function reportIdentity(definition: HeadlessPaneDefinition, result: HeadlessPaneResult, args: HeadlessPaneLoadArgs): ExportIdentity {
  const series = definition.shape === "series" ? (result as HeadlessSeriesResult).series : [];
  const charted = [...new Set(series.flatMap((entry) => entry.symbol?.trim() ? [entry.symbol.trim()] : []))];
  const symbols = charted.length > 0 ? charted : args.symbols.length > 0 ? args.symbols : result.symbols ?? [];
  return symbols.length === 1 ? { symbolOrSeries: symbols[0]! } : {};
}

function reportTitle(
  definition: HeadlessPaneDefinition,
  args: HeadlessPaneLoadArgs,
  result: HeadlessPaneResult,
  fallback: string,
): string {
  if (typeof definition.describe === "function") return definition.describe(args, result);
  return definition.describe ?? fallback;
}

/** One message stays on the label's line; several each get a line of their own, so none runs into the next. */
function renderMessages(label: string, messages: readonly string[]): string[] {
  return messages.length === 1
    ? [cliStyles.warning(wrapToTerminal(`${label}: ${messages[0]}`))]
    : [cliStyles.warning(`${label}:`), ...messages.map((message) => wrapToTerminal(`  ${message}`))];
}

/**
 * The text form of every headless report. It always ends with the source,
 * as-of and status line, so no pane can leave it out; a pane can only make it
 * more accurate through its `freshness` declaration.
 */
export function renderHeadlessPaneText(
  definition: HeadlessPaneDefinition,
  result: HeadlessPaneResult,
  args: HeadlessPaneLoadArgs,
  fallbackTitle: string,
  freshness: ReportFreshness = deriveHeadlessFreshness(definition, result),
  /** The function's token, which an empty report names as the one that does not cover the symbol. */
  token?: string,
): string {
  // A long title wraps to a narrow --width like the text under a table; each line stays bold.
  const lines = [...wrapToTerminal(reportTitle(definition, args, result, fallbackTitle)).split("\n").map(cliStyles.bold), ""];
  const notices = textNotices(result);
  if (notices.length) lines.push(...notices, "");
  const reason = emptyReportReason(definition, result, args, token);
  // Said once, not under the heading of each empty table.
  if (reason) lines.push(reason);
  else switch (definition.shape) {
    case "rows": {
      const rowsResult = result as HeadlessRowsResult;
      lines.push(renderRows(rowsResult.rows, rowsResult.textColumns ?? rowsResult.columns, definition.columns, rowsResult.empty));
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
      // The closing source line carries the snapshot's as-of, so it is not printed twice.
      lines.push(renderRows(snapshot.items, undefined, definition.columns));
      break;
    }
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
  if (result.notes?.length) lines.push("", ...renderMessages("Notes", result.notes));
  const { locked, failed } = splitErrors(result);
  if (locked.length) lines.push("", ...renderMessages("Pro", locked));
  if (failed.length) lines.push("", ...renderMessages("Errors", failed));
  return [lines.join("\n").trimEnd(), "", cliStyles.muted(wrapToTerminal(formatFreshnessLine(freshness)))].join("\n");
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

/**
 * Whether a loaded report covers what was asked, and which inputs it has no
 * data for. The one derivation behind `fn`'s `complete` and the status of a
 * capture of the same report.
 */
export function reportCoverage(
  { definition, args, result }: LoadedHeadlessPaneModel,
): { complete: boolean; unavailableSymbols: string[]; rowCount: number; symbols: string[] } {
  const rowCount = resultRowCount(definition, result);
  const symbols = result.symbols ?? args.symbols;
  const unavailableSymbols = result.unavailableSymbols ?? (rowCount === 0 ? symbols : []);
  const complete = result.complete !== false && unavailableSymbols.length === 0 && !result.errors?.length;
  return { complete, unavailableSymbols, rowCount, symbols };
}

/**
 * What a report that is not complete leaves out, in the words its own status
 * line and `# incomplete` line use: `2 stale`, `no data for IN`. Null when it
 * is complete or does not say.
 */
export function reportGaps(loaded: LoadedHeadlessPaneModel, freshness: ReportFreshness): string | null {
  const { complete, unavailableSymbols } = reportCoverage(loaded);
  if (complete) return null;
  const missing = incompleteDetail(loaded.result, { complete, unavailableSymbols });
  const gate = errorsAccessGate(loaded.result.errors);
  return [staleRowsText(freshness, true), typeof missing === "string" ? missing : null, gate ? accessGateStatus(gate) : null]
    .filter(Boolean).join(", ") || null;
}

export async function buildHeadlessFunctionReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArgument: string,
): Promise<PaneFunctionReport> {
  let loaded: LoadedHeadlessPaneModel;
  try {
    loaded = await loadResolvedHeadlessPaneModel(resolved, context, rawArgument);
  } catch (error) {
    // A Pro pane the server refused reports what its wall covers, as its rendered view does.
    const locked = lockedHeadlessReport(resolved, error, () => (
      buildHeadlessPaneLoadArgs(resolved.headless!, resolved.token, rawArgument, resolved.options).symbols
    ));
    if (locked) return locked;
    throw error;
  }
  const { complete, unavailableSymbols, rowCount, symbols } = reportCoverage(loaded);
  const serialized = serializeHeadlessPaneResult(loaded.definition, loaded.result);
  const freshness = deriveHeadlessFreshness(loaded.definition, loaded.result);
  return {
    data: {
      kind: loaded.definition.shape,
      target: resolved.token,
      capabilityId: resolved.capability.id,
      symbols,
      options: resolved.options,
      rowCount,
      empty: rowCount === 0,
      complete,
      unavailableSymbols,
      ...serialized,
      freshness,
    },
    text: renderHeadlessPaneText(
      loaded.definition,
      loaded.result,
      loaded.args,
      resolved.label,
      freshness,
      resolved.token,
    ),
    tables: headlessReportTables(
      loaded.definition,
      loaded.result,
      loaded.args,
      resolved.label,
      freshness,
      { complete, unavailableSymbols },
    ),
  };
}
