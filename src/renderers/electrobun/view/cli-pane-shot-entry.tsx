/** @jsxImportSource react */
import { createRoot } from "react-dom/client";
import { useEffect, type ComponentType, type ReactNode } from "react";
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
import { setSharedMarketDataForTests } from "../../../plugins/registry";
import { PluginRenderProvider, type PluginRuntimeAccess } from "../../../plugins/runtime";
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
import type { CachedFinancialsTarget, DataProvider, QuoteSubscriptionTarget } from "../../../types/data-provider";
import type { OptionsChain, TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { AppState, PaneRuntimeState } from "../../../core/state/app/state";
import type { PaneDef } from "../../../types/plugin";
import { canonicalTickerKey, parsePublicTickerKey } from "../../../utils/exchanges";
import { hydrateFredSeries, type FredSeriesCacheEntry } from "../../../data/fred-series";
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
const SHOT_LOADING_TEXT_PATTERN = /\b(Loading|Rendering pane)\b/i;
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
  return SHOT_LOADING_TEXT_PATTERN.test(document.body.textContent ?? "");
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
    getExchangeRate() {
      return resolveShotWork(1);
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

function createRuntime(payload: CliPaneShotPayload): PluginRuntimeAccess {
  const resumeState = new Map<string, unknown>();
  const connectionHealth = createCliPaneShotConnectionHealth();
  function getResumeState<T = unknown>(_pluginId: string, key: string): T | null {
    return (resumeState.get(key) as T | undefined) ?? null;
  }
  function getConfigState<T = unknown>(pluginId: string, key: string): T | null {
    return (payload.config.pluginConfig[pluginId]?.[key] as T | undefined) ?? null;
  }
  const capabilitySeries = new Map(payload.capabilitySeries ?? []);
  const capabilityIds = [...new Set([...capabilitySeries.keys()].map((key) => key.split("|", 1)[0]!).filter(Boolean))];
  return {
    getMarketData: () => shotDataProvider,
    getConnectionHealth: () => connectionHealth,
    getCapability: () => null,
    capabilityManifests: (kind) => kind && kind !== "chart-series" ? [] : capabilityIds.map((id) => ({
      id,
      kind: "chart-series",
      name: id,
      operations: [{ id: "resolve", kind: "query", rendererSafe: true }],
    })),
    invokeCapability: async <T,>(capabilityId: string, operationId: string, input: unknown) => {
      if (operationId !== "resolve" || !input || typeof input !== "object") {
        throw new Error(`Screenshot capability operation ${capabilityId}.${operationId} is unavailable.`);
      }
      const request = input as { seriesId?: string; parameters?: Record<string, any> };
      const value = capabilitySeries.get(chartSeriesSourceKey({
        kind: "capability",
        capabilityId,
        seriesId: request.seriesId ?? "",
        parameters: request.parameters,
      }));
      if (!value) throw new Error(`No screenshot chart series data is available for ${request.seriesId ?? capabilityId}.`);
      return value as T;
    },
    getBrokerAdapter: () => null,
    connectBrokerInstance: async () => {},
    updateBrokerInstance: async () => {},
    syncBrokerInstance: async () => {},
    removeBrokerInstance: async () => {},
    pinTicker: () => {},
    navigateTicker: () => {},
    selectTicker: () => {},
    switchTab: () => {},
    switchPanel: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    createPaneFromTemplate: () => {},
    hidePane: () => {},
    focusPane: () => {},
    openPaneSettings: () => {},
    openPluginCommandWorkflow: () => {},
    notify: () => {},
    subscribeResumeState: () => () => {},
    getResumeState,
    setResumeState: (_pluginId, key, value) => {
      resumeState.set(key, value);
    },
    deleteResumeState: (_pluginId, key) => {
      resumeState.delete(key);
    },
    getConfigState,
    setConfigState: async () => {},
    setConfigStates: async () => {},
    deleteConfigState: async () => {},
    getConfigStateKeys: (pluginId) => Object.keys(payload.config.pluginConfig[pluginId] ?? {}),
  };
}

function findPaneDef(paneId: string): { pluginId: string; pane: PaneDef } | null {
  for (const plugin of getLoadablePlugins()) {
    for (const pane of plugin.panes ?? []) {
      if (pane.id === paneId) return { pluginId: plugin.id, pane };
    }
  }
  return null;
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

  const runtime = createRuntime(payload);
  const PaneComponent = found.pane.component as ComponentType<any>;
  const pane: PaneDef = {
    ...found.pane,
    component: (props) => (
      <PluginRenderProvider pluginId={found.pluginId} runtime={runtime}>
        <PaneComponent {...props} />
      </PluginRenderProvider>
    ),
  };
  const titleState = {
    config: payload.config,
    paneState: payload.paneState,
  } as Pick<AppState, "config" | "paneState">;
  const title = getPaneDisplayTitle(titleState, instance, pane);
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

function render() {
  const payload = window.__GLOOM_CLI_SHOT_PAYLOAD__;
  if (!payload) throw new Error("Missing CLI pane screenshot payload.");
  installShotFetchTracker();
  hydrateFredSeries(payload.fredSeries ?? []);
  installShotMarketData(payload);

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

try {
  render();
} catch (error) {
  window.__GLOOM_CLI_SHOT_ERROR__ = error instanceof Error ? error.stack ?? error.message : String(error);
  throw error;
}
