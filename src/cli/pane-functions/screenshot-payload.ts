import { logFailure } from "../../utils/log-failure";
import { isNoSourceAnswer } from "../../sources/provider-errors";
import { fetchTape } from "../../plugins/builtin/time-sales/client";
import { captureScannerEvent, SCANNER_PANE_KINDS, type ScannerCapture } from "../../plugins/builtin/shared/scanner-capture";
import { isOptionsUnavailableError } from "../../market-data/options-alternatives";
import type { TapeCapture } from "../../plugins/builtin/time-sales/snapshot-client";
import { apiClient } from "../../api-client";
import { snapshotInstrumentKey, type SnapshotMarketData } from "../../market-data/snapshot-provider";
import { toMarketDataContext } from "../../market-data/selectors";
import type { ChartPaneModel } from "../../plugins/builtin/chart-composer/headless";
import { buildHeadlessPaneLoadArgs, loadResolvedHeadlessPaneModel, type LoadedHeadlessPaneModel } from "./headless";
import { resolve } from "path";
import type { PaneRuntimeState } from "../../core/state/app/state";
import { CHART_COMPOSER_PANE_ID, type AppConfig } from "../../types/config";
import type { OptionsChain, TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import { slugifyName } from "../../utils/slugify";
import { requireThemeId } from "../commands/themes";
import type { DesktopPaneShotIntradayHistory, DesktopPaneShotPayload } from "../desktop-pane-shot";
import { optionPaneState, SHOT_SIZE_LIMITS, type ShotSizeClamp } from "./options";
import type { ResolvedPaneFunction } from "./resolver";
import type { MarketContext } from "../types";
import { capabilityPluginState, findCapabilityOption } from "./capabilities";
import type { TimeRange } from "../../time-series/range";
import { parseChartSpec } from "../../plugins/builtin/chart-composer/chart-spec";
import { defaultValuationSeriesLoader, requiredSeries as valuationRequiredSeries } from "../../plugins/builtin/market-valuation/client";
import type { DatedObservation } from "../../plugins/builtin/market-valuation/series";
import { defaultStatLoader } from "../../plugins/builtin/econ-statistics/client";
import { STATS } from "../../plugins/builtin/econ-statistics/stats";
import { parsePublicTickerKey, publicTickerKey } from "../../utils/exchanges";
import { collectExternalPluginBundles } from "../../renderers/electrobun/bun/external-plugins";
import { getQuoteMonitorPaneSettings } from "../../plugins/builtin/ticker-detail/settings";
import { isNotATickerMessage } from "../not-a-ticker";
import { HISTORY_DEFAULT_RANGE } from "../../plugins/builtin/ticker-detail/data-panes/history-bars";
import { findCollection } from "../../plugins/builtin/portfolio-list/cli/render";
import { peekCachedBrokerAccounts } from "../../plugins/builtin/portfolio-list/cached-account";
import { paneScreenshotEvidenceHook } from "./screenshot-evidence";
import {
  collectShotSymbols,
  clipPriceHistoryToRange,
  createFallbackTicker,
  fetchTickerFinancials,
  loadBrokerMarkedHolding,
  loadStoredShotTicker,
  isFinancialAnalysisFunction,
  readsDailyReturns,
  withShotDailyReturns,
  withShotPeriodEndHistory,
  withShotPriceHistory,
  withShotReturnHistory,
  withShotSeasonalityHistory,
} from "./data";
import { shotRatioTab } from "./financial-ratio-shot";
import { stripDesktopShotCredentials } from "./screenshot-bridge";

const DEFAULT_SHOT_DEVICE_SCALE_FACTOR = 2;

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
      const result = await defaultStatLoader(def);
      const observations = Array.isArray(result) ? result : result.observations;
      return [def.seriesId, observations] as [string, DatedObservation[]];
    } catch (error) {
      logFailure("cli.screenshot", "Read screenshot statistics series failed")(error);
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
    } catch (error) {
      logFailure("cli.screenshot", "Read screenshot valuation series failed")(error);
      return null;
    }
  }));
  return loaded.filter((entry): entry is [string, DatedObservation[]] => !!entry);
}

export function defaultScreenshotPath(resolved: ResolvedPaneFunction, rawArg: string): string {
  const suffix = slugifyName([resolved.token, rawArg].filter(Boolean).join("-"), "pane");
  return resolve(process.cwd(), `gloomberb-${suffix}.png`);
}

/**
 * The pixels of the PNG a `shot` of this size writes: the layout snapped to
 * whole cells, drawn at the device scale factor (twice the layout size, as
 * `--scale` trades cells for glyph size at the same output size).
 */
function shotImagePixels(widthPx: number, heightPx: number, scale = 1): { width: number; height: number } {
  const device = DEFAULT_SHOT_DEVICE_SCALE_FACTOR * scale;
  return {
    width: Math.round(Math.max(1, Math.floor(widthPx / scale / DESKTOP_CELL_WIDTH_PX)) * DESKTOP_CELL_WIDTH_PX * device),
    height: Math.round(Math.max(1, Math.floor(heightPx / scale / DESKTOP_CELL_HEIGHT_PX)) * DESKTOP_CELL_HEIGHT_PX * device),
  };
}

/** Whether a capture of this pane, on the tab it opens, grows to show every row (PaneDef.shotFitsRows). */
export function paneFitsRows(resolved: Pick<ResolvedPaneFunction, "pane" | "instance">): boolean {
  const fits = resolved.pane.shotFitsRows;
  return typeof fits === "function" ? fits(resolved.instance) : fits === true;
}

/** The tallest layout, in cells, a capture may grow to at this scale: the `--height` limit. */
export function shotMaxHeightCells(scale: number): number {
  return Math.max(1, Math.floor(SHOT_SIZE_LIMITS.height.max / scale / DESKTOP_CELL_HEIGHT_PX));
}

/** What `shot` says when it drew another size than the one asked for, naming the PNG it wrote. */
export function shotSizeWarnings(
  clamped: readonly ShotSizeClamp[] | undefined,
  size: { width: number; height: number; scale?: number },
): string[] {
  if (!clamped?.length) return [];
  const pixels = shotImagePixels(size.width, size.height, size.scale);
  return clamped.map(({ dimension, requested, used }) => {
    const { min, max } = SHOT_SIZE_LIMITS[dimension];
    const bound = requested < min ? `below the ${min} minimum` : `above the ${max} maximum`;
    const drawn = dimension === "width" ? `${pixels.width} px wide` : `${pixels.height} px tall`;
    return `--${dimension} ${requested} is ${bound}, so the capture used ${used} and the PNG is ${drawn}.`;
  });
}

/** The options typed, by their key: an alias or another spelling (`--min-amount`) reads as the option it names. */
function givenOptionKeys(capability: ResolvedPaneFunction["capability"], options: Record<string, string | true>): ReadonlySet<string> {
  return new Set(Object.keys(options).flatMap((key) => findCapabilityOption(capability, key)?.key ?? []));
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
  loadModel: () => Promise<LoadedHeadlessPaneModel> = () => loadResolvedHeadlessPaneModel(resolved, context, rawArg),
  scannerFeed: Pick<typeof apiClient, "subscribeScanner"> = apiClient,
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
  // The pane opens on what the report found (13F: the fund a name resolved to, on its view's tab).
  const opened = resolved.headless?.shotState
    ? await resolved.headless.shotState(
      buildHeadlessPaneLoadArgs(resolved.headless, resolved.token, rawArg, resolved.options),
      async () => (await loadModel()).result as never,
      givenOptionKeys(resolved.capability, options),
    )
    : null;
  for (const [pluginId, state] of Object.entries(opened?.pluginState ?? {})) {
    initialPaneState.pluginState = {
      ...(initialPaneState.pluginState ?? {}),
      [pluginId]: { ...(initialPaneState.pluginState?.[pluginId] ?? {}), ...state },
    };
  }
  const paneState = stripDesktopShotCredentials<Record<string, PaneRuntimeState>>({
    [resolved.instance.instanceId]: initialPaneState,
  });
  let shotInstance = stripDesktopShotCredentials<typeof resolved.instance>(
    opened?.settings ? { ...resolved.instance, settings: { ...resolved.instance.settings, ...opened.settings } } : resolved.instance,
  );
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
    ...(theme ? { theme: requireThemeId(theme) } : {}),
    layout,
    layouts: [{
      name: "CLI Shot",
      layout,
      paneState,
      focusedPaneId: resolved.instance.instanceId,
    }],
    activeLayoutIndex: 0,
    onboardingComplete: true,
  });

  const tickers: TickerRecord[] = [];
  const financials: Array<[string, TickerFinancials]> = [];
  const intradayHistories: DesktopPaneShotIntradayHistory[] = [];
  let instrumentFinancials: SnapshotMarketData["instrumentFinancials"];
  let historyVariants: SnapshotMarketData["historyVariants"];
  const optionsChains: Array<[string, OptionsChain]> = [];
  const tapeSnapshots: TapeCapture[] = [];
  const [valuationSeries, statSeries] = await Promise.all([
    collectShotValuationSeries(resolved),
    collectShotStatSeries(resolved),
  ]);
  const includeOptionsChains = resolved.pane.id === OPTIONS_PANE_ID || resolved.template?.paneId === OPTIONS_PANE_ID;
  let chartModel: ChartPaneModel | undefined;
  const evidenceHook = paneScreenshotEvidenceHook(resolved);
  if (evidenceHook?.prepare) {
    const prepared = await evidenceHook.prepare({ resolved, context, settings: shotInstance.settings ?? {}, loadModel });
    shotInstance = { ...shotInstance, settings: { ...shotInstance.settings, ...prepared.settings } };
    for (const [symbol, data] of prepared.financials ?? []) {
      financials.push([symbol, data]);
      tickers.push(await createFallbackTicker(symbol, data, context));
    }
  } else if (resolved.pane.id === "analytics") {
    const loaded = await loadModel();
    shotInstance = { ...shotInstance, settings: { ...shotInstance.settings, analyticsView: "risk", riskSnapshot: loaded.result.metadata?.model ?? null } };
  } else if (resolved.pane.id === CHART_COMPOSER_PANE_ID) {
    const loaded = await loadModel();
    chartModel = loaded.result as ChartPaneModel;
    // Charts keep failed series as rows in their model. A lone name with no
    // listing must fail the command before that empty chart is rendered.
    if (collectShotSymbols(resolved, rawArg).length === 1 && chartModel.series.every((series) => series.points.length === 0)) {
      const unknown = chartModel.chart.series.find((series) => isNotATickerMessage(series.warning))?.warning;
      if (unknown) throw new Error(unknown);
    }
    shotInstance = { ...shotInstance, settings: { ...shotInstance.settings, chartSpec: chartModel.spec } };
    const authored = parseChartSpec(resolved.instance.settings?.chartSpec);
    const captured = new Map(chartModel.snapshot.financials);
    instrumentFinancials = chartModel.snapshot.instrumentFinancials;
    historyVariants = chartModel.snapshot.historyVariants;
    const identities = new Map(chartModel.spec.series.flatMap((series) => {
      if (series.source.kind !== "security") return [];
      const key = publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange);
      const original = authored?.series.find(({ id }) => id === series.id)?.source;
      const label = original?.kind === "security" ? publicTickerKey(original.instrument.symbol, original.instrument.exchange) : key;
      return [[snapshotInstrumentKey(series.source.instrument), { key, label, target: series.source.instrument }] as const];
    }));
    for (const [identity, { key, label, target }] of identities) {
      const data = (target.instrument ? instrumentFinancials?.find(entry => snapshotInstrumentKey(entry.instrument) === identity)?.financials : captured.get(key))
        ?? { annualStatements: [], quarterlyStatements: [], priceHistory: [] };
      if (!target.instrument) financials.push([label, data]);
      const { symbol } = parsePublicTickerKey(key);
      const ticker = await context.store.loadTicker(key) ?? await context.store.loadTicker(symbol);
      tickers.push(ticker ?? await createFallbackTicker(key, data, context));
    }
    intradayHistories.push(...chartModel.snapshot.intradayHistories.map((history) => ({
      ...history, start: history.start?.toISOString() ?? null, end: history.end?.toISOString() ?? null,
    })));
  } else for (const symbol of await collectShotSymbolsWithCollections(resolved, context, rawArg)) {
    let entry: Awaited<ReturnType<typeof fetchTickerFinancials>>;
    try {
      entry = await fetchTickerFinancials(context, symbol);
    } catch (error) {
      // A report that reads its own argument (CDS's issuer name) renders it with no ticker data, as `fn` does.
      if (resolved.headless?.argument.kind === "free-text" && isNotATickerMessage(error instanceof Error ? error.message : null)) continue;
      if (!COLLECTION_PANE_IDS.has(resolved.pane.id)) throw error;
      // The pane values a holding no quote covers, such as an option contract,
      // at the broker's mark. It has no financials to capture.
      const holding = await loadBrokerMarkedHolding(context, symbol);
      if (holding) {
        tickers.push(holding);
        continue;
      }
      // Any other holding no source quotes (an over-the-counter name none
      // carries) is still a row of the list: it shows without a price, and the
      // capture names it under "No data for" rather than failing. A read that
      // was refused, rate limited or timed out fails the capture, to be taken again.
      if (!isNoSourceAnswer(error)) throw error;
      const stored = await loadStoredShotTicker(context, symbol);
      if (!stored) throw error;
      tickers.push(stored);
      financials.push([symbol, { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]);
      continue;
    }
    const requestedRange = shotPriceHistoryRange(resolved);
    let data = entry.financials;
    const exchange = entry.instrument.exchange
      ?? entry.tickerFile?.metadata.exchange
      ?? data.quote?.listingExchangeName
      ?? data.quote?.exchangeName
      ?? "";
    const fiveYearsDaily = resolved.pane.id === "realized-vol" || resolved.pane.id === "iv-history" || resolved.pane.id === "macro-day"
      // KELLY's History tab reads monthly returns off five years of daily closes.
      || resolved.pane.id === "kelly-sizer";
    if (fiveYearsDaily || resolved.pane.id === "iv-screen" || resolved.pane.id === "short-watch"
      || resolved.pane.id === "backtest" || resolved.pane.id === OPTIONS_PANE_ID) {
      // Generic 5Y snapshots can contain weekly bars. The snapshot provider
      // treats captured history as authoritative, even for a later 1d request.
      // Preserve the pane's daily buffer and warmup before the renderer clips it.
      if (!context.dataProvider.getPriceHistoryForResolution) {
        throw new Error("Daily-history screenshots require daily history resolution support.");
      }
      const priceHistory = await context.dataProvider.getPriceHistoryForResolution(
        entry.instrument.symbol, exchange,
        fiveYearsDaily ? "5Y" : resolved.pane.id === "backtest" ? "ALL" : "1Y",
        "1d", toMarketDataContext(entry.instrument),
      );
      data = { ...data, priceHistory };
    } else if (shotRatioTab(resolved)?.key === "valuation") {
      data = await withShotPeriodEndHistory(context, entry.instrument, exchange, resolved, data);
    } else if (resolved.pane.id === "seasonality") {
      data = await withShotSeasonalityHistory(context, entry.instrument, resolved, data);
    } else if (resolved.pane.id === "returns") {
      data = await withShotReturnHistory(context, entry.instrument, exchange, resolved, data);
    } else if (requestedRange && readsDailyReturns(resolved)) {
      data = await withShotDailyReturns(context, entry.instrument, exchange, requestedRange, data);
    } else if (requestedRange) {
      try {
        const priceHistory = await context.dataProvider.getPriceHistory(entry.instrument.symbol, exchange, requestedRange);
        data = { ...data, priceHistory: clipPriceHistoryToRange(priceHistory, requestedRange) };
      } catch {
        data = await withShotPriceHistory(context, symbol, entry.tickerFile, data);
      }
    } else {
      // The cloud's financials carry no price history. The snapshot provider
      // treats a captured dataset as authoritative, so an empty history here
      // left the overview chart and quote monitor sparklines blank instead of
      // letting the pane fetch them.
      data = await withShotPriceHistory(context, symbol, entry.tickerFile, data);
    }
    tickers.push(entry.tickerFile ?? await createFallbackTicker(symbol, data, context));
    financials.push([symbol, data]);
    if (resolved.pane.id === "time-sales") {
      tapeSnapshots.push([entry.instrument.symbol, exchange, await fetchTape(entry.instrument.symbol, exchange)]);
    }
    if (includeOptionsChains && context.dataProvider.getOptionsChain) {
      // A future with no chain of its own is the pane's to explain (the listed alternative), not a failed shot.
      const chain = await context.dataProvider.getOptionsChain(entry.instrument.symbol, exchange, undefined,
        context.refresh ? { cacheMode: "refresh" } : undefined).catch((error: unknown) => {
        if (isOptionsUnavailableError(error)) return null;
        throw error;
      });
      if (chain) optionsChains.push([symbol, chain]);
    }
  }
  // A scanner pane reads one answer from the capture's own session: the page's socket is refused (see createSnapshotScannerClient).
  const scannerKind = SCANNER_PANE_KINDS[resolved.pane.id];
  const scannerSnapshots: ScannerCapture[] = scannerKind
    ? [[scannerKind, await captureScannerEvent(scannerFeed, scannerKind, new AbortController().signal)]]
    : [];
  layout.instances[0] = shotInstance;
  config.layout.instances[0] = shotInstance;
  if (config.layouts[0]) config.layouts[0].layout.instances[0] = shotInstance;

  const payload: DesktopPaneShotPayload = {
    config,
    marketDataProviderId: context.dataProvider.id,
    paneId: resolved.instance.instanceId,
    widthCells,
    heightCells,
    widthPx,
    heightPx,
    deviceScaleFactor,
    watermark,
    tickers,
    ...(COLLECTION_PANE_IDS.has(resolved.pane.id)
      ? { brokerAccounts: peekCachedBrokerAccounts(context.config, context.persistence?.resources) }
      : {}),
    financials,
    ...(instrumentFinancials?.length ? { instrumentFinancials } : {}),
    ...(historyVariants?.length ? { historyVariants } : {}),
    intradayHistories,
    optionsChains,
    ...(tapeSnapshots.length ? { tapeSnapshots } : {}),
    ...(scannerSnapshots.length ? { scannerSnapshots } : {}),
    valuationSeries,
    statSeries,
    paneState,
    externalPlugins: await collectExternalPluginBundles(),
  };
  if (chartModel) payload.chartModel = chartModel.chart;
  return payload;
}

/** Panes that render the user's portfolio or watchlist rather than an argument. */
export const COLLECTION_PANE_IDS = new Set(["portfolio-list", "analytics", "kelly-sizer", "earnings-calendar"]);

/**
 * The page only knows the tickers the payload carries, so a collection pane
 * captured with just the argument symbol showed an empty portfolio. Portfolio
 * and watchlist members ride along for the panes that display them.
 */
async function collectShotSymbolsWithCollections(
  resolved: ResolvedPaneFunction,
  context: MarketContext,
  rawArg: string,
): Promise<string[]> {
  if (!COLLECTION_PANE_IDS.has(resolved.pane.id)) return collectShotSymbols(resolved, rawArg);
  // `shot PF Retirement` names a portfolio, not a ticker to fetch.
  const symbols = rawArg.trim() && findCollection(context.config, rawArg) ? [] : collectShotSymbols(resolved, rawArg);
  const members = (await context.store.loadAllTickers())
    .filter(({ metadata }) => metadata.portfolios.length > 0 || metadata.watchlists.length > 0)
    .map(({ metadata }) => metadata.ticker);
  return [...new Set([...symbols, ...members])];
}

function shotPriceHistoryRange(resolved: ResolvedPaneFunction): TimeRange | null {
  // Captured history is authoritative, and the generic 5Y capture is weekly.
  if (resolved.pane.id === "quote-monitor") return getQuoteMonitorPaneSettings(resolved.instance.settings).chartPeriod;
  switch (resolved.capability.id) {
    case "return-correlation":
      return (resolved.options.rangePreset ?? "1Y") as TimeRange;
    case "historical-prices":
      return (resolved.options.range ?? HISTORY_DEFAULT_RANGE) as TimeRange;
    case "security-relationship":
      return (resolved.options.range ?? "1Y") as TimeRange;
    default:
      return null;
  }
}
