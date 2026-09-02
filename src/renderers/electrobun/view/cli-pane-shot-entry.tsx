/** @jsxImportSource react */
import { createRoot } from "react-dom/client";
import { useEffect, type ReactNode } from "react";
import { AppProvider, useAppDispatch } from "../../../state/app/context";
import { createCliPaneShotConnectionHealth } from "./cli-pane-shot-health";
import { MarketDataCoordinator, setSharedMarketDataCoordinator } from "../../../market-data/coordinator";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { UiHostProvider, type RendererHost } from "../../../ui/host";
import { WebInputHostProvider } from "./input-host";
import { WebDialogHostProvider } from "./dialog-host";
import { webNativeRenderer } from "./native-renderer";
import { WebToastHostProvider } from "./toast-host";
import { webUiHost } from "./ui-host";
import { getLoadablePlugins } from "../../../plugins/catalog";
import { PluginRegistry, setSharedMarketDataForTests } from "../../../plugins/registry";
import {
  RemoteUiRegistryProvider,
  useRemoteUiRegistry,
} from "../../../remote/semantic-tree";
import type { RemoteUiNodeSnapshot } from "../../../remote/types";
import { FloatingPaneWrapper } from "../../../components/layout/floating-pane";
import { PaneContent } from "../../../components/layout/pane/content";
import { resolvePaneBodyFrame } from "../../../components/layout/pane/sizing";
import { getPaneDisplayTitle } from "../../../components/layout/pane/title";
import {
  getPresetResolution,
  normalizeChartResolutionSupport,
  TIME_RANGE_ORDER,
} from "../../../time-series/resolution";
import type { TimeRange } from "../../../components/chart/core/types";
import type { AppConfig } from "../../../types/config";
import type {
  AppPersistencePort,
  AppTickerRepositoryPort,
} from "../../../core/app-service-ports";
import type { CachedResourceRecord, ResourceCacheKey, SetResourceOptions } from "../../../data/resource-store";
import type { CachedFinancialsTarget, DataProvider, QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { OptionsChain, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { AppState, PaneRuntimeState } from "../../../core/state/app/state";
import type { PaneDef } from "../../../types/plugin";
import { canonicalTickerKey, parsePublicTickerKey } from "../../../utils/exchanges";
import { hydrateFredSeries, type FredSeriesCacheEntry } from "../../../data/fred-series";
import { hydrateValuationSeries } from "../../../plugins/builtin/market-valuation/cache";
import type { DatedObservation } from "../../../plugins/builtin/market-valuation/series";
import { clipPriceHistoryToRange } from "../../../time-series/history-window";
import type { ResolvedSeries } from "../../../time-series/types";
import { chartSeriesSourceKey } from "../../../capabilities";

interface CliPaneShotPayload {
  config: AppConfig;
  paneId: string;
  widthCells: number;
  heightCells: number;
  tickers: TickerRecord[];
  financials: Array<[string, TickerFinancials]>;
  optionsChains: Array<[string, OptionsChain]>;
  fredSeries: Array<[string, FredSeriesCacheEntry]>;
  valuationSeries: Array<[string, DatedObservation[]]>;
  capabilitySeries: Array<[string, ResolvedSeries]>;
  paneState: Record<string, PaneRuntimeState>;
}

declare global {
  interface Window {
    __GLOOM_CLI_SHOT_PAYLOAD__?: CliPaneShotPayload;
    __GLOOM_CLI_SHOT_READY__?: boolean;
    __GLOOM_CLI_SHOT_PENDING__?: number;
    __GLOOM_CLI_SHOT_ERROR__?: string;
    __GLOOM_CLI_SHOT_SEMANTIC_UI__?: RemoteUiNodeSnapshot[];
  }
}

// Effects that request pane data start after the first paint. Waiting only two
// frames can capture the shell before those requests register, leaving a
// loading chart or stale performance table in an otherwise valid PNG.
const SHOT_READY_STABLE_FRAMES = 10;
// Loading is detected from an explicit marker rendered by Spinner and
// PaneStatusBody. Matching on body text instead made any pane whose real
// content contains the word "loading" (a changelog release note, a news
// headline) wait forever and time out.
const SHOT_LOADING_SELECTOR = "[data-gloom-status=\"loading\"]";
const TRACKED_RESPONSE_METHODS = new Set<PropertyKey>([
  "arrayBuffer",
  "blob",
  "formData",
  "json",
  "text",
]);

let pendingShotWork = 0;
let didInstallShotFetchTracker = false;
let shotDataProvider: DataProvider | null = null;
let shotRegistry: PluginRegistry | null = null;
const SHOT_CHART_RESOLUTION_SUPPORT = normalizeChartResolutionSupport(
  TIME_RANGE_ORDER.map((maxRange) => ({
    resolution: getPresetResolution(maxRange),
    maxRange,
  })),
);

const rendererHost: RendererHost = {
  requestExit() {},
  async openExternal() {},
  async copyText() {},
  async readText() {
    return "";
  },
  notify() {},
};

function normalizeSymbol(value: string): string {
  return value.trim().replace(/^\$/, "").toUpperCase();
}

function updatePendingShotWork(next: number): void {
  pendingShotWork = Math.max(0, next);
  window.__GLOOM_CLI_SHOT_PENDING__ = pendingShotWork;
}

function trackShotWork<T>(promise: Promise<T>): Promise<T> {
  updatePendingShotWork(pendingShotWork + 1);
  return promise.finally(() => updatePendingShotWork(pendingShotWork - 1));
}

function wrapTrackedResponse(response: Response): Response {
  return new Proxy(response, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!TRACKED_RESPONSE_METHODS.has(property)) return value.bind(target);
      return (...args: unknown[]) => trackShotWork(Promise.resolve(value.apply(target, args)));
    },
  });
}

function installShotFetchTracker(): void {
  if (didInstallShotFetchTracker) return;
  didInstallShotFetchTracker = true;
  updatePendingShotWork(0);
  const fetchOriginal = window.fetch.bind(window);
  window.fetch = ((...args: Parameters<typeof fetch>) => (
    trackShotWork(fetchOriginal(...args)).then(wrapTrackedResponse)
  )) as typeof fetch;
}

function resolveShotWork<T>(value: T): Promise<T> {
  return trackShotWork(Promise.resolve(value));
}

function isShotLoadingTextVisible(): boolean {
  return document.querySelector(SHOT_LOADING_SELECTOR) !== null;
}

/**
 * The payload crosses into the webview as JSON, so every `Date` arrives as a
 * string while the types still claim `Date`. Anything calling `date.getTime()`
 * then throws, which is what made the valuation graph preset fail while the
 * price presets passed.
 */
function revivePayloadDates(payload: CliPaneShotPayload): void {
  for (const [, data] of payload.financials) {
    const history = data.priceHistory;
    if (!Array.isArray(history)) continue;
    for (const point of history) {
      if (!(point.date instanceof Date)) point.date = new Date(point.date as unknown as string);
    }
  }
}

function hasUnresolvedChartData(): boolean {
  return (window.__GLOOM_CLI_SHOT_SEMANTIC_UI__ ?? []).some((node) => (
    node.role === "chart-data"
    && (
      node.metadata?.kind === "stock-price"
      || node.metadata?.kind === "price-comparison"
      || node.metadata?.kind === "chart-composer"
    )
    && (
      node.metadata.loading === true
      || (node.metadata.kind !== "chart-composer" && (
        typeof node.metadata.projectedPointCount !== "number"
        || node.metadata.projectedPointCount <= 0
      ))
    )
  ));
}

function waitForShotReadiness(): () => void {
  let cancelled = false;
  let mutationVersion = 0;
  let lastSeenMutationVersion = 0;
  let stableFrames = 0;
  const observer = new MutationObserver(() => {
    mutationVersion += 1;
  });
  observer.observe(document.body, {
    attributes: true,
    childList: true,
    characterData: true,
    subtree: true,
  });

  const check = () => {
    if (cancelled || window.__GLOOM_CLI_SHOT_READY__) return;
    const changedSinceLastFrame = mutationVersion !== lastSeenMutationVersion;
    lastSeenMutationVersion = mutationVersion;
    if (
      pendingShotWork === 0
      && !isShotLoadingTextVisible()
      && !hasUnresolvedChartData()
      && !changedSinceLastFrame
    ) {
      stableFrames += 1;
    } else {
      stableFrames = 0;
    }

    if (stableFrames >= SHOT_READY_STABLE_FRAMES) {
      observer.disconnect();
      window.__GLOOM_CLI_SHOT_READY__ = true;
      return;
    }
    requestAnimationFrame(check);
  };

  requestAnimationFrame(check);
  return () => {
    cancelled = true;
    observer.disconnect();
  };
}

function createShotDataProvider(payload: CliPaneShotPayload): DataProvider {
  const financials = new Map<string, TickerFinancials>();
  for (const [key, data] of payload.financials) {
    const instrument = parsePublicTickerKey(key);
    financials.set(canonicalTickerKey(instrument.symbol, instrument.exchange), data);
    if (!instrument.exchange) financials.set(normalizeSymbol(instrument.symbol), data);
  }
  const optionsChains = new Map<string, OptionsChain>();
  for (const [key, data] of payload.optionsChains ?? []) {
    const instrument = parsePublicTickerKey(key);
    optionsChains.set(canonicalTickerKey(instrument.symbol, instrument.exchange), data);
    if (!instrument.exchange) optionsChains.set(normalizeSymbol(instrument.symbol), data);
  }

  const getFinancials = (symbol: string, exchange?: string) => {
    const data = financials.get(canonicalTickerKey(symbol, exchange))
      ?? financials.get(normalizeSymbol(symbol));
    if (!data) throw new Error(`No screenshot market data available for ${symbol}.`);
    return data;
  };

  return {
    id: "cli-shot",
    name: "CLI screenshot data",
    getTickerFinancials(ticker, exchange) {
      return trackShotWork(Promise.resolve().then(() => getFinancials(ticker, exchange)));
    },
    getTickerFinancialsBatch(targets: CachedFinancialsTarget[]) {
      return resolveShotWork(targets.map((target) => ({
        target,
        financials: financials.get(canonicalTickerKey(target.symbol, target.exchange))
          ?? financials.get(normalizeSymbol(target.symbol))
          ?? null,
      })));
    },
    getQuote(ticker, exchange) {
      return trackShotWork(Promise.resolve().then(() => {
        const quote = getFinancials(ticker, exchange).quote;
        if (!quote) throw new Error(`No screenshot quote data available for ${ticker}.`);
        return quote;
      }));
    },
    getQuotesBatch(targets: QuoteSubscriptionTarget[]) {
      return resolveShotWork(targets.map((target) => ({
        target,
        quote: (financials.get(canonicalTickerKey(target.symbol, target.exchange))
          ?? financials.get(normalizeSymbol(target.symbol)))?.quote ?? null,
      })));
    },
    getExchangeRate(fromCurrency: string) {
      // Returning 1 for every currency used to render the FX matrix as a grid
      // of 1.0000, which reads as real data. Only the identity conversion is
      // known offline; anything else has to fail so the pane reports it as
      // unavailable instead of inventing a parity rate.
      if (normalizeSymbol(fromCurrency) === normalizeSymbol(payload.config.baseCurrency)) {
        return resolveShotWork(1);
      }
      return trackShotWork(Promise.reject(
        new Error(`No screenshot exchange rate available for ${fromCurrency}.`),
      ));
    },
    getOptionsChain(ticker, exchange) {
      return trackShotWork(Promise.resolve().then(() => {
        const chain = optionsChains.get(canonicalTickerKey(ticker, exchange))
          ?? optionsChains.get(normalizeSymbol(ticker));
        if (!chain) throw new Error(`No screenshot options data available for ${ticker}.`);
        return chain;
      }));
    },
    search(query) {
      const normalized = normalizeSymbol(query);
      return resolveShotWork(payload.tickers
        .filter((ticker) => ticker.metadata.ticker.includes(normalized) || (ticker.metadata.name ?? "").toUpperCase().includes(normalized))
        .map((ticker) => ({
          providerId: "cli-shot",
          symbol: ticker.metadata.ticker,
          name: ticker.metadata.name ?? ticker.metadata.ticker,
          exchange: ticker.metadata.exchange ?? "",
          currency: ticker.metadata.currency,
          type: "equity",
        })));
    },
    getArticleSummary() {
      return resolveShotWork(null);
    },
    getPriceHistory(ticker, exchange, range) {
      return trackShotWork(Promise.resolve().then(() => (
        clipPriceHistoryToRange(getFinancials(ticker, exchange).priceHistory ?? [], range)
      )));
    },
    getPriceHistoryForResolution(ticker, exchange, bufferRange) {
      return trackShotWork(Promise.resolve().then(() => (
        clipPriceHistoryToRange(getFinancials(ticker, exchange).priceHistory ?? [], bufferRange)
      )));
    },
    getChartResolutionSupport() {
      return resolveShotWork(SHOT_CHART_RESOLUTION_SUPPORT);
    },
    subscribeQuotes() {
      return () => {};
    },
  };
}

function installShotMarketData(payload: CliPaneShotPayload): void {
  const provider = createShotDataProvider(payload);
  shotDataProvider = provider;
  const coordinator = new MarketDataCoordinator(provider);
  coordinator.primeCachedFinancials(payload.tickers.flatMap((ticker) => {
    const instrument = instrumentFromTicker(ticker, ticker.metadata.ticker);
    const instrumentKey = instrument
      ? canonicalTickerKey(instrument.symbol, instrument.exchange)
      : normalizeSymbol(ticker.metadata.ticker);
    const financials = payload.financials.find(([key]) => {
      const candidate = parsePublicTickerKey(key);
      return canonicalTickerKey(candidate.symbol, candidate.exchange) === instrumentKey;
    })?.[1];
    return instrument && financials ? [{ instrument, financials }] : [];
  }));
  setSharedMarketDataForTests(provider);
  setSharedMarketDataCoordinator(coordinator);
}

/**
 * The screenshot renderer has no database and no Electrobun backend. Plugins
 * still need somewhere to read and write state while the render runs, so state
 * lives in memory for the lifetime of the page and the resource cache always
 * reports a miss instead of pretending something was persisted.
 */
function createShotPersistence(): AppPersistencePort {
  const pluginState = new Map<string, { value: unknown; schemaVersion: number; updatedAt: number }>();
  const stateKey = (pluginId: string, key: string) => `${pluginId}:${key}`;
  return {
    pluginState: {
      get: <T,>(pluginId: string, key: string, schemaVersion = 1) => {
        const record = pluginState.get(stateKey(pluginId, key));
        if (!record || record.schemaVersion !== schemaVersion) return null;
        return { value: record.value as T, schemaVersion: record.schemaVersion, updatedAt: record.updatedAt };
      },
      set: (pluginId: string, key: string, value: unknown, schemaVersion = 1) => {
        pluginState.set(stateKey(pluginId, key), { value, schemaVersion, updatedAt: Date.now() });
      },
      delete: (pluginId: string, key: string) => {
        pluginState.delete(stateKey(pluginId, key));
      },
      keys: (pluginId: string) => [...pluginState.keys()]
        .filter((entry) => entry.startsWith(`${pluginId}:`))
        .map((entry) => entry.slice(pluginId.length + 1))
        .sort(),
      clear: (pluginId: string) => {
        for (const entry of [...pluginState.keys()]) {
          if (entry.startsWith(`${pluginId}:`)) pluginState.delete(entry);
        }
      },
    },
    resources: {
      get: () => null,
      list: () => [],
      set: <T,>(key: ResourceCacheKey, value: T, options: SetResourceOptions): CachedResourceRecord<T> => {
        const fetchedAt = options.fetchedAt ?? Date.now();
        return {
          namespace: key.namespace,
          kind: key.kind,
          entityKey: key.entityKey,
          variantKey: key.variantKey ?? "",
          sourceKey: key.sourceKey ?? "",
          value,
          fetchedAt,
          staleAt: fetchedAt + options.cachePolicy.staleMs,
          expiresAt: fetchedAt + options.cachePolicy.expireMs,
          schemaVersion: options.schemaVersion ?? 1,
          provenance: options.provenance ?? null,
          lastAccessedAt: fetchedAt,
          sizeBytes: 0,
        };
      },
      delete: () => {},
    },
    sessions: {
      get: () => null,
      set: () => {},
      delete: () => {},
    },
    close() {},
  };
}

function createShotTickerRepository(tickers: TickerRecord[]): AppTickerRepositoryPort {
  const bySymbol = new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker]));
  return {
    loadAllTickers: async () => [...bySymbol.values()],
    loadTicker: async (symbol) => bySymbol.get(normalizeSymbol(symbol)) ?? bySymbol.get(symbol) ?? null,
    saveTicker: async () => {},
    createTicker: async (metadata) => ({ metadata }),
    deleteTicker: async () => {},
  };
}

/**
 * Screenshots render the same tree the desktop app renders, so they need the
 * same registry: plugin-contributed tabs, slots, shortcuts, context menus and
 * setup-registered panes all resolve through it. Only the capability surface is
 * replaced, because the offline render can answer chart series from the payload
 * but cannot reach a backend.
 */
async function installShotPluginRegistry(payload: CliPaneShotPayload): Promise<PluginRegistry> {
  const capabilitySeries = new Map(payload.capabilitySeries ?? []);
  const capabilityIds = [...new Set(payload.config.layout.instances.flatMap((instance) => {
    const chartSpec = instance.settings?.chartSpec;
    if (!chartSpec || typeof chartSpec !== "object" || !Array.isArray((chartSpec as any).series)) return [];
    return (chartSpec as any).series.flatMap((series: any) => (
      series?.source?.kind === "capability" && typeof series.source.capabilityId === "string"
        ? [series.source.capabilityId]
        : []
    ));
  }))];

  const registry = new PluginRegistry(
    shotDataProvider!,
    createShotTickerRepository(payload.tickers),
    createShotPersistence(),
    {
      enableCapabilityHandlers: false,
      connectionHealth: createCliPaneShotConnectionHealth(),
      remoteCapabilityManifests: () => capabilityIds.map((id) => ({
        id,
        kind: "chart-series",
        name: id,
        operations: [{ id: "resolve", kind: "query", rendererSafe: true }],
      })),
      remoteCapabilityInvoke: async <T,>(capabilityId: string, operationId: string, input: unknown) => {
        if (operationId !== "resolve" || !input || typeof input !== "object") {
          throw new Error(`Screenshot capability operation ${capabilityId}.${operationId} is unavailable.`);
        }
        const request = input as { seriesId?: string };
        const value = capabilitySeries.get(chartSeriesSourceKey({
          kind: "capability",
          capabilityId,
          seriesId: request.seriesId ?? "",
        }));
        if (!value) throw new Error(`No screenshot chart series data is available for ${request.seriesId ?? capabilityId}.`);
        return value as T;
      },
    },
  );
  registry.getConfigFn = () => payload.config;
  registry.getLayoutFn = () => payload.config.layout;
  registry.getPaneRuntimeStateFn = (paneId) => payload.paneState[paneId] ?? null;

  for (const plugin of getLoadablePlugins()) {
    try {
      await registry.register(plugin);
    } catch (error) {
      // One failing plugin must not cost the screenshot every other pane.
      console.error(`[shot] Plugin ${plugin.id} failed to register:`, error);
    }
  }
  shotRegistry = registry;
  return registry;
}

function findPaneDef(paneId: string): { pluginId: string; pane: PaneDef } | null {
  const pane = shotRegistry?.panes.get(paneId);
  return pane ? { pluginId: shotRegistry?.getPanePluginId(paneId) ?? "", pane } : null;
}

function HydratePayload({
  payload,
  children,
}: {
  payload: CliPaneShotPayload;
  children: ReactNode;
}) {
  const dispatch = useAppDispatch();

  useEffect(() => {
    dispatch({
      type: "SET_TICKERS",
      tickers: new Map(payload.tickers.map((ticker) => [ticker.metadata.ticker, ticker])),
    });
    dispatch({ type: "HYDRATE_FINANCIALS", financials: new Map(payload.financials) });
    dispatch({ type: "SET_INITIALIZED" });

    return waitForShotReadiness();
  }, [dispatch, payload]);

  return children;
}

function CaptureShotSemanticUi() {
  const registry = useRemoteUiRegistry();

  useEffect(() => {
    let frame = 0;
    const capture = () => {
      window.__GLOOM_CLI_SHOT_SEMANTIC_UI__ = registry?.snapshot() ?? [];
      frame = requestAnimationFrame(capture);
    };
    capture();
    return () => cancelAnimationFrame(frame);
  }, [registry]);

  return null;
}

function ShotPane({ payload }: { payload: CliPaneShotPayload }) {
  const instance = payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId);
  if (!instance) throw new Error(`Pane instance ${payload.paneId} is missing from the screenshot layout.`);

  const found = findPaneDef(instance.paneId);
  if (!found) throw new Error(`Pane ${instance.paneId} is not registered in the desktop renderer.`);

  // The registry already bound its runtime to this pane component.
  const pane = found.pane;
  const titleState = {
    config: payload.config,
    paneState: payload.paneState,
  } as Pick<AppState, "config" | "paneState">;
  const title = getPaneDisplayTitle(titleState, instance, pane, shotRegistry?.panes);
  const width = payload.widthCells;
  const height = payload.heightCells;
  const bodyFrame = resolvePaneBodyFrame({
    width,
    height,
    nativePaneChrome: true,
    reserveFooter: false,
  });

  return (
    <FloatingPaneWrapper
      paneId={instance.instanceId}
      title={title}
      x={0}
      y={0}
      width={width}
      height={height}
      zIndex={1}
      focused
      showActions={false}
      footer={null}
    >
      <PaneContent
        component={pane.component}
        paneId={instance.instanceId}
        paneType={instance.paneId}
        focused
        width={bodyFrame.width ?? 1}
        height={bodyFrame.height ?? 1}
      />
    </FloatingPaneWrapper>
  );
}

async function render() {
  const payload = window.__GLOOM_CLI_SHOT_PAYLOAD__;
  if (!payload) throw new Error("Missing CLI pane screenshot payload.");
  revivePayloadDates(payload);
  installShotFetchTracker();
  hydrateFredSeries(payload.fredSeries ?? []);
  hydrateValuationSeries(payload.valuationSeries ?? []);
  installShotMarketData(payload);
  // Panes contributed from an async setup() only exist once every plugin has
  // finished registering, so the tree cannot mount before that resolves.
  await installShotPluginRegistry(payload);

  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing root element.");

  createRoot(rootElement).render(
    <RemoteUiRegistryProvider>
      <CaptureShotSemanticUi />
      <UiHostProvider ui={webUiHost} renderer={rendererHost} nativeRenderer={webNativeRenderer}>
        <WebInputHostProvider>
          <WebToastHostProvider>
            <WebDialogHostProvider>
              <AppProvider config={payload.config} desktopSnapshot={{
                config: payload.config,
                paneState: payload.paneState,
                focusedPaneId: payload.paneId,
                activePanel: "right",
                statusBarVisible: false,
              }}>
                <HydratePayload payload={payload}>
                  <ShotPane payload={payload} />
                </HydratePayload>
              </AppProvider>
            </WebDialogHostProvider>
          </WebToastHostProvider>
        </WebInputHostProvider>
      </UiHostProvider>
    </RemoteUiRegistryProvider>,
  );
}

render().catch((error) => {
  window.__GLOOM_CLI_SHOT_ERROR__ = error instanceof Error ? error.stack ?? error.message : String(error);
  throw error;
});
