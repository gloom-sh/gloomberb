import { getSharedRegistry } from "../../plugins/registry";
import { findCachedPortfolioAccount } from "../../plugins/builtin/portfolio-list/cached-account";
import { parsePublicTickerKey } from "../../utils/exchanges";
import { findNamedCollection } from "../../portfolio/collection-name";
import { readBareListing } from "../listing-arg";
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
import { barLastSession } from "../../market-data/market/bar-period";
import type { PaneFunctionReport } from "./report";
import type { ResolvedPaneFunction } from "./resolver";
import { isRecord } from "../../utils/guards";
import { splitSymbolWords } from "../symbol-args";
import { formatUtcTime, localTimeSuffix } from "../../utils/utc-time";
import { deriveHeadlessFreshness, formatFreshnessLine, staleRowsText, type ReportFreshness } from "./freshness";
import { accessGateStatus, errorsAccessGate, isProLock, reportGateText } from "./access-gate";
import { noArgumentMessage } from "./capabilities";
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
  // Read after applyListingArgument, which has resolved a company's name to its listing key.
  for (const part of splitSymbolWords([value])) {
    const symbol = normalizeSymbol(part);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
  }
  return symbols;
}

const COUNT_WORDS = ["zero", "one", "two", "three", "four", "five"];
const EXAMPLE_TICKERS = ["SPY", "QQQ", "IWM", "DIA", "TLT"];

/**
 * What a function that compares several tickers answers fewer: how many it
 * needs and a command that runs, the reader's own tickers first (`CMP needs
 * two or more tickers: fn CMP SPY,QQQ`).
 */
function tooFewTickersMessage(token: string, minimum: number, given: readonly string[], command: "fn" | "shot" = "fn"): string {
  const example = [...given, ...EXAMPLE_TICKERS.filter((ticker) => !given.includes(ticker))].slice(0, Math.max(minimum, given.length + 1));
  return `${token} needs ${COUNT_WORDS[minimum] ?? minimum} or more tickers: ${command} ${token} ${example.join(",")}`;
}

/** The tickers a function's argument lists, as its report reads them. */
export function argumentSymbols(rawArgument: string): string[] {
  return normalizeSymbolList(rawArgument);
}

export function validateSymbolCount(
  definition: HeadlessPaneDefinition,
  token: string,
  symbols: string[],
  command: "fn" | "shot" = "fn",
): void {
  const minimum = definition.argument.minimum
    ?? (definition.argument.optional ? 0 : 1);
  const maximum = definition.argument.maximum;
  if (symbols.length < minimum) {
    if (minimum <= 1) throw requiredArgumentError(definition, token);
    throw new Error(tooFewTickersMessage(token, minimum, symbols, command));
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
      if (raw) throw new Error(noArgumentMessage(definition.options, token, raw));
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

type HeadlessMarketContext = Pick<MarketContext, "config" | "store" | "refresh" | "resolveBroker"> & Partial<Pick<MarketContext, "persistence" | "seriesCapabilities" | "findCatalogSeries">> & {
  dataProvider: HeadlessPaneContext["marketData"];
};

/** What a headless loader reads the market, the account and the saved collections through. */
export function createHeadlessPaneContext(
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
    catalogSeriesName: (expression) => (getSharedRegistry()?.series.findByExpression(expression)?.definition
      ?? context.findCatalogSeries?.(expression))?.name,
    resolveBroker: context.resolveBroker,
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
    async resolveListing(symbol, argumentWith) {
      const command = `fn ${resolved.token}`;
      const read = await readBareListing(symbol, context, {
        command, noun: "a quote", retry: (key) => `gloomberb ${command} ${argumentWith(key)}`,
      }, { refresh: !!context.refresh });
      if (!read) return null;
      return { symbol: read.symbol, ...read.exchange ? { exchange: read.exchange } : {}, ...read.name ? { name: read.name } : {} };
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
      ...(section.interval ? { interval: section.interval } : {}),
      ...(section.empty && section.rows.length === 0 ? { empty: section.empty } : {}),
      ...(section.locked ? { locked: true } : {}),
    };
  }
  return { title: section.title, entries: section.entries };
}

/** A table the free view held back and left empty: the text report says so on its Pro line, not under the table. */
function isLockedSection(section: HeadlessBundleSection): boolean {
  return !!section.locked && "rows" in section && !!section.rows && section.rows.length === 0;
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
        ...(bundle.empty && resultRowCount(definition, result) === 0 ? { empty: bundle.empty } : {}),
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
function calendarSeries(series: HeadlessSeries): (HeadlessSeries & Partial<Pick<ResolvedSeries, "historyResolution" | "timeBasis" | "listing">>) | null {
  const resolved = series as HeadlessSeries & Partial<Pick<ResolvedSeries, "historyResolution" | "timeBasis" | "listing">>;
  return resolved.historyResolution && CALENDAR_RESOLUTIONS.has(resolved.historyResolution) ? resolved : null;
}

const DAY_MS = 86_400_000;
const INTRADAY_INTERVAL = /^\d+(?:m|min|h)$|intraday/i;

/**
 * Whether a series observes days rather than instants: every observation at
 * 00:00 UTC, as FRED's closes and a plugin's daily series are dated. It is
 * then dated without a time (`2026-10-16`, not `2026-10-16 00:00 UTC`), as a
 * daily price bar is; a series with a real time of day (23:59) keeps it.
 */
function observesDays(series: HeadlessSeries): boolean {
  if (INTRADAY_INTERVAL.test(series.interval ?? "")) return false;
  const times = series.points.flatMap((point) => point.value != null || point.close != null ? [seriesPointTime(point.date)] : []);
  return times.length > 0 && times.every((time) => Number.isFinite(time) && time % DAY_MS === 0);
}

function seriesPointDate(series: HeadlessSeries, date: SeriesPointDate): string {
  const time = seriesPointTime(date);
  if (!Number.isFinite(time)) return typeof date === "string" ? date : "-";
  const calendar = calendarSeries(series);
  return calendar ? observationDate(time, calendar) : formatUtcTime({ time, dateOnly: isDateOnly(date) || observesDays(series) });
}

/**
 * The day a series' latest value is from: a weekly or monthly bar's last
 * session (barLastSession), Fri 16 Oct 2026 for the week of Mon 12 Oct, not
 * the day its period starts, which its row in an export keeps. Any other
 * point as seriesPointDate dates it.
 */
function seriesLatestDate(series: HeadlessSeries, date: SeriesPointDate): string {
  const calendar = calendarSeries(series);
  const period = calendar?.historyResolution === "1wk" ? "week" : calendar?.historyResolution === "1mo" ? "month" : null;
  const time = seriesPointTime(date);
  if (!calendar || !period || !Number.isFinite(time)) return seriesPointDate(series, date);
  const venue = calendar.timeBasis?.exchange || calendar.listing?.exchange || undefined;
  return barLastSession(observationDate(time, calendar), period, venue, Date.now()) ?? seriesPointDate(series, date);
}

/** The same date for a spreadsheet: the trading date, the calendar date, or the ISO instant. */
function seriesPointExportDate(series: HeadlessSeries, date: SeriesPointDate, days: boolean): string {
  const time = seriesPointTime(date);
  if (!Number.isFinite(time)) return typeof date === "string" ? date : "";
  const calendar = calendarSeries(series);
  if (calendar) return observationDate(time, calendar);
  if (isDateOnly(date)) return date as string;
  const iso = new Date(time).toISOString();
  return days ? iso.slice(0, 10) : iso.replace(".000Z", "Z");
}

/**
 * A latest value as the series report prints it: percentages and percentage
 * points, multiples and
 * ratios (P/E, EV/EBITDA, one series over another, VIX 3M / VIX) to two
 * decimals, which a ratio under 0.1 trades for three significant digits so it
 * is not flattened to 0.03, and a 0 to 100 score to a tenth of a point. The
 * exports keep every digit. Any other unit prints as loaded, without float
 * noise.
 */
function seriesValue(series: HeadlessSeries, value: number | null): string {
  if (value == null) return "-";
  if (!Number.isFinite(value)) return displayNumber(value);
  const unit = series.unit?.trim().toLowerCase();
  if (unit === "%" || unit === "pp") return value.toFixed(2);
  if (unit === "x" || unit === "ratio") return value !== 0 && Math.abs(value) < 0.1 ? value.toPrecision(3) : value.toFixed(2);
  if (unit === "score") return value.toFixed(1);
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
      header: column.textHeader ?? displayedHeader(column),
      align: column.align,
      width: column.width,
      shrink: column.shrink,
      minWidth: column.minWidth,
      stackPriority: column.stackPriority,
      stackRows: column.stackRows,
      minTableWidth: column.minTableWidth,
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
  // A locked table is named once, on the Pro line, not under each heading.
  return result.sections.filter((section) => !isLockedSection(section)).flatMap((section, index) => [
    ...(index > 0 ? [""] : []),
    // A section with no title is its rows, or its empty message, alone.
    ...(section.title ? [renderSection(section.title)] : []),
    "rows" in section && section.rows
      ? renderRows(section.textRows ?? section.rows, section.textColumns ?? section.columns, definition.columns, section.empty)
      : renderEntries(section.textEntries ?? section.entries),
  ]);
}

/** A series' observations: its points with a value. A gap kept to break the line is not one. */
function observationCount(series: HeadlessSeries): number {
  return series.points.filter((point) => point.value != null || point.close != null).length;
}

function renderSeries(result: HeadlessSeriesResult): string[] {
  const rows = result.series.map((series) => {
    const latest = [...series.points].reverse().find((point) => (
      point.value != null || point.close != null
    ));
    return {
      series: series.label,
      name: series.name?.trim() || null,
      latest: latest ? seriesLatestDate(series, latest.date) : "-",
      value: seriesValue(series, latest?.value ?? latest?.close ?? null),
      unit: series.unit?.trim() || null,
      points: observationCount(series),
    };
  });
  const columns: HeadlessPaneColumn[] = [
    { key: "series", header: "Series" },
    // A security's series names its company (BDI:XTSE is Black Diamond Group); other series have none.
    ...(rows.some((row) => row.name) ? [{ key: "name", header: "Name" }] : []),
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
  const days = observesDays(series);
  const dates = series.points.map((point) => seriesPointExportDate(series, point.date, days));
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
 * The report's one gate line, without its label: what Gloom Pro would unlock,
 * from the Pro lines in its errors or else the tables the free view left
 * empty, and where to get it (reportGateText). Null when nothing is locked.
 */
function reportGate(definition: HeadlessPaneDefinition, result: HeadlessPaneResult): string | null {
  const tables = definition.shape === "bundle"
    ? (result as HeadlessBundleResult).sections.filter(isLockedSection).map((section) => section.title)
    : [];
  return reportGateText(splitErrors(result).locked, tables);
}

/** The gate line as the text report prints it: once, after `Pro:`. */
function gateLine(gate: string): string {
  return cliStyles.warning(wrapToTerminal(`Pro: ${gate}`));
}

/**
 * Why a report with nothing in it is empty: the one reason a bundle gives
 * for all its tables, else, when its pane gave no reason of its own, the free
 * view left it empty (its Pro line, said here once), or the symbols asked for
 * are not covered by the function (or hold nothing for the options chosen).
 * Null when something has rows, a table states its own reason, an error
 * explains it, or no symbol was asked for (a board that is empty says nothing
 * about coverage).
 */
function emptyReportReason(
  definition: HeadlessPaneDefinition,
  result: HeadlessPaneResult,
  args: HeadlessPaneLoadArgs,
  token: string | undefined,
  gate: string | null,
): string | null {
  if (resultRowCount(definition, result) > 0) return null;
  const bundleReason = definition.shape === "bundle" ? (result as HeadlessBundleResult).empty : undefined;
  if (bundleReason) return bundleReason;
  const ownReason = definition.shape === "rows" ? !!(result as HeadlessRowsResult).empty
    : definition.shape === "bundle" && (result as HeadlessBundleResult).sections.some((section) => "empty" in section && !!section.empty && !isLockedSection(section));
  const { failed } = splitErrors(result);
  if (ownReason || failed.length) return null;
  // The free view left everything empty: the Pro line is the whole report, said once.
  if (gate) return gateLine(gate);
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
 * What each row of a table is of, from the fields its report names
 * (`rowUnitKey`, `rowSymbolKey`, `rowAsOfKey`); undefined when it names none.
 * An as-of may be an ISO date or instant, or epoch milliseconds.
 */
function rowIdentitiesOf(
  rows: readonly HeadlessPaneRow[],
  keys: { rowUnitKey?: string; rowSymbolKey?: string; rowAsOfKey?: string },
): ExportIdentity[] | undefined {
  const { rowUnitKey: unitKey, rowSymbolKey: symbolKey, rowAsOfKey: asOfKey } = keys;
  if (!unitKey && !symbolKey && !asOfKey) return undefined;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const instant = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : text(value);
  return rows.map((row) => ({
    ...(unitKey ? { currencyOrUnit: text(row[unitKey]) } : {}),
    ...(symbolKey ? { symbolOrSeries: text(row[symbolKey]) } : {}),
    ...(asOfKey ? { asOf: instant(row[asOfKey]) } : {}),
  }));
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
      const rowsResult = result as HeadlessRowsResult;
      const columns = displayedColumns(columnsFor(rowsResult.rows, rowsResult.columns, definition.columns));
      const rowIdentities = rowIdentitiesOf(rowsResult.rows, rowsResult);
      const own = exportRowsTable(title, columns, rowsResult.rows, { status: true });
      const interval = rowsResult.interval?.trim();
      tables = [{ ...own, ...(rowIdentities ? { rowIdentities } : {}), ...(interval ? { identity: { interval } } : {}) }, ...(rowsResult.exportTables ?? []).map((extra) => {
        const identity = {
          ...(extra.unit?.trim() ? { currencyOrUnit: extra.unit.trim() } : {}),
          ...(extra.interval?.trim() ? { interval: extra.interval.trim() } : {}),
        };
        const table = exportRowsTable(extra.title, displayedColumns(extra.columns), extra.rows, { status: true });
        return Object.keys(identity).length > 0 ? { ...table, identity } : table;
      })];
      break;
    }
    case "bundle":
      tables = (result as HeadlessBundleResult).sections.map((section) => {
        // A section of one name or one date says so for every line it exports.
        const named = {
          ...(section.symbol?.trim() ? { symbolOrSeries: section.symbol.trim() } : {}),
          ...(section.asOf?.trim() ? { asOf: section.asOf.trim() } : {}),
        };
        if (!("rows" in section && section.rows)) {
          const entries = exportEntriesTable(section.title, section.entries);
          return Object.keys(named).length > 0 ? { ...entries, identity: named } : entries;
        }
        const table = exportRowsTable(section.title, displayedColumns(columnsFor(section.rows, section.columns, definition.columns)), section.rows, { status: true });
        const identity = {
          ...named,
          ...(section.unit?.trim() ? { currencyOrUnit: section.unit.trim() } : {}),
          ...(section.interval?.trim() ? { interval: section.interval.trim() } : {}),
        };
        const rowIdentities = rowIdentitiesOf(section.rows, section);
        return { ...table, ...(Object.keys(identity).length > 0 ? { identity } : {}), ...(rowIdentities ? { rowIdentities } : {}) };
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
      tables = [exportRowsTable(title, displayedColumns(columnsFor(snapshot.items, undefined, definition.columns)), snapshot.items, { status: true })];
      break;
    }
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
  const { failed } = splitErrors(result);
  const gate = reportGate(definition, result);
  return {
    tables,
    identity: reportIdentity(definition, result, args),
    footer: reportFooterLines({
      freshness,
      incomplete: incompleteDetail(result, status),
      locked: gate ? [gate] : [],
      errors: failed,
      notes: [...textNotices(result), ...(definition.exportWarnings ? result.warnings ?? [] : []), ...(result.notes ?? [])],
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
  const gate = reportGate(definition, result);
  const reason = emptyReportReason(definition, result, args, token, gate);
  // Said once, not under the heading of each empty table.
  if (reason) lines.push(reason);
  else switch (definition.shape) {
    case "rows": {
      const rowsResult = result as HeadlessRowsResult;
      lines.push(renderRows(rowsResult.textRows ?? rowsResult.rows, rowsResult.textColumns ?? rowsResult.columns, definition.columns, rowsResult.empty));
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
  const { failed } = splitErrors(result);
  // One Pro line per report, whatever its tables lock; a report the free view left empty said it above.
  const pro = gate ? gateLine(gate) : null;
  if (pro && reason !== pro) lines.push("", pro);
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
      return (result as HeadlessSeriesResult).series.reduce((count, series) => count + observationCount(series), 0);
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
    const locked = await lockedHeadlessReport(resolved, error, () => (
      buildHeadlessPaneLoadArgs(resolved.headless!, resolved.token, rawArgument, resolved.options).symbols
    ), createHeadlessPaneContext(resolved, context, new AbortController().signal));
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
