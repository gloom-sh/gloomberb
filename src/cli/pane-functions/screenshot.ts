import { apiClient } from "../../api-client";
import type { ChartPaneModel } from "../../plugins/builtin/chart-composer/headless";
import { loadResolvedHeadlessPaneModel } from "./headless";
import { dirname, resolve } from "path";
import { mkdir } from "fs/promises";
import type { PaneRuntimeState } from "../../core/state/app/state";
import { CHART_COMPOSER_PANE_ID, type AppConfig } from "../../types/config";
import type { OptionsChain, PricePoint, TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { slugifyName } from "../../utils/slugify";
import { resolvePresetSelection } from "../../theme/presets";
import { getTheme, getThemeIds, hasScheme } from "../../theme/themes";
import { getStyleIds, hasStyle } from "../../theme/styles";

const DEFAULT_SHOT_DEVICE_SCALE_FACTOR = 2;
import {
  renderDesktopPaneScreenshot,
  type DesktopPaneShotApiProxy,
  type DesktopPaneShotBridge,
  type DesktopPaneShotHttpRequest,
  type DesktopPaneShotHttpResponse,
  type DesktopPaneShotIntradayHistory,
  type DesktopPaneShotPayload,
  type DesktopPaneShotRenderResult,
} from "../desktop-pane-shot";
import { optionPaneState } from "./options";
import type { ResolvedPaneFunction } from "./resolver";
import type { MarketContext } from "../types";
import { capabilityPluginState } from "./capabilities";
import { resolvePersistedCloudSessionToken } from "./cloud-session";
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
import { parsePublicTickerKey, publicTickerKey } from "../../utils/exchanges";
import { getCloudApiBaseUrl } from "../../api-client/request";
import type { ResolvedSeries } from "../../time-series/types";
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
const CREDENTIAL_FIELD_NAMES = new Set([
  "accesstoken",
  "accessurl",
  "apikey",
  "apisecret",
  "authorization",
  "cookie",
  "credentials",
  "oauth",
  "passphrase",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "token",
]);

/**
 * The proxy receives the desktop session out of band. Keeping this separate
 * from DesktopPaneShotPayload prevents the token from entering the page,
 * semantic evidence, or JSON CLI output.
 */
function isCredentialField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return CREDENTIAL_FIELD_NAMES.has(normalized)
    || normalized.endsWith("password")
    || normalized.endsWith("passphrase")
    || normalized.endsWith("secret")
    || normalized.endsWith("token")
    || normalized.endsWith("credential")
    || normalized.endsWith("cookie")
    || normalized.endsWith("apikey")
    || normalized.endsWith("accesskey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("authorization")
    || normalized.endsWith("accessurl");
}

/** Removes credential-shaped object fields before data enters the page or JSON output. */
export function stripDesktopShotCredentials<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => stripDesktopShotCredentials(entry)) as T;
  }
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isCredentialField(key)) continue;
    clean[key] = stripDesktopShotCredentials(entry);
  }
  return clean as T;
}

export function resolveDesktopShotApiProxy(
  context: Pick<MarketContext, "persistence">,
): DesktopPaneShotApiProxy {
  return {
    baseUrl: getCloudApiBaseUrl(),
    sessionToken: resolvePersistedCloudSessionToken(context),
  };
}

/**
 * Data the page may request while it renders. The cloud API is only one of the
 * router's sources, so calling it directly from the page dropped whatever
 * another provider contributes: analyst rating price targets came back empty
 * and corporate actions vanished whenever the cloud leg failed. Quotes are
 * here for board panes that list symbols the payload was never built for.
 * These run on the Bun side through the same router `gloomberb fn` uses.
 */
const SHOT_BRIDGE_MARKET_OPERATIONS = new Set([
  "getAnalystResearch",
  "getCorporateActions",
  "getEarningsCalendar",
  "getHolders",
  "getPriceHistory",
  "getQuote",
  "getQuotesBatch",
  "getSecFilings",
]);

const SHOT_BRIDGE_HTTP_TIMEOUT_MS = 20_000;

export function createDesktopShotBridge(
  context: Pick<MarketContext, "dataProvider">,
): DesktopPaneShotBridge {
  return {
    async marketData(operation, args) {
      if (!SHOT_BRIDGE_MARKET_OPERATIONS.has(operation)) {
        throw new Error(`Screenshot market bridge does not serve "${operation}".`);
      }
      const provider = context.dataProvider as unknown as Record<string, unknown>;
      const handler = provider[operation];
      if (typeof handler !== "function") {
        throw new Error(`No provider available for ${operation}.`);
      }
      return await (handler as (...values: unknown[]) => Promise<unknown>).apply(
        context.dataProvider,
        args,
      );
    },
    httpFetch: (request) => runDesktopShotHttpFetch(request),
  };
}

/**
 * Panes such as DVD fetch a third-party API directly. A browser cannot: the
 * request is cross-origin and dies in CORS, so the pane reported that the
 * ticker pays no dividend. The desktop renderer already proxies these through
 * its native half; the screenshot page gets the same treatment.
 */
async function runDesktopShotHttpFetch(
  request: DesktopPaneShotHttpRequest,
): Promise<DesktopPaneShotHttpResponse> {
  const target = new URL(request.url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Screenshot HTTP bridge refuses ${target.protocol} requests.`);
  }
  const response = await fetch(request.url, {
    method: request.method ?? "GET",
    headers: request.headers,
    body: request.body,
    redirect: "follow",
    signal: AbortSignal.timeout(SHOT_BRIDGE_HTTP_TIMEOUT_MS),
  });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers,
    setCookie: response.headers.getSetCookie?.() ?? [],
    body: await response.text(),
  };
}

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
  resolution?: string;
  sessionDates?: string[];
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

export interface PaneScreenshotReadinessSignals {
  rowCount: number;
  loadingStateDetected: boolean;
  errorStateDetected: boolean;
  emptyStateDetected: boolean;
  complete: boolean;
  semanticMismatch: boolean;
  requiresStructuredDataEvidence: boolean;
  hasStructuredDataEvidence: boolean;
}

export function isPaneScreenshotUsable(signals: PaneScreenshotReadinessSignals): boolean {
  return signals.rowCount > 0
    && !signals.loadingStateDetected
    && !signals.errorStateDetected
    && !signals.emptyStateDetected
    && signals.complete
    && !signals.semanticMismatch
    && (!signals.requiresStructuredDataEvidence || signals.hasStructuredDataEvidence);
}

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
  unusableReason: string | null;
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

export async function buildDesktopShotPayload(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
  options: Record<string, string | true>,
  widthPx: number,
  heightPx: number,
  theme: string | null,
  scale: number,
  watermark: string | null,
): Promise<DesktopPaneShotPayload> {
  // The requested size is the output size. Scale shrinks the CSS viewport and
  // raises the device scale factor by the same factor, so a 1200px wide shot at
  // scale 1.5 lays out 100 cells instead of 150 and every glyph is 1.5x larger.
  // Snap to whole cells: rounding up used to make the pane a few pixels taller
  // than the capture, which clipped the bottom axis of charts.
  const widthCells = Math.max(1, Math.floor(widthPx / scale / DESKTOP_CELL_WIDTH_PX));
  const heightCells = Math.max(1, Math.floor(heightPx / scale / DESKTOP_CELL_HEIGHT_PX));
  widthPx = widthCells * DESKTOP_CELL_WIDTH_PX;
  heightPx = heightCells * DESKTOP_CELL_HEIGHT_PX;
  const deviceScaleFactor = DEFAULT_SHOT_DEVICE_SCALE_FACTOR * scale;
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
  const paneState = stripDesktopShotCredentials<Record<string, PaneRuntimeState>>({
    [resolved.instance.instanceId]: initialPaneState,
  });
  let shotInstance = stripDesktopShotCredentials<typeof resolved.instance>(resolved.instance);
  const layout = {
    dockRoot: null,
    instances: [shotInstance],
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
  const config = stripDesktopShotCredentials<AppConfig>({
    ...context.config,
    ...(theme ? resolveShotTheme(theme) : {}),
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
  });

  const tickers: TickerRecord[] = [];
  const financials: Array<[string, TickerFinancials]> = [];
  const intradayHistories: DesktopPaneShotIntradayHistory[] = [];
  const optionsChains: Array<[string, OptionsChain]> = [];
  const [valuationSeries, statSeries] = await Promise.all([
    collectShotValuationSeries(resolved),
    collectShotStatSeries(resolved),
  ]);
  const includeOptionsChains = resolved.pane.id === OPTIONS_PANE_ID || resolved.template?.paneId === OPTIONS_PANE_ID;
  let chartModel: ChartPaneModel | undefined;
  if (resolved.pane.id === CHART_COMPOSER_PANE_ID) {
    const loaded = await loadResolvedHeadlessPaneModel(resolved, context, rawArg);
    chartModel = loaded.result as ChartPaneModel;
    shotInstance = { ...shotInstance, settings: { ...shotInstance.settings, chartSpec: chartModel.spec } };
    const authored = parseChartSpec(resolved.instance.settings?.chartSpec);
    const captured = new Map(chartModel.snapshot.financials);
    const identities = new Map(chartModel.spec.series.flatMap((series) => {
      if (series.source.kind !== "security") return [];
      const key = publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange);
      const original = authored?.series.find(({ id }) => id === series.id)?.source;
      const label = original?.kind === "security" ? publicTickerKey(original.instrument.symbol, original.instrument.exchange) : key;
      return [[key, label] as const];
    }));
    for (const [key, label] of identities) {
      const data = captured.get(key) ?? { annualStatements: [], quarterlyStatements: [], priceHistory: [] };
      financials.push([label, data]);
      const { symbol } = parsePublicTickerKey(key);
      const ticker = await context.store.loadTicker(key) ?? await context.store.loadTicker(symbol);
      tickers.push(ticker ?? createFallbackTicker(key, data, context));
    }
    intradayHistories.push(...chartModel.snapshot.intradayHistories.map((history) => ({
      ...history, start: history.start?.toISOString() ?? null, end: history.end?.toISOString() ?? null,
    })));
  } else for (const symbol of collectShotSymbols(resolved, rawArg)) {
    const entry = await fetchTickerFinancials(context, symbol);
    const requestedRange = shotPriceHistoryRange(resolved);
    let data = entry.financials;
    const exchange = entry.instrument.exchange
      ?? entry.tickerFile?.metadata.exchange
      ?? data.quote?.listingExchangeName
      ?? data.quote?.exchangeName
      ?? "";
    if (requestedRange) {
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
      const chain = await context.dataProvider.getOptionsChain(entry.instrument.symbol, exchange);
      optionsChains.push([symbol, chain]);
    }
  }
  layout.instances[0] = shotInstance;
  config.layout.instances[0] = shotInstance;
  if (config.layouts[0]) config.layouts[0].layout.instances[0] = shotInstance;

  const payload: DesktopPaneShotPayload = {
    config,
    paneId: resolved.instance.instanceId,
    widthCells,
    heightCells,
    widthPx,
    heightPx,
    deviceScaleFactor,
    watermark,
    tickers,
    financials,
    intradayHistories,
    optionsChains,
    valuationSeries,
    statSeries,
    paneState,
  };
  if (chartModel) payload.chartModel = chartModel.chart;
  return payload;
}

/**
 * Accepts a scheme id, a scheme name, or a `<style>-<scheme>` preset, so a
 * shot can capture the structural half as well as the palette.
 */
function resolveShotTheme(requested: string): { theme: string; themeStyle?: string } {
  const normalized = requested.trim().toLowerCase().replace(/[\s_]+/g, "-");
  const ids = getThemeIds();
  const scheme = ids.find((id) => id.toLowerCase() === normalized)
    ?? ids.find((id) => getTheme(id).name.toLowerCase().replace(/[\s_]+/g, "-") === normalized);
  if (scheme) return { theme: scheme };

  const selection = resolvePresetSelection(normalized);
  if (selection?.schemeId && hasScheme(selection.schemeId) && hasStyle(selection.styleId)) {
    return { theme: selection.schemeId, themeStyle: selection.styleId };
  }
  throw new Error(
    `Unknown theme "${requested}". Schemes: ${ids.join(", ")}. Styles: ${getStyleIds().join(", ")}.`,
  );
}

function shotPriceHistoryRange(resolved: ResolvedPaneFunction): TimeRange | null {
  switch (resolved.capability.id) {
    case "return-correlation":
      return (resolved.options.rangePreset ?? "1Y") as TimeRange;
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
  theme,
  scale,
  watermark,
  options,
  captureImage = true,
}: {
  resolved: ResolvedPaneFunction;
  context: MarketContext;
  rawArg: string;
  outputPath: string;
  width: number;
  height: number;
  theme?: string | null;
  scale?: number;
  watermark?: string | null;
  options: Record<string, string | true>;
  captureImage?: boolean;
}): Promise<PaneScreenshotResult> {
  if (captureImage) await mkdir(dirname(outputPath), { recursive: true });
  const apiProxy = resolveDesktopShotApiProxy(context);
  const previousSessionToken = apiClient.getSessionToken();
  let payload: DesktopPaneShotPayload;
  let render: DesktopPaneShotRenderResult;
  apiClient.setSessionToken(apiProxy.sessionToken);
  try {
    payload = await buildDesktopShotPayload(
      resolved,
      context,
      rawArg,
      options,
      width,
      height,
      theme ?? null,
      scale ?? 1,
      watermark ?? null,
    );
    render = await renderDesktopPaneScreenshot(payload, outputPath, apiProxy, {
      captureImage,
      bridge: createDesktopShotBridge(context),
    });
  } finally {
    apiClient.setSessionToken(previousSessionToken);
  }
  const renderedInstance = payload.config.layout.instances.find(({ instanceId }) => instanceId === payload.paneId);
  if (renderedInstance) resolved = { ...resolved, instance: renderedInstance };
  const symbols = payload.financials.map(([symbol]) => symbol);
  const usesLiveDomEvidence = resolved.capability.screenshotReadiness === "live-dom";
  const rowCount = usesLiveDomEvidence
    ? render.rows.length
    : shotSemanticRowCount(resolved, payload, render.semanticUi);
  const unavailableSymbols = usesLiveDomEvidence
    ? []
    : shotUnavailableSymbols(resolved, payload, render.semanticUi);
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
  const chartEvidenceMismatches = [
    ...(expectedChart ? chartEvidenceMismatchesFor(render.semanticUi, expectedChart) : []),
    ...intradayChartEvidenceMismatchesFor(resolved, payload, render.semanticUi),
  ];
  const semanticMismatch = missingExpectedText.length > 0
    || missingExpectedSelections.length > 0
    || chartEvidenceMismatches.length > 0;
  const empty = render.loadingStateDetected
    || render.errorStateDetected
    || render.emptyStateDetected
    || rowCount === 0
    || semanticMismatch;
  const usable = isPaneScreenshotUsable({
    rowCount,
    loadingStateDetected: render.loadingStateDetected,
    errorStateDetected: render.errorStateDetected,
    emptyStateDetected: render.emptyStateDetected,
    complete,
    semanticMismatch,
    requiresStructuredDataEvidence: requiresStructuredDataEvidence(resolved),
    hasStructuredDataEvidence: dataEvidence !== null,
  });
  const unusableReason = usable
    ? null
    : shotUnusableReasonFor(resolved, payload, render, unavailableSymbols, semanticMismatch);
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
    options: stripDesktopShotCredentials(resolved.options),
    rowCount,
    empty,
    complete,
    unavailableSymbols,
    semanticMismatch,
    usable,
    unusableReason,
    dataEvidence,
    outputPath,
    render: {
      ...stripDesktopShotCredentials(render),
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
  return [
    "price-chart",
    "intraday-price-chart",
    "price-comparison",
    "fundamental-series",
    "financial-statements",
  ].includes(resolved.capability.id);
}

export function shotUnusableReasonFor(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  render: Pick<DesktopPaneShotRenderResult, "loadingStateDetected" | "errorStateDetected" | "emptyStateDetected">,
  unavailableSymbols: string[],
  semanticMismatch: boolean,
): string {
  if (resolved.capability.id === "intraday-price-chart") {
    const intraday = payload.intradayHistories[0];
    if (intraday?.unavailableReason) return intraday.unavailableReason;
    if (intraday && intraday.points.length > 0) {
      return `Intraday bars were loaded for ${intraday.symbol}, but the chart did not render them.`;
    }
    const symbol = payload.financials[0]?.[0] ?? resolved.createOptions?.symbol ?? "the ticker";
    return `No intraday price history is available for ${symbol} for the requested session window.`;
  }
  if (render.loadingStateDetected) return "The pane was still loading when the screenshot was captured.";
  if (render.errorStateDetected) return "The pane rendered an error state.";
  if (render.emptyStateDetected) return "The pane rendered an empty state.";
  if (unavailableSymbols.length > 0) return `Data is unavailable for ${unavailableSymbols.join(", ")}.`;
  if (semanticMismatch) return "The rendered content did not match the requested capability.";
  return "The pane did not produce verifiable screenshot evidence.";
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
  const spec = payload.chartModel ? parseChartSpec(payload.config.layout.instances.find((instance) => instance.instanceId === payload.paneId)?.settings?.chartSpec) : null;
  const visibleSeries = payload.chartModel && spec ? spec.series.flatMap((entry) => {
    if (entry.source.kind !== "security" || entry.visible === false) return [];
    const output = payload.chartModel!.series.find((series) => series.id === entry.id);
    return [{
      symbol: publicTickerKey(entry.source.instrument.symbol, entry.source.instrument.exchange),
      points: (output?.points ?? []).flatMap((point) => {
        const close = point.rawValue === undefined ? point.value ?? point.close : point.rawValue;
        return typeof close === "number" && Number.isFinite(close) ? [{ date: point.date, close }] : [];
      }),
    }];
  }) : null;
  if (resolved.capability.id === "intraday-price-chart") {
    const intraday = payload.intradayHistories[0];
    if (!intraday || intraday.points.length === 0) return null;
    const evidence = chartSeriesEvidence(intraday.symbol, intraday.points);
    if (!evidence.first || !evidence.last) return null;
    return {
      kind: "price-series",
      symbol: intraday.symbol,
      range: intraday.rangePreset,
      pointCount: evidence.pointCount,
      first: evidence.first,
      last: evidence.last,
      resolution: intraday.resolution,
      sessionDates: intraday.sessionDates,
    };
  }

  if (resolved.capability.id === "price-chart") {
    const range = String(resolved.options.rangePreset ?? "5Y") as TimeRange;
    const [symbol, financials] = payload.financials[0] ?? [];
    const captured = visibleSeries?.[0];
    const evidence = captured ? chartSeriesEvidence(captured.symbol, captured.points)
      : visibleSeries === null && symbol && financials ? normalizeChartSeries(symbol, financials, range).evidence : null;
    if (!evidence?.first || !evidence.last || evidence.pointCount <= 0) return null;
    return { kind: "price-series", range, ...evidence, first: evidence.first, last: evidence.last };
  }

  if (resolved.capability.id === "price-comparison") {
    const range = String(resolved.options.rangePreset ?? "1Y") as TimeRange;
    const normalizedSeries = visibleSeries ?? payload.financials.map(([symbol, financials]) => ({
      symbol,
      points: normalizeChartSeries(symbol, financials, range).points,
    }));
    const latestTimestamp = Math.max(
      ...normalizedSeries.flatMap(({ points }) => points.map(({ date }) => date.getTime())),
    );
    if (!Number.isFinite(latestTimestamp)) return null;
    const projectionStart = subtractTimeRange(new Date(latestTimestamp), range).getTime();
    const series = normalizedSeries.flatMap(({ symbol, points }) => {
      const projectionPoints = visibleSeries ? points : points.filter(({ date }) => date.getTime() >= projectionStart);
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
    const series = visibleSeries?.map(({ symbol, points }) => ({
      symbol, rows: points.slice(-evidencePeriodCount).map(({ date, close }) => ({ date: date.toISOString().slice(0, 10), value: close })),
    })) ?? payload.financials.map(([symbol, financials]) => ({
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
                const resolvedSeries = payload.chartModel?.series.find((entry) => entry.id === series.id);
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

export function intradayChartEvidenceMismatchesFor(
  resolved: ResolvedPaneFunction,
  payload: DesktopPaneShotPayload,
  semanticUi: RemoteUiNodeSnapshot[],
): string[] {
  if (resolved.capability.id !== "intraday-price-chart") return [];
  const intraday = payload.intradayHistories[0];
  if (!intraday || intraday.points.length === 0) return [];
  const metadata = semanticUi.find((node) => (
    node.role === "chart-data" && node.metadata?.kind === "chart-composer"
  ))?.metadata;
  if (!metadata) return ["rendered intraday chart-data semantic evidence is missing"];
  const baseSeries = Array.isArray(metadata.baseSeries) ? metadata.baseSeries : [];
  const actual = baseSeries[0];
  if (!isRecord(actual)) return ["rendered intraday base series is missing"];

  const expected = chartSeriesEvidence(intraday.symbol, intraday.points);
  const mismatches: string[] = [];
  if (actual.pointCount !== expected.pointCount) {
    mismatches.push("rendered intraday point count does not match");
  }
  if (metadata.projectedPointCount !== expected.pointCount) {
    mismatches.push("rendered intraday projection point count does not match");
  }
  const pointMatches = (
    actualPoint: unknown,
    expectedPoint: PaneScreenshotChartPointEvidence | null,
  ): boolean => {
    if (!isRecord(actualPoint) || !expectedPoint) return false;
    return actualPoint.date === expectedPoint.date
      && typeof actualPoint.value === "number"
      && closeEnough(actualPoint.value, expectedPoint.close);
  };
  if (!pointMatches(actual.first, expected.first)) {
    mismatches.push("rendered intraday first bar does not match");
  }
  if (!pointMatches(actual.last, expected.last)) {
    mismatches.push("rendered intraday last bar does not match");
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
  if (resolved.capability.id === "intraday-price-chart") {
    const symbol = payload.intradayHistories[0]?.symbol ?? payload.financials[0]?.[0];
    const metadata = semanticUi.find((node) => (
      node.role === "chart-data" && node.metadata?.kind === "chart-composer"
    ))?.metadata;
    const renderedPoints = typeof metadata?.projectedPointCount === "number"
      ? metadata.projectedPointCount
      : 0;
    return symbol && renderedPoints <= 0 ? [symbol] : [];
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
  if (["price-chart", "historical-prices"].includes(resolved.capability.id)) {
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
  if (resolved.capability.id === "intraday-price-chart") {
    const metadata = semanticUi.find((node) => (
      node.role === "chart-data" && node.metadata?.kind === "chart-composer"
    ))?.metadata;
    return typeof metadata?.projectedPointCount === "number"
      ? Math.max(0, metadata.projectedPointCount)
      : 0;
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
  if (["price-chart", "historical-prices"].includes(resolved.capability.id)) {
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
