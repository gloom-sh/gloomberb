import { currencyRateUnitText } from "../../time-series/price-units";
import { formatBasisPoints } from "../../utils/basis-points";
import { getSharedRegistry } from "../../plugins/registry";
import { seriesExpression, seriesNamedBy } from "../../series/registry";
import { findCachedPortfolioAccount } from "../../plugins/builtin/portfolio-list/cached-account";
import { findNamedCollection } from "../../portfolio/collection-name";
import { readBareListing } from "../listing-arg";
import { apiClient } from "../../api-client";
import { resolveSavedInstrument } from "../../tickers/saved-instrument";
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
  HeadlessSeriesPoint,
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
import { chartBarSizeName, chartBarSizeParts, type ChartBarSize } from "../../time-series/resolution";
import type { ResolvedSeries } from "../../time-series/types";
import { barLastSession } from "../../market-data/market/bar-period";
import type { PaneFunctionReport } from "./report";
import type { ResolvedPaneFunction } from "./resolver";
import { isRecord } from "../../utils/guards";
import { displayTickerKey } from "../../utils/exchanges";
import { splitSymbolWords } from "../symbol-args";
import { formatUtcTime, localTimeSuffix } from "../../utils/utc-time";
import { formatDay } from "../../utils/day-format";
import { MISSING_VALUE, formatCompact, formatSignificant } from "../../utils/format";
import { deriveHeadlessFreshness, formatFreshnessLine, staleRowsText, withSavedCopy, type ReportFreshness } from "./freshness";
import { DATA_SERVICE_UNREACHABLE_MESSAGE } from "../../utils/network-failure";
import { accessGateStatus, errorsAccessGate, isProLock, reportGateText } from "./access-gate";
import { readableStatus } from "../../utils/reason-codes";
import { noArgumentMessage } from "./capabilities";
import { lockedHeadlessReport } from "./lock-note";
import { resumeStateKey } from "../../plugins/registry/plugin-state";
import { logFailure } from "../../utils/log-failure";
import { rowWindowCutNote, windowRows, type RowWindowOptions } from "../row-window";

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
  return new Error(`Usage: gloom fn ${token} <${argumentName(definition)}>`);
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

type HeadlessMarketContext = Pick<MarketContext, "config" | "store" | "refresh" | "resolveBroker"> & Partial<Pick<MarketContext, "persistence" | "seriesCapabilities" | "findCatalogSeries" | "findCatalogSeriesNamed">> & {
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
    catalogSeriesNamed: (word) => {
      const registered = getSharedRegistry()?.series?.list().map(({ definition }) => definition) ?? [];
      const definition = seriesNamedBy(registered, word) ?? context.findCatalogSeriesNamed?.(word);
      return definition ? { expression: seriesExpression(definition), name: definition.name } : undefined;
    },
    resolveBroker: context.resolveBroker,
    async resolvePortfolio(id) {
      // A report reads a portfolio by the start of its name too, as the command bar opens it (`PORT family`).
      const portfolio = findNamedCollection(context.config.portfolios, id, { prefix: true });
      if (!portfolio) return null;
      const tickers = (await context.store.loadAllTickers()).filter(row => row.metadata.portfolios.includes(portfolio.id));
      return { portfolio, tickers, account: findCachedPortfolioAccount(context.config, portfolio, context.persistence?.resources) };
    },
    async resolveWatchlist(id) {
      const watchlist = findNamedCollection(context.config.watchlists, id, { prefix: true });
      if (!watchlist) return null;
      return (await context.store.loadAllTickers()).filter(row => row.metadata.watchlists.includes(watchlist.id));
    },
    resolveInstrument: (key) => resolveSavedInstrument(key, (saved) => context.store.loadTicker(saved)),
    readDeviceState: <T,>(pluginId: string, key: string) =>
      context.persistence?.pluginState.get<T>(pluginId, resumeStateKey(key))?.value ?? null,
    readSavedState: <T,>(pluginId: string, key: string, schemaVersion?: number) => {
      try {
        // Strict: a copy this build cannot read stays for the app, where `get` would drop it.
        const record = context.persistence?.pluginState.getStrict<T>(pluginId, key, schemaVersion);
        return record ? { value: record.value, savedAt: record.updatedAt } : null;
      } catch (error) {
        return logFailure("headless.saved-state", `Read ${pluginId}'s saved ${key} failed`, null)(error);
      }
    },
    async resolveListing(symbol, argumentWith) {
      const command = `fn ${resolved.token}`;
      const read = await readBareListing(symbol, context, {
        command, noun: "a quote", retry: (key) => `gloom ${command} ${argumentWith(key)}`,
      }, { refresh: !!context.refresh, successor: true });
      if (!read) return null;
      if ("notATicker" in read) return { symbol, notATicker: read.notATicker };
      return {
        symbol: read.symbol,
        ...read.exchange ? { exchange: read.exchange } : {},
        ...read.name ? { name: read.name } : {},
        ...read.coinNote ? { coinNote: read.coinNote } : {},
        ...read.successorNote ? { successorNote: read.successorNote } : {},
        ...read.readAs ? { readAs: read.readAs } : {},
        ...read.ownedNotes?.length ? { ownedNotes: read.ownedNotes } : {},
      };
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
    ...(result.errors ? { errors: result.errors.map((error) => isProLock(error) ? error : readableStatus(error)) } : {}),
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
      // `textDecimals` and `textCompact` only shape the text report; JSON keeps every digit and does not carry them.
      return { ...common, series: series.series.map(({ textDecimals: _decimals, textCompact: _compact, ...kept }) => (
        kept.unit ? { ...kept, unit: currencyRateUnitText(kept.unit) } : kept
      )), ...(series.stats ? { stats: series.stats } : {}) };
    }
    case "snapshot": {
      const snapshot = result as HeadlessSnapshotResult;
      const columns = columnsFor(snapshot.items, undefined, definition.columns);
      return {
        ...common,
        asOf: snapshot.asOf,
        columns: serializableColumns(columns),
        items: snapshot.items,
        ...(snapshot.empty && snapshot.items.length === 0 ? { empty: snapshot.empty } : {}),
      };
    }
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
}

function displayValue(value: unknown): string {
  if (value == null) return MISSING_VALUE;
  if (value instanceof Date) return displayTime(value.getTime());
  if (typeof value === "number") return displayNumber(value);
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "string" && ISO_INSTANT.test(value)) return displayInstant(value);
  // A calendar day reads as the pane writes it (docs/pane-conventions.md, "One date format").
  if (typeof value === "string" && ISO_DAY_ONLY.test(value)) return formatDay(value);
  return String(value);
}

const ISO_DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
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
  if (!Number.isFinite(time)) return MISSING_VALUE;
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
  if (!Number.isFinite(time)) return typeof date === "string" ? date : MISSING_VALUE;
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
  // A period still forming on a venue whose sessions are not known here (an index publisher, a futures board) is its value's own day.
  return barLastSession(observationDate(time, calendar), period, venue, Date.now()) ?? series.latestDate ?? seriesPointDate(series, date);
}

function seriesLatestReading(series: HeadlessSeries, point: HeadlessSeriesPoint): string {
  if (point.barStart != null && point.availableAt != null && chartBarSizeParts(series.interval)) {
    const startTime = seriesPointTime(point.barStart), endTime = seriesPointTime(point.availableAt);
    if (Number.isFinite(startTime) && Number.isFinite(endTime)) {
      const start = new Date(startTime).toISOString().slice(0, 16), end = new Date(endTime).toISOString().slice(0, 16);
      const endClock = start.slice(0, 10) === end.slice(0, 10) ? end.slice(11) : end.replace("T", " ");
      return `${start.replace("T", " ")}–${endClock} UTC (${chartBarSizeName(series.interval as ChartBarSize)} bar close)`;
    }
  }
  return seriesLatestDate(series, point.date);
}

/**
 * Each series' own last day, as its exported rows' `as_of`, when the series of
 * a report end on different days (a price through Fri 20 Nov beside a spread
 * published through Thu 19 Nov): the closing lines date the newest, which is
 * not every series' day. Nothing for series that end on one day or at a time.
 */
function seriesLastDays(series: readonly HeadlessSeries[]): Array<string | undefined> {
  const days = series.map((entry) => {
    const latest = [...entry.points].reverse().find((point) => point.value != null || point.close != null);
    const day = entry.notMeaningful ? null : latest ? seriesLatestDate(entry, latest.date) : null;
    return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
  });
  return new Set(days.filter(Boolean)).size > 1 ? days : series.map(() => undefined);
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
 * points and valuation multiples usually read to two decimals, series ratios
 * to four significant digits, and a 0 to 100 score to a tenth of a point. A
 * company's reported total (`textCompact`) reads as the tables print one:
 * 63.33B. The exports keep every digit. Any other unit prints as loaded,
 * without float noise.
 */
function seriesValue(series: HeadlessSeries, value: number | null): string {
  if (value == null) return MISSING_VALUE;
  if (!Number.isFinite(value)) return displayNumber(value);
  if (series.textDecimals != null) return value.toFixed(series.textDecimals);
  if (series.textCompact) return formatCompact(value);
  const unit = series.unit?.trim().toLowerCase();
  if (unit === "%" || unit === "pp") return value.toFixed(2);
  if (series.unitGroup?.toLowerCase() === "ratio" || unit === "ratio") return formatSignificant(value);
  if (unit === "x") return value !== 0 && Math.abs(value) < 0.1 ? value.toPrecision(3) : value.toFixed(2);
  if (unit === "score") return value.toFixed(1);
  // A count or amount of five digits or more groups its thousands as every other table does (27,256,037 shares).
  const plain = displayNumber(value);
  const [whole, fraction] = plain.split(".");
  return Math.abs(value) >= 10_000 && /^-?\d+(?:\.\d+)?$/.test(plain)
    ? `${whole!.replace(/\B(?=(\d{3})+$)/g, ",")}${fraction ? `.${fraction}` : ""}` : plain;
}

const blankText = (text: string) => text === "" || text === MISSING_VALUE;

/** The columns the text prints: an `omitWhenEmpty` one blank in every row, or an `omitWhenSame` one every row prints alike, leaves. */
function withoutFillerColumns(
  rows: readonly HeadlessPaneRow[],
  columns: HeadlessPaneColumn[],
  cell: (row: HeadlessPaneRow, column: HeadlessPaneColumn) => string,
): HeadlessPaneColumn[] {
  if (!columns.some((column) => column.omitWhenEmpty || column.omitWhenSame)) return columns;
  return columns.filter((column) => {
    if (!column.omitWhenEmpty && !column.omitWhenSame) return true;
    const texts = rows.map((row) => cell(row, column).trim());
    if (column.omitWhenEmpty && texts.every(blankText)) return false;
    return !(column.omitWhenSame && texts.length >= 2 && texts.every((text) => text === texts[0] || (blankText(text) && blankText(texts[0]!))));
  });
}

function renderRows(
  rows: HeadlessPaneRow[],
  ownColumns: HeadlessPaneColumn[] | undefined,
  fallbackColumns: HeadlessPaneColumn[] | undefined,
  empty?: string,
): string {
  if (rows.length === 0) return empty ?? "No data.";
  const cell = (row: HeadlessPaneRow, column: HeadlessPaneColumn) => {
    const value = row[column.key];
    const format = column.textFormat ?? column.format;
    return format ? format(value, row) : displayValue(value);
  };
  const all = withoutFillerColumns(rows, columnsFor(rows, ownColumns, fallbackColumns), cell);
  const columns = all.filter((column) => !column.underRow);
  const under = all.filter((column) => column.underRow);
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
      optional: column.optional,
      dropPriority: column.dropPriority,
    })),
    rows.map((row) => columns.map((column) => cell(row, column))),
    {
      // A value the text leaves out (a summary that only repeats the headline) takes no line.
      below: under.length === 0 ? undefined : rows.map((row) => under.flatMap((column) => {
        const text = row[column.key] == null || row[column.key] === "" ? "" : cell(row, column);
        return text === "" ? [] : text.split("\n");
      })),
      ...(under.length > 0 && under.every((column) => column.underRow === "line") ? { cutBelow: true } : {}),
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
  sections: readonly HeadlessBundleSection[],
): string[] {
  // A locked table is named once, on the Pro line, not under each heading.
  return sections.filter((section) => !isLockedSection(section)).flatMap((section, index) => [
    ...(index > 0 ? [""] : []),
    // A section with no title is its rows, or its empty message, alone.
    ...(section.title ? [renderSection(("textPreview" in section ? section.textPreview?.title : undefined) ?? section.textTitle ?? section.title)] : []),
    "rows" in section && section.rows
      ? renderRows(section.textRows ?? section.rows.slice(0, section.textPreview?.limit), section.textColumns ?? section.columns, definition.columns, section.empty)
      : renderEntries(section.textEntries ?? section.entries),
  ]);
}

/** A series' observations: its points with a value. A gap kept to break the line is not one. */
function observationCount(series: HeadlessSeries): number {
  return series.points.filter((point) => point.value != null || point.close != null).length;
}

/** The averages, and the change with what it is against: the year-ago mean and the days it is of. */
const TRAILING_COLUMNS: HeadlessPaneColumn[] = [
  { key: "avg7", header: "7D avg", literalHeader: true, align: "right" },
  { key: "avg28", header: "28D avg", literalHeader: true, align: "right" },
  { key: "yearAgoAvg28", header: "Yr-ago 28D avg", literalHeader: true, align: "right" },
  { key: "yearAgoWindow", header: "Yr-ago days", literalHeader: true, shrink: false },
  { key: "vsYearAgo", header: "28D vs yr ago", literalHeader: true, align: "right" },
];

function trailingCells(trailing: HeadlessSeries["trailing"]): Record<string, string> {
  if (!trailing) return {};
  const mean = (value: number | null) => (value == null ? MISSING_VALUE : value.toFixed(1));
  const change = trailing.changeVsYearAgoPct;
  const days = trailing.yearAgoWindow;
  return {
    avg7: mean(trailing.avg7),
    avg28: mean(trailing.avg28),
    yearAgoAvg28: mean(trailing.yearAgoAvg28),
    yearAgoWindow: days ? `${days.start} to ${days.end}` : MISSING_VALUE,
    vsYearAgo: change == null || !Number.isFinite(change) ? MISSING_VALUE : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`,
  };
}

function renderSeries(result: HeadlessSeriesResult, showPoints: boolean): string[] {
  // Series served in different bars (a chart's 5-minute bars beside a series a source answered in daily ones) name theirs.
  const barSizes = result.series.map((series) => (chartBarSizeParts(series.interval?.trim()) ? series.interval!.trim() : null));
  const mixedBars = new Set(barSizes.filter(Boolean)).size > 1;
  const rows = result.series.map((series, index) => {
    const latest = [...series.points].reverse().find((point) => (
      point.value != null || point.close != null
    ));
    // N/M stands for the period the series would end on, not an older value before it.
    return {
      series: series.label,
      name: series.name?.trim() || null,
      latest: series.notMeaningful ? series.notMeaningful.asOf : latest ? seriesLatestReading(series, latest) : MISSING_VALUE,
      value: series.notMeaningful ? "N/M" : seriesValue(series, latest?.value ?? latest?.close ?? null),
      unit: series.unit?.trim() ? currencyRateUnitText(series.unit.trim()) : null,
      move: series.latestChangeBasisPoints === undefined ? null : formatBasisPoints(series.latestChangeBasisPoints / 100, 1),
      native: latest?.nativeAmount ? `${seriesValue(series, latest.nativeAmount.value)} ${latest.nativeAmount.currency}` : null,
      ...trailingCells(series.trailing),
      ...(mixedBars ? { bars: barSizes[index] ?? MISSING_VALUE } : {}),
      points: observationCount(series),
    };
  });
  const trailing = result.series.some((series) => series.trailing);
  const columns: HeadlessPaneColumn[] = [
    { key: "series", header: "Series" },
    // A security's series names its company (BDI:XTSE is Black Diamond Group); other series have none.
    ...(rows.some((row) => row.name) ? [{ key: "name", header: "Name" }] : []),
    { key: "latest", header: "Latest", shrink: false },
    { key: "value", header: "Value", align: "right" },
    ...(trailing ? TRAILING_COLUMNS : []),
    ...(rows.some((row) => row.unit) ? [{ key: "unit", header: "Unit" }] : []),
    ...(rows.some((row) => row.move) ? [{ key: "move", header: "Session move", align: "right" as const }] : []),
    ...(mixedBars ? [{ key: "bars", header: "Bars" }] : []),
    ...(rows.some((row) => row.native) ? [{ key: "native", header: "Native", align: "right" as const }] : []),
    // Beside the averages, the count of points is the first thing a narrow table drops.
    { key: "points", header: "Points", align: "right", ...(trailing ? { optional: true } : {}) },
  ];
  const lines = [renderRows(rows, columns, undefined)];
  const notMeaningful = result.series.flatMap((series) => series.notMeaningful
    ? [`${series.label}: N/M, ${series.notMeaningful.reason.charAt(0).toLowerCase()}${series.notMeaningful.reason.slice(1)}.`] : []);
  if (notMeaningful.length) lines.push("", ...notMeaningful.map((line) => wrapToTerminal(line)));
  if (result.stats) {
    lines.push("", renderSection("Statistics"), renderEntries(statisticsEntries(result.stats)));
  }
  if (showPoints) {
    for (const series of result.series) {
      if (series.points.length === 0) continue;
      const table = seriesTable(series, true);
      const columns = table.columns.map((header, index): HeadlessPaneColumn => ({ key: String(index), header,
        ...(index > 0 ? { align: "right" } : { shrink: false }) }));
      const unit = table.identity?.currencyOrUnit;
      lines.push("", renderSection(`${table.title}${unit ? ` (${unit})` : ""}`),
        renderRows(table.rows.map((row) => ({ ...row })), columns, undefined));
    }
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
function seriesTable(series: HeadlessSeries, text = false): CliReportTable {
  const fields = SERIES_FIELDS.filter((field) => !(field === "value" && series.valueIsClose) && series.points.some((point) => point[field] != null));
  const days = observesDays(series);
  const dates = series.points.map((point) => seriesPointExportDate(series, point.date, days));
  const header = (field: (typeof SERIES_FIELDS)[number]) => `${field[0]!.toUpperCase()}${field.slice(1)}`;
  const contracts = seriesContractColumns(series);
  return {
    title: series.label,
    identity: {
      // A listing by its venue's code (9992:HKEX), as every other export names it; JSON keeps the stored key.
      ...(series.symbol?.trim() ? { symbolOrSeries: displayTickerKey(series.symbol.trim()) } : {}),
      // A rate reads `JPY per USD` here as in every other export.
      ...(series.unit?.trim() ? { currencyOrUnit: currencyRateUnitText(series.unit.trim()) } : {}),
      ...(series.interval?.trim() ? { interval: series.interval.trim() } : {}),
    },
    columns: [dates.every((date) => date.length <= 10) ? "Date" : "Time", ...fields.map(header), ...contracts.columns],
    // The contract columns came after the fixed ones: they close the row, so no earlier column moves.
    ...contracts.columns.length ? { appendedColumns: contracts.columns.length } : {},
    rows: series.points.map((point, index) => [
      dates[index]!,
      ...fields.map((field) => {
        const value = point[field];
        return text ? seriesValue(series, typeof value === "number" ? value : null)
          : typeof value === "number" && Number.isFinite(value) ? exportNumber(value) : "";
      }),
      ...contracts.cells(point, index),
    ]),
  };
}

/**
 * The contract columns of a futures series, after its figures, as `history`
 * writes them: a continuous future's `Contract`, or a formula's contract of
 * each leg (`RB=F Contract`), then `Roll` and `Partial`. A roll is the
 * contract (a formula's legs') changing from the point before, the bar
 * before the window included, so a window's first row can be one. None for a
 * series of no contracts.
 */
function seriesContractColumns(series: HeadlessSeries): { columns: string[]; cells: (point: HeadlessSeriesPoint, index: number) => string[] } {
  const legNames = series.formulaLegs ?? [];
  const formula = legNames.length > 0
    && series.points.some((point) => point.legs?.length === legNames.length && point.legs.some((leg) => leg.contract));
  const continuous = !formula && series.points.some((point) => point.contract);
  const flag = (value: boolean | undefined) => value ? "true" : "false";
  // A series of no contracts whose newest bar is still forming says which as JSON does (`partial`), as `history` does.
  if (!formula && !continuous) {
    return series.points.some((point) => point.partial)
      ? { columns: ["Partial"], cells: (point) => [flag(point.partial)] } : { columns: [], cells: () => [] };
  }
  return {
    columns: [...formula ? legNames.map((leg) => `${leg} Contract`) : ["Contract"], "Roll", "Partial"],
    cells: (point, index) => {
      if (formula) {
        return [...legNames.map((_, position) => point.legs?.[position]?.contract ?? ""), flag(point.roll), flag(point.partial)];
      }
      const previous = index > 0 ? series.points[index - 1]?.contract : null;
      const roll = point.roll || (!!point.contract && !!previous && point.contract !== previous);
      return [point.contract ?? "", flag(roll), flag(point.partial)];
    },
  };
}

/** What a report leaves out, for the closing `# incomplete` line. */
function incompleteDetail(
  result: HeadlessPaneResult,
  status: { complete: boolean; unavailableSymbols: string[] },
): boolean | string {
  if (status.complete) return false;
  if (result.incompleteDetail) return result.incompleteDetail;
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
  // A failure reads in words: "AAPL: the source did not answer", not its reason code.
  return { locked: errors.filter(isProLock), failed: errors.filter((error) => !isProLock(error)).map(readableStatus) };
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
    : definition.shape === "snapshot" ? !!(result as HeadlessSnapshotResult).empty
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

function textNotices(result: HeadlessPaneResult, text = false): string[] {
  const notices = text && result.textNotices ? result.textNotices : result.metadata?.notices;
  if (!Array.isArray(notices)) return [];
  return [...new Set(notices.filter((notice): notice is string => typeof notice === "string" && notice.trim().length > 0))];
}

/** The notes the text report prints: `textNotes` for the load's own, then any added after it (a row window's). */
function printedNotes(result: HeadlessPaneResult): string[] | undefined {
  if (!result.textNotes) return result.notes;
  return [...result.textNotes, ...(result.notes ?? []).slice(result.textNotes.length)];
}

/**
 * What each row of a table is of, from the fields its report names
 * (`rowUnitKey`, `rowSymbolKey`, `rowAsOfKey`, `rowIntervalKey`,
 * `rowSourceKey`); undefined when it names none. An as-of may be an ISO date
 * or instant, or epoch milliseconds.
 */
function rowIdentitiesOf(
  rows: readonly HeadlessPaneRow[],
  keys: { rowUnitKey?: string; rowSymbolKey?: string; rowAsOfKey?: string; rowIntervalKey?: string; rowSourceKey?: string },
): ExportIdentity[] | undefined {
  const { rowUnitKey: unitKey, rowSymbolKey: symbolKey, rowAsOfKey: asOfKey, rowIntervalKey: intervalKey, rowSourceKey: sourceKey } = keys;
  if (!unitKey && !symbolKey && !asOfKey && !intervalKey && !sourceKey) return undefined;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const instant = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : text(value);
  return rows.map((row) => ({
    ...(unitKey ? { currencyOrUnit: text(row[unitKey]) } : {}),
    ...(symbolKey ? { symbolOrSeries: text(row[symbolKey]) } : {}),
    ...(asOfKey ? { asOf: instant(row[asOfKey]) } : {}),
    ...(intervalKey ? { interval: text(row[intervalKey]) } : {}),
    ...(sourceKey ? { source: text(row[sourceKey]) } : {}),
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
      const own = exportRowsTable(title, columns, rowsResult.rows, { status: true, ...(rowsResult.rowUnitKey ? { rowUnitKey: rowsResult.rowUnitKey } : {}) });
      const ownIdentity = {
        ...(rowsResult.unit?.trim() ? { currencyOrUnit: rowsResult.unit.trim() } : {}),
        ...(rowsResult.interval?.trim() ? { interval: rowsResult.interval.trim() } : {}),
      };
      tables = [{ ...own, ...(rowIdentities ? { rowIdentities } : {}), ...(Object.keys(ownIdentity).length > 0 ? { identity: ownIdentity } : {}) }, ...(rowsResult.exportTables ?? []).map((extra) => {
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
          ...(section.unit?.trim() ? { currencyOrUnit: section.unit.trim() } : {}),
          ...(section.interval?.trim() ? { interval: section.interval.trim() } : {}),
          ...("source" in section && section.source?.trim() ? { source: section.source.trim() } : {}),
          ...(section.asOf === null ? { asOf: null } : section.asOf?.trim() ? { asOf: section.asOf.trim() } : {}),
          ...(section.period?.trim() ? { period: section.period.trim() } : {}),
          ...(section.released?.trim() ? { released: section.released.trim() } : {}),
        };
        if (!("rows" in section && section.rows)) {
          const entries = exportEntriesTable(section.title, section.entries);
          // A figure that declares its unit names it in the unit column of its own line too.
          // A line of its own period or release (a previous reading) names them rather than the section's.
          const own = (entry: HeadlessPaneEntry): ExportIdentity | undefined => {
            const identity = {
              // An export unit names a number's unit: a figure missing with its reason has none.
              ...(entry.unit?.trim() ? { currencyOrUnit: entry.unit.trim() }
                : entry.exportUnit?.trim() && typeof entry.value === "number" && Number.isFinite(entry.value) ? { currencyOrUnit: entry.exportUnit.trim() } : {}),
              ...(entry.period !== undefined ? { period: entry.period } : {}),
              ...(entry.released !== undefined ? { released: entry.released } : {}),
              ...(entry.asOf !== undefined ? { asOf: entry.asOf } : {}),
            };
            return Object.keys(identity).length > 0 ? identity : undefined;
          };
          const rowIdentities = section.entries.some((entry) => own(entry)) ? section.entries.map(own) : undefined;
          return { ...entries, ...(Object.keys(named).length > 0 ? { identity: named } : {}), ...(rowIdentities ? { rowIdentities } : {}) };
        }
        const table = exportRowsTable(section.title, displayedColumns(columnsFor(section.rows, section.columns, definition.columns)), section.rows,
          { status: true, appendedColumns: section.appendedColumns });
        const identity = {
          ...named,
          ...(section.unit?.trim() ? { currencyOrUnit: section.unit.trim() } : {}),
          ...(section.interval?.trim() ? { interval: section.interval.trim() } : {}),
        };
        const rowIdentities = rowIdentitiesOf(section.rows, section);
        return { ...table, ...(section.appendedColumns ? { appendedColumns: section.appendedColumns } : {}),
          ...(Object.keys(identity).length > 0 ? { identity } : {}), ...(rowIdentities ? { rowIdentities } : {}) };
      });
      break;
    case "series": {
      const seriesResult = result as HeadlessSeriesResult;
      const days = seriesLastDays(seriesResult.series);
      tables = seriesResult.series.map((series, index) => {
        const table = seriesTable(series);
        return days[index] ? { ...table, identity: { ...table.identity, asOf: days[index] } } : table;
      });
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
    ...(definition.exportDated ? { dated: true } : {}),
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
  // Named by its venue's code (SIE:XETRA) as its series table names it, so a derived series' rows (Volume) say the same.
  const charted = [...new Set(series.flatMap((entry) => entry.symbol?.trim() ? [displayTickerKey(entry.symbol.trim())] : []))];
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
  showSeriesPoints = false,
): string {
  // A long title wraps to a narrow --width like the text under a table; each line stays bold.
  const lines = [...wrapToTerminal(reportTitle(definition, args, result, fallbackTitle)).split("\n").map(cliStyles.bold), ""];
  // A notice wraps to a narrow --width, as the notes and errors under the tables do.
  const notices = textNotices(result, true).map((notice) => wrapToTerminal(notice));
  if (notices.length) lines.push(...notices, "");
  const gate = reportGate(definition, result);
  const reason = emptyReportReason(definition, result, args, token, gate);
  // Said once, not under the heading of each empty table.
  if (reason) lines.push(reason);
  else switch (definition.shape) {
    case "rows": {
      const rowsResult = result as HeadlessRowsResult;
      lines.push(renderRows(rowsResult.textRows ?? rowsResult.rows, rowsResult.textColumns ?? rowsResult.columns, definition.columns, rowsResult.empty));
      if (rowsResult.textSections?.length) lines.push("", ...renderBundle(definition, rowsResult.textSections));
      break;
    }
    case "bundle":
      lines.push(...renderBundle(definition, (result as HeadlessBundleResult).sections));
      break;
    case "series":
      lines.push(...renderSeries(result as HeadlessSeriesResult, showSeriesPoints));
      break;
    case "snapshot": {
      const snapshot = result as HeadlessSnapshotResult;
      // The closing source line carries the snapshot's as-of, so it is not printed twice.
      lines.push(renderRows(snapshot.items, undefined, definition.columns, snapshot.empty));
      break;
    }
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
  const notes = printedNotes(result);
  if (notes?.length) lines.push("", ...renderMessages("Notes", notes));
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
      // An N/M is a reading: the report has something to say for the series.
      return (result as HeadlessSeriesResult).series.reduce((count, series) => count + Math.max(observationCount(series), series.notMeaningful ? 1 : 0), 0);
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

/**
 * The freshness of a report that served nothing because the data service
 * could not be reached (offline, a hung connection) and no saved copy
 * answered: its line names no retrieval time, as nothing was retrieved.
 */
function withUnreached(
  freshness: ReportFreshness,
  result: HeadlessPaneResult,
  { rowCount, unavailableSymbols, symbols }: { rowCount: number; unavailableSymbols: readonly string[]; symbols: readonly string[] },
): ReportFreshness {
  if (freshness.savedAt || freshness.asOf) return freshness;
  const nothingServed = rowCount === 0 || (symbols.length > 0 && symbols.every((symbol) => unavailableSymbols.includes(symbol)));
  const unreached = (result.errors ?? []).some((error) => error.includes(DATA_SERVICE_UNREACHABLE_MESSAGE));
  return nothingServed && unreached ? { ...freshness, unreached: true } : freshness;
}

/**
 * The report's rows as `--limit` and `--tail` keep them, for a function with no option of its own for them
 * (`fn CTM CL --limit 3`): the first or last n of each table, of a series' points the oldest or newest n, as every
 * command that prints a list keeps them; the notes say what was cut.
 */
function windowHeadlessResult(definition: HeadlessPaneDefinition, result: HeadlessPaneResult, window: RowWindowOptions): HeadlessPaneResult {
  const notes: string[] = [];
  const rowDate = (columns: readonly HeadlessPaneColumn[] | undefined) => columns?.some(({ key, header }) => key === "date" && /^(?:date|session)$/i.test(header))
    ? (row: HeadlessPaneRow) => row.date : undefined;
  const cut = <Row,>(rows: readonly Row[], table?: string, dateOf?: (row: Row) => unknown): Row[] => {
    const kept = windowRows(rows, window, dateOf);
    const note = rowWindowCutNote(window, { ...kept, shown: kept.rows.length }, { table });
    if (note) notes.push(note);
    return kept.rows;
  };
  const quiet = (rows: HeadlessPaneRow[], dateOf?: (row: HeadlessPaneRow) => unknown) => windowRows(rows, window, dateOf).rows;
  let windowed: HeadlessPaneResult;
  switch (definition.shape) {
    case "rows": {
      const rows = result as HeadlessRowsResult;
      const dateOf = rowDate(rows.columns ?? definition.columns);
      windowed = { ...rows, rows: cut(rows.rows, undefined, dateOf), ...(rows.textRowsUseRecordsWhenWindowed
        ? { textColumns: undefined, textRows: undefined, textSections: undefined }
        : rows.textRows ? { textRows: quiet(rows.textRows, dateOf) } : {}) };
      break;
    }
    case "bundle": {
      const bundle = result as HeadlessBundleResult;
      const several = bundle.sections.filter((section) => section.rows).length > 1;
      windowed = { ...bundle, sections: bundle.sections.map((section) => {
        if (!section.rows) return section;
        const dateOf = rowDate(section.columns ?? definition.columns);
        return { ...section, textPreview: undefined, rows: cut(section.rows, several ? section.title : undefined, dateOf),
          ...(section.textRows ? { textRows: quiet(section.textRows, dateOf) } : {}) };
      }) };
      break;
    }
    case "series": {
      const series = result as HeadlessSeriesResult;
      windowed = { ...series, series: series.series.map((entry) => ({
        ...entry, points: cut(entry.points, series.series.length > 1 ? entry.label : undefined, (point) => point.date),
      })) };
      break;
    }
    case "snapshot": {
      const snapshot = result as HeadlessSnapshotResult;
      windowed = { ...snapshot, items: cut(snapshot.items) };
      break;
    }
    default: {
      const _exhaustive: never = definition.shape;
      return _exhaustive;
    }
  }
  return notes.length > 0 ? { ...windowed, notes: [...windowed.notes ?? [], ...notes] } : windowed;
}

export async function buildHeadlessFunctionReport(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArgument: string,
): Promise<PaneFunctionReport> {
  let loaded: LoadedHeadlessPaneModel;
  try {
    loaded = await loadResolvedHeadlessPaneModel(resolved, context, rawArgument);
    if (resolved.rowWindow) loaded = { ...loaded, result: windowHeadlessResult(loaded.definition, loaded.result, resolved.rowWindow) };
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
  // What the report shows from a saved copy, its refresh having failed, says so; one that could not
  // reach the data service for anything names no time it was retrieved.
  const freshness = withUnreached(
    withSavedCopy(deriveHeadlessFreshness(loaded.definition, loaded.result), loaded.result),
    loaded.result,
    { rowCount, unavailableSymbols, symbols },
  );
  return {
    data: {
      kind: loaded.definition.shape,
      target: resolved.token,
      capabilityId: resolved.capability.id,
      symbols,
      options: { ...resolved.options, ...loaded.result.appliedOptions },
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
      resolved.rowWindow != null,
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
