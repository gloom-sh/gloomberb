import { dirname, resolve } from "path";
import { mkdir } from "fs/promises";
import type { PaneRuntimeState } from "../../core/state/app/state";
import { CHART_COMPOSER_PANE_ID } from "../../types/config";
import type { OptionsChain, PricePoint, TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { slugifyName } from "../../utils/slugify";
import {
  renderDesktopPaneScreenshot,
  type DesktopPaneShotPayload,
  type DesktopPaneShotRenderResult,
} from "../desktop-pane-shot";
import { optionPaneState } from "./options";
import type { ResolvedPaneFunction } from "./resolver";
import type { MarketContext } from "../types";
import { capabilityPluginState } from "./capabilities";
import type { RemoteUiNodeSnapshot } from "../../remote/types";
import {
  graphRowsForFinancials,
  limitGraphRowsBySymbol,
  metricDef,
} from "../../time-series/reporting";
import { getTimeSeriesField } from "../../time-series/field-catalog";
import {
  buildFinancialTableModel,
  formatFinancialHeader,
} from "../../plugins/builtin/ticker-detail/financials/model";
import type {
  FundamentalPeriod,
  GraphKind,
  GraphMetricKey,
} from "../../time-series/reporting";
import type { TimeRange } from "../../time-series/range";
import { appendLiveQuotePoint } from "../../time-series/chart-data";
import { applyResolvedSeriesTransform } from "../../time-series/transforms";
import { subtractTimeRange } from "../../time-series/date-window";
import {
  buildPresetDateWindow,
  getVisibleWindowForDateRange,
} from "../../components/chart/core/date-window";
import { parseChartSpec } from "../../plugins/builtin/chart-composer/chart-spec";
import {
  defaultValuationSeriesLoader,
  requiredSeries as valuationRequiredSeries,
} from "../../plugins/builtin/market-valuation/client";
import type { DatedObservation } from "../../plugins/builtin/market-valuation/series";
import { defaultStatLoader } from "../../plugins/builtin/econ-statistics/client";
import { STATS } from "../../plugins/builtin/econ-statistics/stats";
import { publicTickerKey } from "../../utils/exchanges";
import { apiClient } from "../../api-client";
import type { FredSeriesCacheEntry } from "../../data/fred-series";
import type { ResolvedSeries } from "../../time-series/types";
import { chartSeriesSourceKey, createChartSeriesResolver } from "../../capabilities";
import { getSharedRegistry } from "../../plugins/registry";
import {
  collectShotSymbols,
  clipPriceHistoryToRange,
  createFallbackTicker,
  fetchTickerFinancials,
  isFinancialAnalysisFunction,
  withShotPriceHistory,
} from "./data";

const DESKTOP_CELL_WIDTH_PX = 8;
const DESKTOP_CELL_HEIGHT_PX = 18;
const OPTIONS_PANE_ID = "options";
const MARKET_VALUATION_PANE_ID = "market-valuation";
const ECON_STATISTICS_PANE_ID = "econ-statistics";

/** Same reason as the valuation legs: the renderer cannot fill its own cache. */
async function collectShotStatSeries(
  resolved: ResolvedPaneFunction,
): Promise<Array<[string, DatedObservation[]]>> {
  if (resolved.pane.id !== ECON_STATISTICS_PANE_ID) return [];
  const loaded = await Promise.all(STATS.map(async (def) => {
    try {
      return [def.seriesId, await defaultStatLoader(def)] as [string, DatedObservation[]];
    } catch {
      return null;
    }
  }));
  return loaded.filter((entry): entry is [string, DatedObservation[]] => !!entry);
}

async function collectShotFredSeries(
  resolved: ResolvedPaneFunction,
): Promise<Array<[string, FredSeriesCacheEntry]>> {
  if (resolved.pane.id !== CHART_COMPOSER_PANE_ID) return [];
  const spec = parseChartSpec(resolved.instance.settings?.chartSpec);
  if (!spec) return [];
  const seriesIds = [...new Set(spec.series.flatMap((series) => (
    series.source.kind === "economic" ? [series.source.seriesId.trim().toUpperCase()] : []
  )))];
  const loaded = await Promise.all(seriesIds.map(async (seriesId) => {
    try {
      const data = await apiClient.getCloudFredSeries(seriesId, {
        startDate: "1900-01-01",
        sortOrder: "asc",
      });
      return [seriesId, { data, fetchedAt: Date.now(), stale: false }] as [string, FredSeriesCacheEntry];
    } catch {
      return null;
    }
  }));
  return loaded.filter((entry): entry is [string, FredSeriesCacheEntry] => !!entry);
}

/**
 * The pane reads its legs from a client cache the shot renderer cannot fill itself,
 * so fetch them here on the Bun side and hand them over with the payload.
 */
async function collectShotValuationSeries(
  resolved: ResolvedPaneFunction,
): Promise<Array<[string, DatedObservation[]]>> {
  if (resolved.pane.id !== MARKET_VALUATION_PANE_ID) return [];
  const loaded = await Promise.all(valuationRequiredSeries().map(async (def) => {
    try {
      const series = await defaultValuationSeriesLoader(def);
      return [def.key, series.observations] as [string, DatedObservation[]];
    } catch {
      return null;
    }
  }));
  return loaded.filter((entry): entry is [string, DatedObservation[]] => !!entry);
}

async function collectShotCapabilitySeries(
  resolved: ResolvedPaneFunction,
): Promise<Array<[string, ResolvedSeries]>> {
  if (resolved.pane.id !== CHART_COMPOSER_PANE_ID) return [];
  const spec = parseChartSpec(resolved.instance.settings?.chartSpec);
  const invoker = getSharedRegistry();
  if (!spec || !invoker) return [];
  const resolveSeries = createChartSeriesResolver(invoker);
  return (await Promise.all(spec.series.flatMap((series) => {
    if (series.source.kind !== "capability") return [];
    const source = series.source;
    return [resolveSeries(source, spec.viewport, series)
      .then((value) => [chartSeriesSourceKey(source), value] as [string, ResolvedSeries])
      .catch(() => null)];
  }))).filter((entry): entry is [string, ResolvedSeries] => entry !== null);
}

export interface PaneScreenshotExpectedSelection {
  control: "metric" | "statement" | "period";
  value?: string;
  label?: string;
}

export interface PaneScreenshotChartPointEvidence {
  date: string;
  close: number;
}

export interface PaneScreenshotChartSeriesEvidence {
  symbol: string;
  pointCount: number;
  first: PaneScreenshotChartPointEvidence | null;
  last: PaneScreenshotChartPointEvidence | null;
  projectionBaseValue?: number | null;
  projectionLatestRawValue?: number | null;
  projectionLatestValue?: number | null;
}

export interface PaneScreenshotExpectedChartEvidence {
  kind: "stock-price" | "price-comparison" | "chart-composer";
  symbols: string[];
  rangePreset: string;
  axisMode?: string;
  resolution?: string;
  sourceSeries?: PaneScreenshotChartSeriesEvidence[];
  baseSeries?: Array<{
    id: string;
    sourceKind: "security" | "economic" | "capability";
    symbol?: string;
    fieldId?: string;
    economicSeriesId?: string;
    capabilityId?: string;
    providerSeriesId?: string;
    first?: { date: string; value: number | null } | null;
    last?: { date: string; value: number | null } | null;
    style: string;
    transform: string;
    panelId: string;
    visible: boolean;
  }>;
}

export interface PaneScreenshotPriceComparisonEvidence {
  kind: "price-comparison";
  symbols: string[];
  range: string;
  series: Array<{
    symbol: string;
    base: { date: string; value: number };
    latest: { date: string; value: number };
    returnPercent: number;
  }>;
}

export interface PaneScreenshotPriceSeriesEvidence {
  kind: "price-series";
  symbol: string;
  range: string;
  pointCount: number;
  first: PaneScreenshotChartPointEvidence;
  last: PaneScreenshotChartPointEvidence;
}

export interface PaneScreenshotFundamentalSeriesEvidence {
  kind: "fundamental-series";
  metric: string;
  period: FundamentalPeriod;
  series: Array<{
    symbol: string;
    rows: Array<{ date: string; value: number }>;
  }>;
}

export interface PaneScreenshotFinancialStatementEvidence {
  kind: "financial-statement";
  symbol: string;
  statement: string;
  period: FundamentalPeriod;
  latest: {
    date: string;
    metrics: Array<{
      id: string;
      key: string;
      label: string;
      value: number;
    }>;
  };
}

export type PaneScreenshotDataEvidence =
  | PaneScreenshotPriceSeriesEvidence
  | PaneScreenshotPriceComparisonEvidence
  | PaneScreenshotFundamentalSeriesEvidence
  | PaneScreenshotFinancialStatementEvidence;

export interface PaneScreenshotResult {
  kind: "pane-screenshot";
  target: string;
  capability: {
    id: string;
    botSafe: boolean;
    outputKind: string;
    reportReadiness: ResolvedPaneFunction["capability"]["reportReadiness"];
    screenshotReadiness: ResolvedPaneFunction["capability"]["screenshotReadiness"];
  };
  symbols: string[];
  options: Record<string, string | number | boolean>;
  rowCount: number;
  empty: boolean;
  complete: boolean;
  unavailableSymbols: string[];
  semanticMismatch: boolean;
  usable: boolean;
  dataEvidence: PaneScreenshotDataEvidence | null;
  outputPath: string;
  render: DesktopPaneShotRenderResult & {
    expectedText: string[];
    missingExpectedText: string[];
    expectedSelections: PaneScreenshotExpectedSelection[];
    missingExpectedSelections: PaneScreenshotExpectedSelection[];
    expectedChart: PaneScreenshotExpectedChartEvidence | null;
    chartEvidenceMismatches: string[];
  };
}

export function defaultScreenshotPath(resolved: ResolvedPaneFunction, rawArg: string): string {
  const suffix = slugifyName([resolved.token, rawArg].filter(Boolean).join("-"), "pane");
  return resolve(process.cwd(), `gloomberb-${suffix}.png`);
}

async function buildDesktopShotPayload(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
  options: Record<string, string | true>,
  widthPx: number,
  heightPx: number,
): Promise<DesktopPaneShotPayload> {
  const widthCells = Math.max(1, Math.round(widthPx / DESKTOP_CELL_WIDTH_PX));
  const heightCells = Math.max(1, Math.round(heightPx / DESKTOP_CELL_HEIGHT_PX));
  const initialPaneState = optionPaneState(resolved.options);
  const pluginState = capabilityPluginState(resolved.capability, resolved.options);
  if (Object.keys(pluginState).length > 0) {
    initialPaneState.pluginState = {
      ...(initialPaneState.pluginState ?? {}),
      ...pluginState,
    };
  }
  if (isFinancialAnalysisFunction(resolved) && !initialPaneState.activeTabId) {
    initialPaneState.activeTabId = "financials";
  }
  const paneState: Record<string, PaneRuntimeState> = {
    [resolved.instance.instanceId]: initialPaneState,
  };
  const layout = {
    dockRoot: null,
    instances: [resolved.instance],
    floating: [{
      instanceId: resolved.instance.instanceId,
      x: 0,
      y: 0,
      width: widthCells,
      height: heightCells,
      zIndex: 1,
    }],
    detached: [],
  };
  const config = {
    ...context.config,
    layout,
    layouts: [{
      name: "CLI Shot",
      layout,
      paneState,
      focusedPaneId: resolved.instance.instanceId,
      activePanel: "right" as const,
    }],
    activeLayoutIndex: 0,
    onboardingComplete: true,
  };

  const tickers: TickerRecord[] = [];
  const financials: Array<[string, TickerFinancials]> = [];
  const optionsChains: Array<[string, OptionsChain]> = [];
  const [fredSeries, capabilitySeries, valuationSeries, statSeries] = await Promise.all([
    collectShotFredSeries(resolved),
    collectShotCapabilitySeries(resolved),
    collectShotValuationSeries(resolved),
    collectShotStatSeries(resolved),
  ]);
  const includeOptionsChains = resolved.pane.id === OPTIONS_PANE_ID || resolved.template?.paneId === OPTIONS_PANE_ID;
  for (const symbol of collectShotSymbols(resolved, rawArg)) {
    const entry = await fetchTickerFinancials(context, symbol);
    const requestedRange = shotPriceHistoryRange(resolved);
    let data = entry.financials;
    if (requestedRange) {
      const exchange = entry.instrument.exchange
        ?? entry.tickerFile?.metadata.exchange
        ?? data.quote?.listingExchangeName
        ?? data.quote?.exchangeName
        ?? "";
      try {
        const priceHistory = await context.dataProvider.getPriceHistory(entry.instrument.symbol, exchange, requestedRange);
        data = { ...data, priceHistory: clipPriceHistoryToRange(priceHistory, requestedRange) };
      } catch {
        data = await withShotPriceHistory(context, symbol, entry.tickerFile, data);
      }
    }
    tickers.push(entry.tickerFile ?? createFallbackTicker(symbol, data, context));
    financials.push([symbol, data]);
    if (includeOptionsChains && context.dataProvider.getOptionsChain) {
      const exchange = entry.instrument.exchange
        ?? entry.tickerFile?.metadata.exchange
        ?? data.quote?.listingExchangeName
        ?? data.quote?.exchangeName
        ?? "";
      const chain = await context.dataProvider.getOptionsChain(entry.instrument.symbol, exchange);
      optionsChains.push([symbol, chain]);
    }
  }

  return {
    config,
    paneId: resolved.instance.instanceId,
    widthCells,
    heightCells,
    widthPx,
    heightPx,
    tickers,
    financials,
    optionsChains,
    fredSeries,
    valuationSeries,
    statSeries,
    capabilitySeries,
    paneState,
  };
}

export function shotPriceHistoryRange(resolved: ResolvedPaneFunction): TimeRange | null {
  switch (resolved.capability.id) {
    case "chart-composer":
      return parseChartSpec(resolved.instance.settings?.chartSpec)?.viewport.range ?? null;
    case "valuation-series":
      return "ALL";
    case "price-chart":
      return (resolved.options.rangePreset ?? "5Y") as TimeRange;
    case "price-comparison":
    case "return-correlation":
      return (resolved.options.rangePreset ?? "1Y") as TimeRange;
    case "intraday-price-chart":
      return "1D";
    case "historical-prices":
    case "security-relationship":
      return (resolved.options.range ?? "1Y") as TimeRange;
    default:
      return null;
  }
}

export async function renderDesktopShot({
  resolved,
  context,
  rawArg,
  outputPath,
  width,
  height,
  options,
}: {
  resolved: ResolvedPaneFunction;
  context: MarketContext;
  rawArg: string;
  outputPath: string;
  width: number;
  height: number;
  options: Record<string, string | true>;
}): Promise<PaneScreenshotResult> {
  await mkdir(dirname(outputPath), { recursive: true });
  const payload = await buildDesktopShotPayload(resolved, context, rawArg, options, width, height);
  const render = await renderDesktopPaneScreenshot(payload, outputPath);
  const symbols = payload.financials.map(([symbol]) => symbol);
  const rowCount = shotSemanticRowCount(resolved, payload, render.semanticUi);
  const unavailableSymbols = shotUnavailableSymbols(resolved, payload, render.semanticUi);
  const complete = unavailableSymbols.length === 0;
  const expectedText = shotExpectedText(resolved, symbols, payload);
  const normalizedVisibleText = render.visibleText.toLowerCase();
  const missingExpectedText = expectedText.filter((value) => !normalizedVisibleText.includes(value.toLowerCase()));
  const expectedSelections = shotExpectedSelections(resolved);
  const missingExpectedSelections = missingActiveTabSelections(
    render.semanticUi,
    expectedSelections,
  );
  const expectedChart = shotExpectedChart(resolved, payload);
  const dataEvidence = shotDataEvidenceFor(resolved, payload);
  const chartEvidenceMismatches = expectedChart
    ? chartEvidenceMismatchesFor(render.semanticUi, expectedChart)
    : [];
  const semanticMismatch = missingExpectedText.length > 0
    || missingExpectedSelections.length > 0
    || chartEvidenceMismatches.length > 0;
  const empty = render.emptyStateDetected || rowCount === 0 || semanticMismatch;
  const usable = resolved.capability.botSafe
    && resolved.capability.screenshotReadiness === "ready"
    && !empty
    && complete
    && (!requiresStructuredDataEvidence(resolved) || dataEvidence !== null);
  return {
    kind: "pane-screenshot",
    target: resolved.token,
    capability: {
      id: resolved.capability.id,
      botSafe: resolved.capability.botSafe,
      outputKind: resolved.capability.outputKind,
      reportReadiness: resolved.capability.reportReadiness,
      screenshotReadiness: resolved.capability.screenshotReadiness,
    },
    symbols,
    options: resolved.options,
    rowCount,
    empty,
    complete,
    unavailableSymbols,
    semanticMismatch,
    usable,
    dataEvidence,
    outputPath,
    render: {
      ...render,
      expectedText,
      missingExpectedText,
      expectedSelections,
      missingExpectedSelections,
      expectedChart,
      chartEvidenceMismatches,
    },
  };
}

function requiresStructuredDataEvidence(resolved: ResolvedPaneFunction): boolean {
  return ["price-chart", "price-comparison", "fundamental-series", "financial-statements"]
    .includes(resolved.capability.id);
}

const STATEMENT_EVIDENCE_KEYS: Record<string, ReadonlySet<string>> = {
  income: new Set([
    "totalRevenue",
    "grossProfit",
    "operatingIncome",
    "netIncome",
    "netIncomeCommonStockholders",
    "eps",
    "basicEps",
  ]),
  cashflow: new Set([
    "operatingCashFlow",
    "capitalExpenditure",
    "freeCashFlow",
  ]),
  balance: new Set([
    "totalAssets",
    "totalLiabilities",
    "cashAndCashEquivalents",
    "totalDebt",
    "totalEquity",
    "commonStockEquity",
  ]),
};

export function shotDataEvidenceFor(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
): PaneScreenshotDataEvidence | null {
  if (resolved.capability.id === "price-chart") {
    const range = String(resolved.options.rangePreset ?? "5Y") as TimeRange;
    const [symbol, financials] = payload.financials[0] ?? [];
    if (!symbol || !financials) return null;
    const { evidence } = normalizeChartSeries(symbol, financials, range);
    if (!evidence.first || !evidence.last || evidence.pointCount <= 0) return null;
    return {
      kind: "price-series",
      symbol,
      range,
      pointCount: evidence.pointCount,
      first: evidence.first,
      last: evidence.last,
    };
  }

  if (resolved.capability.id === "price-comparison") {
    const range = String(resolved.options.rangePreset ?? "1Y") as TimeRange;
    const normalizedSeries = payload.financials.map(([symbol, financials]) => ({
      symbol,
      points: normalizeChartSeries(symbol, financials, range).points,
    }));
    const latestTimestamp = Math.max(
      ...normalizedSeries.flatMap(({ points }) => points.map(({ date }) => date.getTime())),
    );
    if (!Number.isFinite(latestTimestamp)) return null;
    const projectionStart = subtractTimeRange(new Date(latestTimestamp), range).getTime();
    const series = normalizedSeries.flatMap(({ symbol, points }) => {
      const projectionPoints = points.filter(({ date }) => date.getTime() >= projectionStart);
      const base = projectionPoints[0];
      const latest = projectionPoints.at(-1);
      if (!base || !latest || !Number.isFinite(base.close) || !Number.isFinite(latest.close) || base.close === 0) {
        return [];
      }
      return [{
        symbol,
        base: { date: base.date.toISOString(), value: base.close },
        latest: { date: latest.date.toISOString(), value: latest.close },
        returnPercent: ((latest.close - base.close) / base.close) * 100,
      }];
    });
    if (series.length !== normalizedSeries.length) return null;
    return {
      kind: "price-comparison",
      symbols: series.map(({ symbol }) => symbol),
      range,
      series,
    };
  }

  if (resolved.capability.id === "fundamental-series") {
    const metric = resolved.options.metric as GraphMetricKey;
    const period = resolved.options.period as FundamentalPeriod;
    const periodCount = resolved.options.periods == null ? null : Number(resolved.options.periods);
    const evidencePeriodCount = Math.min(
      periodCount ?? (period === "annual" ? 6 : 8),
      period === "annual" ? 6 : 8,
    );
    const series = payload.financials.map(([symbol, financials]) => ({
      symbol,
      rows: limitGraphRowsBySymbol(
        graphRowsForFinancials(financials, "fundamental", metric, period, symbol),
        evidencePeriodCount,
      )
        .sort((left, right) => left.date.localeCompare(right.date))
        .map(({ date, value }) => ({ date, value })),
    }));
    if (series.some(({ rows }) => rows.length === 0)) return null;
    return { kind: "fundamental-series", metric, period, series };
  }

  if (resolved.capability.id === "financial-statements") {
    const [symbol, financials] = payload.financials[0] ?? [];
    if (!symbol || !financials) return null;
    const table = buildFinancialTableModel(financials, {
      period: resolved.options.period as FundamentalPeriod,
      statement: String(resolved.options.statement),
    });
    if (!table || table.statements.length === 0) return null;
    const allowedKeys = STATEMENT_EVIDENCE_KEYS[table.subTab.key] ?? new Set<string>();
    const latestPopulated = table.statements.flatMap((statement, statementIndex) => {
      const seenKeys = new Set<string>();
      const metrics = table.rows.flatMap((row) => {
        const key = String(row.key ?? row.summaryKey ?? "");
        const value = row.cells[statementIndex]?.value;
        if (!allowedKeys.has(key) || seenKeys.has(key) || typeof value !== "number" || !Number.isFinite(value)) {
          return [];
        }
        seenKeys.add(key);
        return [{
          id: row.id,
          key,
          label: row.unitLabel,
          value,
        }];
      });
      return metrics.length > 0 ? [{ statement, metrics }] : [];
    })[0];
    if (!latestPopulated) return null;
    return {
      kind: "financial-statement",
      symbol,
      statement: table.subTab.key,
      period: table.period,
      latest: {
        date: latestPopulated.statement.date,
        metrics: latestPopulated.metrics,
      },
    };
  }

  return null;
}

function normalizeChartSeries(
  symbol: string,
  financials: TickerFinancials,
  range: TimeRange,
): {
  evidence: PaneScreenshotChartSeriesEvidence;
  points: Array<{ date: Date; close: number }>;
} {
  const sorted = clipPriceHistoryToRange(financials.priceHistory, range)
    .flatMap((point) => {
      const date = new Date(point.date);
      return Number.isFinite(date.getTime()) ? [{ ...point, date }] : [];
    })
    .sort((left, right) => left.date.getTime() - right.date.getTime());
  const points = appendLiveQuotePoint(sorted, financials.quote)
    .slice()
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
  return {
    points,
    evidence: chartSeriesEvidence(symbol, points),
  };
}

function chartSeriesEvidence(
  symbol: string,
  points: PricePoint[],
): PaneScreenshotChartSeriesEvidence {
  const pointEvidence = (
    point: typeof points[number] | undefined,
  ): PaneScreenshotChartPointEvidence | null => (
    point && Number.isFinite(point.date.getTime())
      ? { date: point.date.toISOString(), close: point.close }
      : null
  );
  return {
    symbol,
    pointCount: points.length,
    first: pointEvidence(points[0]),
    last: pointEvidence(points.at(-1)),
  };
}

export function chartSeriesEvidenceWithinRange(
  symbol: string,
  points: PricePoint[],
  range: TimeRange,
): PaneScreenshotChartSeriesEvidence {
  const dateWindow = buildPresetDateWindow(points.map(({ date }) => date), range);
  const visiblePoints = getVisibleWindowForDateRange(points, dateWindow, 0).points;
  return chartSeriesEvidence(symbol, visiblePoints);
}

function shotExpectedChart(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
): PaneScreenshotExpectedChartEvidence | null {
  if (resolved.pane.id === CHART_COMPOSER_PANE_ID) {
    const spec = parseChartSpec(resolved.instance.settings?.chartSpec);
    if (!spec) return null;
    const capabilitySeries = new Map(payload.capabilitySeries);
    const capabilityPoint = (point: ResolvedSeries["points"][number] | undefined) => point
      ? {
          date: point.date.toISOString(),
          value: typeof (point.value ?? point.close) === "number" ? point.value ?? point.close ?? null : null,
        }
      : null;
    return {
      kind: "chart-composer",
      symbols: [...new Set(spec.series.flatMap((series) => (
        series.source.kind === "security"
          ? [publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange)]
          : []
      )))],
      rangePreset: spec.viewport.range,
      resolution: spec.viewport.resolution,
      baseSeries: spec.series.map((series) => ({
        id: series.id,
        sourceKind: series.source.kind,
        ...(series.source.kind === "security"
          ? {
            symbol: publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange),
            fieldId: series.source.fieldId,
          }
          : series.source.kind === "economic"
            ? { economicSeriesId: series.source.seriesId }
            : (() => {
                const loaded = capabilitySeries.get(chartSeriesSourceKey(series.source));
                const resolvedSeries = loaded ? applyResolvedSeriesTransform(loaded, series.transform) : undefined;
                return {
                  capabilityId: series.source.capabilityId,
                  providerSeriesId: series.source.seriesId,
                  first: capabilityPoint(resolvedSeries?.points[0]),
                  last: capabilityPoint(resolvedSeries?.points.at(-1)),
                };
              })()),
        style: series.style,
        transform: series.transform,
        panelId: series.panelId,
        visible: series.visible !== false,
      })),
    };
  }
  if (resolved.capability.id === "price-chart") {
    const range = String(resolved.options.rangePreset ?? "5Y") as TimeRange;
    const sourceSeries = payload.financials.slice(0, 1).map(([symbol, financials]) => {
      const { points } = normalizeChartSeries(symbol, financials, range);
      return chartSeriesEvidenceWithinRange(symbol, points, range);
    });
    return {
      kind: "stock-price",
      symbols: sourceSeries.map(({ symbol }) => symbol),
      rangePreset: range,
      axisMode: "price",
      sourceSeries,
    };
  }
  if (resolved.capability.id === "price-comparison") {
    const range = String(resolved.options.rangePreset ?? "1Y") as TimeRange;
    const normalizedSeries = payload.financials.map(([symbol, financials]) => (
      normalizeChartSeries(symbol, financials, range)
    ));
    const latestTimestamp = Math.max(
      ...normalizedSeries.flatMap(({ points }) => points.map(({ date }) => date.getTime())),
    );
    const projectionStart = Number.isFinite(latestTimestamp)
      ? subtractTimeRange(new Date(latestTimestamp), range).getTime()
      : Number.NaN;
    const axisMode = String(resolved.options.axisMode ?? "percent");
    const sourceSeries = normalizedSeries.map(({ evidence, points }) => {
      const projectionPoints = points.filter(({ date }) => date.getTime() >= projectionStart);
      const baseValue = projectionPoints[0]?.close ?? null;
      const latestRawValue = projectionPoints.at(-1)?.close ?? null;
      const latestValue = baseValue == null || latestRawValue == null
        ? null
        : axisMode === "percent"
          ? ((latestRawValue - baseValue) / baseValue) * 100
          : latestRawValue;
      return {
        ...evidence,
        projectionBaseValue: baseValue,
        projectionLatestRawValue: latestRawValue,
        projectionLatestValue: latestValue,
      };
    });
    return {
      kind: "price-comparison",
      symbols: sourceSeries.map(({ symbol }) => symbol),
      rangePreset: range,
      axisMode,
      resolution: String(resolved.options.chartResolution ?? "1d"),
      sourceSeries,
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function closeEnough(actual: unknown, expected: number): boolean {
  return typeof actual === "number"
    && Number.isFinite(actual)
    && Math.abs(actual - expected) <= Math.max(1e-8, Math.abs(expected) * 1e-8);
}

function pointEvidenceMatches(
  actual: unknown,
  expected: PaneScreenshotChartPointEvidence | null,
): boolean {
  if (expected === null) return actual === null;
  return isRecord(actual)
    && actual.date === expected.date
    && closeEnough(actual.close, expected.close);
}

function sourceSeriesMismatches(
  actual: unknown,
  expected: PaneScreenshotChartSeriesEvidence[],
): string[] {
  if (!Array.isArray(actual)) return ["chart source-series evidence is missing"];
  if (actual.length !== expected.length) return ["chart source-series count does not match"];
  const mismatches: string[] = [];
  expected.forEach((expectedSeries, index) => {
    const actualSeries = actual[index];
    if (!isRecord(actualSeries) || actualSeries.symbol !== expectedSeries.symbol) {
      mismatches.push(`chart source symbol ${index + 1} does not match`);
      return;
    }
    if (actualSeries.pointCount !== expectedSeries.pointCount) {
      mismatches.push(`${expectedSeries.symbol} chart source point count does not match`);
    }
    if (!pointEvidenceMatches(actualSeries.first, expectedSeries.first)) {
      mismatches.push(`${expectedSeries.symbol} chart source first value does not match`);
    }
    if (!pointEvidenceMatches(actualSeries.last, expectedSeries.last)) {
      mismatches.push(`${expectedSeries.symbol} chart source last value does not match`);
    }
  });
  return mismatches;
}

export function chartEvidenceMismatchesFor(
  semanticUi: RemoteUiNodeSnapshot[],
  expected: PaneScreenshotExpectedChartEvidence,
): string[] {
  const node = semanticUi.find((candidate) => (
    candidate.role === "chart-data"
    && candidate.metadata?.kind === expected.kind
  ));
  const metadata = node?.metadata;
  if (!metadata) return ["rendered chart-data semantic evidence is missing"];

  const mismatches: string[] = [];
  const symbols = readStringArray(metadata.symbols);
  if (!symbols || symbols.join("\0") !== expected.symbols.join("\0")) {
    mismatches.push("rendered chart symbols do not match");
  }
  if (metadata.rangePreset !== expected.rangePreset) {
    mismatches.push("rendered chart range does not match");
  }

  if (expected.kind === "chart-composer") {
    if (expected.resolution != null && metadata.resolution !== expected.resolution) {
      mismatches.push("rendered chart resolution does not match");
    }
    const actualSeries = Array.isArray(metadata.baseSeries) ? metadata.baseSeries : [];
    const expectedSeries = expected.baseSeries ?? [];
    if (actualSeries.length !== expectedSeries.length) {
      mismatches.push("rendered chart base-series count does not match");
    } else {
      expectedSeries.forEach((series, index) => {
        const actual = actualSeries[index];
        if (!isRecord(actual)
          || actual.id !== series.id
          || actual.sourceKind !== series.sourceKind
          || actual.symbol !== series.symbol
          || actual.fieldId !== series.fieldId
          || actual.economicSeriesId !== series.economicSeriesId
          || actual.capabilityId !== series.capabilityId
          || actual.providerSeriesId !== series.providerSeriesId
          || (series.sourceKind === "capability" && (
            JSON.stringify(actual.first) !== JSON.stringify(series.first)
            || JSON.stringify(actual.last) !== JSON.stringify(series.last)
          ))
          || actual.style !== series.style
          || actual.transform !== series.transform
          || actual.panelId !== series.panelId
          || actual.visible !== series.visible) {
          mismatches.push(`rendered chart series ${series.id} does not match`);
          return;
        }
        if (series.visible && (typeof actual.pointCount !== "number" || actual.pointCount <= 0)) {
          mismatches.push(`rendered chart series ${series.id} is empty`);
        }
      });
    }
    if (typeof metadata.projectedPointCount !== "number" || metadata.projectedPointCount <= 0) {
      mismatches.push("rendered chart projection is empty");
    }
    return mismatches;
  }

  if (expected.kind === "stock-price") {
    if (metadata.axisMode !== expected.axisMode) {
      mismatches.push("rendered chart axis mode does not match");
    }
    const expectedSeries = expected.sourceSeries?.[0];
    if (!expectedSeries) return [...mismatches, "expected stock chart source evidence is missing"];
    mismatches.push(...sourceSeriesMismatches([{
      symbol: symbols?.[0],
      pointCount: metadata.sourcePointCount,
      first: metadata.sourceFirst,
      last: metadata.sourceLast,
    }], expected.sourceSeries ?? []));
    if (typeof metadata.projectedPointCount !== "number" || metadata.projectedPointCount <= 0) {
      mismatches.push("rendered stock chart projection is empty");
    }
    return mismatches;
  }

  if (metadata.requestedAxisMode !== expected.axisMode || metadata.effectiveAxisMode !== expected.axisMode) {
    mismatches.push("rendered comparison axis mode does not match");
  }
  if (
    expected.resolution != null
    && (
      metadata.selectedResolution !== expected.resolution
      || metadata.effectiveResolution !== expected.resolution
    )
  ) {
    mismatches.push("rendered comparison resolution does not match");
  }
  const expectedSourceSeries = expected.sourceSeries ?? [];
  mismatches.push(...sourceSeriesMismatches(metadata.sourceSeries, expectedSourceSeries));

  const projectionSeries = Array.isArray(metadata.projectionSeries)
    ? metadata.projectionSeries
    : [];
  if (projectionSeries.length !== expectedSourceSeries.length) {
    mismatches.push("rendered comparison projection-series count does not match");
  } else {
    expectedSourceSeries.forEach((expectedSeries, index) => {
      const actualSeries = projectionSeries[index];
      if (!isRecord(actualSeries) || actualSeries.symbol !== expectedSeries.symbol) {
        mismatches.push(`${expectedSeries.symbol} comparison projection is missing`);
        return;
      }
      const baseValue = expectedSeries.projectionBaseValue;
      const latestRawValue = expectedSeries.projectionLatestRawValue;
      if (baseValue == null || latestRawValue == null) {
        mismatches.push(`${expectedSeries.symbol} expected comparison values are empty`);
        return;
      }
      const latestValue = expectedSeries.projectionLatestValue;
      if (!closeEnough(actualSeries.baseValue, baseValue)) {
        mismatches.push(`${expectedSeries.symbol} comparison base value does not match`);
      }
      if (!closeEnough(actualSeries.latestRawValue, latestRawValue)) {
        mismatches.push(`${expectedSeries.symbol} comparison latest value does not match`);
      }
      if (latestValue == null || !closeEnough(actualSeries.latestValue, latestValue)) {
        mismatches.push(`${expectedSeries.symbol} comparison transformed value does not match`);
      }
      if (actualSeries.pointCount !== metadata.projectedPointCount) {
        mismatches.push(`${expectedSeries.symbol} comparison projection point count does not match`);
      }
    });
  }
  if (typeof metadata.projectedPointCount !== "number" || metadata.projectedPointCount <= 0) {
    mismatches.push("rendered comparison projection is empty");
  }
  return mismatches;
}

export function shotUnavailableSymbols(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  semanticUi: RemoteUiNodeSnapshot[] = [],
): string[] {
  if (resolved.capability.id === "chart-composer") {
    const metadata = semanticUi.find((node) => (
      node.role === "chart-data" && node.metadata?.kind === "chart-composer"
    ))?.metadata;
    const baseSeries = Array.isArray(metadata?.baseSeries) ? metadata.baseSeries : [];
    return baseSeries.flatMap((entry) => {
      if (!isRecord(entry) || (typeof entry.pointCount === "number" && entry.pointCount > 0)) return [];
      if (entry.sourceKind === "security" && typeof entry.symbol === "string") return [entry.symbol];
      if (entry.sourceKind === "economic" && typeof entry.economicSeriesId === "string") {
        return [`FRED:${entry.economicSeriesId}`];
      }
      if (entry.sourceKind === "capability" && typeof entry.capabilityId === "string" && typeof entry.providerSeriesId === "string") {
        return [`CAP:${entry.capabilityId}:${entry.providerSeriesId}`];
      }
      return [];
    });
  }
  const graphKind = shotGraphKind(resolved);
  if (graphKind) {
    const metric = resolved.options.metric as GraphMetricKey;
    const period = resolved.options.period as FundamentalPeriod;
    const periodCount = resolved.options.periods == null ? null : Number(resolved.options.periods);
    return payload.financials.flatMap(([symbol, financials]) => (
      limitGraphRowsBySymbol(
        graphRowsForFinancials(financials, graphKind, metric, period, symbol),
        periodCount,
      ).length === 0 ? [symbol] : []
    ));
  }
  if (["price-chart", "intraday-price-chart", "historical-prices"].includes(resolved.capability.id)) {
    return payload.financials.flatMap(([symbol, financials]) => financials.priceHistory.length > 0 ? [] : [symbol]);
  }
  if (["price-comparison", "return-correlation", "security-relationship"].includes(resolved.capability.id)) {
    return payload.financials.flatMap(([symbol, financials]) => financials.priceHistory.length > 1 ? [] : [symbol]);
  }
  if (resolved.capability.id === "financial-statements") {
    return payload.financials.flatMap(([symbol, financials]) => {
      const count = resolved.options.period === "quarterly"
        ? financials.quarterlyStatements.length
        : financials.annualStatements.length;
      return count > 0 ? [] : [symbol];
    });
  }
  return payload.financials.flatMap(([symbol, financials]) => financials.quote ? [] : [symbol]);
}

function shotGraphKind(resolved: ResolvedPaneFunction): GraphKind | null {
  if (resolved.capability.id === "fundamental-series") return "fundamental";
  if (resolved.capability.id === "valuation-series") return "valuation";
  return null;
}

export function shotSemanticRowCount(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  semanticUi: RemoteUiNodeSnapshot[] = [],
): number {
  if (resolved.capability.id === "chart-composer") {
    const metadata = semanticUi.find((node) => (
      node.role === "chart-data" && node.metadata?.kind === "chart-composer"
    ))?.metadata;
    const baseSeries = Array.isArray(metadata?.baseSeries) ? metadata.baseSeries : [];
    return baseSeries.reduce((count, entry) => (
      count + (isRecord(entry) && typeof entry.pointCount === "number" ? Math.max(0, entry.pointCount) : 0)
    ), 0);
  }
  const graphKind = shotGraphKind(resolved);
  if (graphKind) {
    const metric = resolved.options.metric as GraphMetricKey;
    const period = resolved.options.period as FundamentalPeriod;
    const periodCount = resolved.options.periods == null ? null : Number(resolved.options.periods);
    return payload.financials.reduce((count, [symbol, financials]) => (
      count + limitGraphRowsBySymbol(
        graphRowsForFinancials(financials, graphKind, metric, period, symbol),
        periodCount,
      ).length
    ), 0);
  }
  if (["price-chart", "intraday-price-chart", "historical-prices"].includes(resolved.capability.id)) {
    return payload.financials[0]?.[1].priceHistory.length ?? 0;
  }
  if (["price-comparison", "return-correlation", "security-relationship"].includes(resolved.capability.id)) {
    return payload.financials.filter(([, financials]) => financials.priceHistory.length > 1).length;
  }
  if (resolved.capability.id === "financial-statements") {
    const financials = payload.financials[0]?.[1];
    const period = resolved.options.period;
    return period === "quarterly"
      ? financials?.quarterlyStatements.length ?? 0
      : financials?.annualStatements.length ?? 0;
  }
  return payload.financials.filter(([, financials]) => !!financials.quote).length;
}

export function shotExpectedText(
  resolved: ResolvedPaneFunction,
  symbols: string[],
  payload: DesktopPaneShotPayload,
): string[] {
  const expected = [...symbols];
  const graphKind = shotGraphKind(resolved);
  if (graphKind) {
    const metric = resolved.options.metric as GraphMetricKey;
    const definition = metricDef(graphKind, metric);
    const period = resolved.options.period as FundamentalPeriod;
    const periodCount = resolved.options.periods == null ? null : Number(resolved.options.periods);
    if (resolved.pane.id === CHART_COMPOSER_PANE_ID) {
      // Chart series are labelled with the field short label ("P/S"), not the
      // catalog label ("Price / Sales").
      const field = getTimeSeriesField(`${graphKind}.${metric}`);
      expected.push(field?.shortLabel ?? definition.label);
      return expected.filter(Boolean);
    }
    expected.push(definition.label);
    for (const [symbol, financials] of payload.financials) {
      const latestRow = limitGraphRowsBySymbol(
        graphRowsForFinancials(financials, graphKind, metric, period, symbol),
        periodCount,
      ).sort((left, right) => left.date.localeCompare(right.date)).at(-1);
      if (latestRow) {
        expected.push(latestRow.date);
        expected.push(definition.format(latestRow.value));
      }
    }
  } else if (resolved.capability.id === "financial-statements") {
    const statementLabels: Record<string, string> = {
      income: "Income",
      balance: "Balance",
      cashflow: "Cash Flow",
    };
    expected.push(statementLabels[String(resolved.options.statement)] ?? "");
    expected.push(resolved.options.period === "annual" ? "Annual" : "Quarterly");
    const financials = payload.financials[0]?.[1];
    if (financials) {
      const table = buildFinancialTableModel(financials, {
        period: resolved.options.period as FundamentalPeriod,
        statement: String(resolved.options.statement),
      });
      const latestStatement = table?.statements[0];
      const firstMetric = table?.rows[0];
      if (latestStatement) expected.push(formatFinancialHeader(latestStatement.date).trim());
      if (firstMetric) expected.push(firstMetric.unitLabel);
    }
  }
  return expected.filter(Boolean);
}

function shotExpectedSelections(
  resolved: ResolvedPaneFunction,
): PaneScreenshotExpectedSelection[] {
  if (resolved.pane.id === CHART_COMPOSER_PANE_ID) return [];
  if (shotGraphKind(resolved)) {
    return [{
      control: "metric",
      value: String(resolved.options.metric),
    }];
  }
  if (resolved.capability.id !== "financial-statements") return [];
  const labels: Record<string, string> = {
    income: "Income",
    cashflow: "Cash Flow",
    balance: "Balance Sheet",
  };
  return [
    {
      control: "statement",
      label: labels[String(resolved.options.statement)] ?? String(resolved.options.statement),
    },
    {
      control: "period",
      value: String(resolved.options.period),
    },
  ];
}

export function missingActiveTabSelections(
  semanticUi: RemoteUiNodeSnapshot[],
  expected: PaneScreenshotExpectedSelection[],
): PaneScreenshotExpectedSelection[] {
  const activeTabs = semanticUi.flatMap((node) => {
    if (node.role !== "tabs" || !node.metadata) return [];
    const activeValue = typeof node.metadata.activeValue === "string"
      ? node.metadata.activeValue
      : null;
    const tabs = Array.isArray(node.metadata.tabs)
      ? node.metadata.tabs.filter((tab): tab is Record<string, unknown> => (
        !!tab && typeof tab === "object" && !Array.isArray(tab)
      ))
      : [];
    const activeTab = tabs.find((tab) => String(tab.value) === activeValue);
    return [{
      value: activeValue,
      label: typeof activeTab?.label === "string" ? activeTab.label : null,
    }];
  });

  return expected.filter((selection) => !activeTabs.some((active) => (
    (selection.value == null || active.value === selection.value)
    && (selection.label == null || active.label?.toLowerCase() === selection.label.toLowerCase())
  )));
}
