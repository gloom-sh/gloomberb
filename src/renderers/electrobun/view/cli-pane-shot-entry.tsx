/** @jsxImportSource react */
import { createRoot } from "react-dom/client";
import { useEffect, type ReactNode } from "react";
import { AppProvider, useAppDispatch } from "../../../state/app/context";
import { createCliPaneShotConnectionHealth } from "./cli-pane-shot-health";
import { ChartSnapshotContext } from "../../../time-series/hooks";
import { decodeRpcValue } from "./rpc-codec";
import { createSnapshotDataProvider } from "../../../market-data/snapshot-provider";
import { createAppRuntime } from "../../../core/app-runtime";
import { JsonPersistence } from "../../../data/json-persistence";
import { JsonTickerRepository } from "../../../data/json-ticker-repository";
import type { DesktopPaneShotPayload } from "../../../cli/desktop-pane-shot";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { UiHostProvider, type RendererHost } from "../../../ui/host";
import { WebInputHostProvider } from "./input-host";
import { WebDialogHostProvider } from "./dialog-host";
import { webNativeRenderer } from "./native-renderer";
import { WebToastHostProvider } from "./toast-host";
import { webUiHost } from "./ui-host";
import { getLoadablePlugins } from "../../../plugins/catalog";
import type { PluginRegistry } from "../../../plugins/registry";
import {
  RemoteUiRegistryProvider,
  useRemoteUiRegistry,
} from "../../../remote/semantic-tree";
import type { RemoteUiNodeSnapshot } from "../../../remote/types";
import { FloatingPaneWrapper } from "../../../components/layout/floating-pane";
import { PaneContent } from "../../../components/layout/pane/content";
import { resolvePaneBodyFrame } from "../../../components/layout/pane/sizing";
import { getPaneDisplayTitle } from "../../../components/layout/pane/title";
import type {
  DataProvider,
  EarningsEvent,
  QuoteBatchResult,
  SecFilingItem,
} from "../../../types/data-provider";
import type {
  AnalystResearchData,
  CorporateActionsData,
  HolderData,
  PricePoint,
  Quote,
} from "../../../types/financials";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import type { AppState } from "../../../core/state/app/state";
import { canonicalTickerKey, parsePublicTickerKey } from "../../../utils/exchanges";
import { hydrateValuationSeries } from "../../../plugins/builtin/market-valuation/cache";
import { statsCache } from "../../../plugins/builtin/econ-statistics/cache";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { createGloomberbCloudProvider } from "../../../sources/gloomberb-cloud";

declare global {
  interface Window {
    __GLOOM_CLI_SHOT_PAYLOAD__?: DesktopPaneShotPayload;
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
const SHOT_API_PROXY_PREFIX = "/__gloom_cli_api__";
// Served by the Bun process that owns this page, see src/cli/desktop-pane-shot.ts.
const SHOT_MARKET_BRIDGE_PATH = "/__gloom_cli_market__";
const SHOT_HTTP_BRIDGE_PATH = "/__gloom_cli_http__";
const TRACKED_RESPONSE_METHODS = new Set<PropertyKey>([
  "arrayBuffer",
  "blob",
  "formData",
  "json",
  "text",
]);

let pendingShotWork = 0;
let didInstallShotFetchTracker = false;
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

function installShotCloudApiTransport(): void {
  apiClient.setCookieSessionMode(true);
  setCloudApiFetchTransport((url, init = {}) => {
    const upstream = new URL(url);
    const proxyUrl = new URL(`${SHOT_API_PROXY_PREFIX}${upstream.pathname}`, window.location.origin);
    proxyUrl.search = upstream.search;
    const headers = new Headers(init.headers);
    // Bun owns the real session cookie. The browser only talks to the local
    // same-origin proxy and never receives or serializes the credential.
    headers.delete("Cookie");
    headers.delete("Origin");
    return window.fetch(proxyUrl, {
      ...init,
      headers,
      credentials: "same-origin",
    });
  });
}

/**
 * Panes such as DVD and SI call a third-party API through httpFetch. A browser
 * cannot do that cross-origin, so those requests died in CORS and the panes
 * reported the ticker as having no data. The desktop renderer proxies the same
 * calls through its native half; here the Bun process that serves this page
 * runs them and returns the response, cookies included so the Yahoo crumb
 * handshake still works.
 */
function installShotHttpFetchTransport(): void {
  setHttpFetchTransport(async (url, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const response = await window.fetch(SHOT_HTTP_BRIDGE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        method: init.method,
        headers,
        body: typeof init.body === "string" ? init.body : undefined,
      }),
    });
    const result = await response.json() as {
      ok: boolean;
      error?: string;
      data?: {
        status: number;
        statusText: string;
        headers: Record<string, string>;
        setCookie: string[];
        body: string;
      };
    };
    if (!result.ok || !result.data) throw new Error(result.error ?? `Request failed: ${url}`);
    return createShotHttpResponse(result.data);
  });
}

function createShotHttpResponse(payload: {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookie: string[];
  body: string;
}): Response {
  // Yahoo's crumb handshake reads set-cookie, which fetch hides from a page.
  const headers = new Headers(payload.headers);
  const originalGet = headers.get.bind(headers);
  headers.get = ((name: string) => (
    name.toLowerCase() === "set-cookie" ? payload.setCookie[0] ?? null : originalGet(name)
  )) as Headers["get"];
  (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie = () => [...payload.setCookie];
  const response = new Response(payload.body, {
    status: payload.status,
    statusText: payload.statusText,
  });
  Object.defineProperty(response, "headers", { value: headers, configurable: true });
  return response;
}

async function restoreShotCloudSession(): Promise<void> {
  await apiClient.getSession().catch(() => null);
}

/**
 * Runs an asset-data request in the Bun process so the page sees exactly what
 * `gloomberb fn` sees. The page can only reach the cloud API on its own, and
 * the cloud is one source among several: analyst rating price targets and part
 * of the corporate action history come from providers the router merges in.
 */
async function requestShotMarketData<T>(operation: string, args: unknown[]): Promise<T> {
  const response = await window.fetch(SHOT_MARKET_BRIDGE_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, args }),
  });
  const result = await response.json() as { ok: boolean; data?: T; error?: string };
  if (!result.ok) throw new Error(result.error ?? `Screenshot data request failed: ${operation}`);
  return result.data as T;
}

/** JSON has no Date, so every bridged date arrives as a string. */
function reviveDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function reviveSecFilings(filings: SecFilingItem[]): SecFilingItem[] {
  return filings.map((filing) => ({
    ...filing,
    filingDate: reviveDate(filing.filingDate) ?? new Date(0),
    ...(filing.acceptedAt ? { acceptedAt: reviveDate(filing.acceptedAt) } : {}),
  }));
}

function revivePricePoints(points: PricePoint[]): PricePoint[] {
  return points.map((point) => ({ ...point, date: reviveDate(point.date) ?? new Date(0) }));
}

function reviveEarningsEvents(events: EarningsEvent[]): EarningsEvent[] {
  return events.map((event) => ({
    ...event,
    earningsDate: reviveDate(event.earningsDate) ?? new Date(0),
    ...(event.earningsCallDate ? { earningsCallDate: reviveDate(event.earningsCallDate) ?? null } : {}),
  }));
}

function isShotLoadingTextVisible(): boolean {
  return document.querySelector(SHOT_LOADING_SELECTOR) !== null;
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

function createShotDataProvider(payload: DesktopPaneShotPayload): DataProvider {
  const cloudProvider = createGloomberbCloudProvider();
  const bridge: Partial<DataProvider> = {
    getQuote: (symbol, exchange) => requestShotMarketData<Quote>("getQuote", [symbol, exchange]),
    getQuotesBatch: (targets) => requestShotMarketData<QuoteBatchResult[]>("getQuotesBatch", [targets])
      .catch(() => targets.map((target) => ({ target, quote: null }))),
    getPriceHistory: (symbol, exchange, range) => requestShotMarketData<PricePoint[]>("getPriceHistory", [symbol, exchange, range])
      .then(revivePricePoints).catch(() => []),
    async getExchangeRate(fromCurrency) {
      // Only identity FX is known offline; don't invent a parity rate.
      if (normalizeSymbol(fromCurrency) === normalizeSymbol(payload.config.baseCurrency)) return 1;
      throw new Error(`No screenshot exchange rate available for ${fromCurrency}.`);
    },
    async search(query) {
      const normalized = normalizeSymbol(query);
      return payload.tickers
        .filter((ticker) => ticker.metadata.ticker.includes(normalized) || (ticker.metadata.name ?? "").toUpperCase().includes(normalized))
        .map((ticker) => ({
          providerId: "cli-shot",
          symbol: ticker.metadata.ticker,
          name: ticker.metadata.name ?? ticker.metadata.ticker,
          exchange: ticker.metadata.exchange ?? "",
          currency: ticker.metadata.currency,
          type: "equity",
        }));
    },
    getArticleSummary: async () => null,
    getAnalystResearch: (symbol, exchange) => requestShotMarketData<AnalystResearchData>("getAnalystResearch", [symbol, exchange]),
    getCorporateActions: (symbol, exchange) => requestShotMarketData<CorporateActionsData>("getCorporateActions", [symbol, exchange]),
    getHolders: (symbol, exchange) => requestShotMarketData<HolderData>("getHolders", [symbol, exchange]),
    getSecFilings: (symbol, count, exchange) => requestShotMarketData<SecFilingItem[]>("getSecFilings", [symbol, count, exchange]).then(reviveSecFilings),
    getEarningsCalendar: (symbols) => requestShotMarketData<EarningsEvent[]>("getEarningsCalendar", [symbols]).then(reviveEarningsEvents),
    subscribeQuotes: () => () => {},
  };
  const fallback = new Proxy(cloudProvider, {
    get(target, property) {
      const value = Reflect.get(bridge, property) ?? Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const provider = createSnapshotDataProvider(payload, fallback);
  return new Proxy(provider, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        return result instanceof Promise ? trackShotWork(result) : result;
      };
    },
  });
}

function createShotAppServices(payload: DesktopPaneShotPayload) {
  const dataProvider = createShotDataProvider(payload);
  return createAppRuntime({
    config: payload.config,
    plugins: getLoadablePlugins(),
    dataProvider,
    persistence: new JsonPersistence(),
    tickerRepository: new JsonTickerRepository(undefined, payload.tickers),
    registryOptions: {
      enableCapabilityHandlers: false,
      connectionHealth: createCliPaneShotConnectionHealth(),
    },
    configure({ pluginRegistry, marketData }) {
      pluginRegistry.getPaneRuntimeStateFn = (paneId) => payload.paneState[paneId] ?? null;
      marketData.primeCachedFinancials(payload.tickers.flatMap((ticker) => {
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
    },
    // One failing plugin must not cost the screenshot every other pane.
    onPluginError: (error, plugin) => console.error(`[shot] Plugin ${plugin.id} failed to register:`, error),
  });
}

function HydratePayload({
  payload,
  children,
}: {
  payload: DesktopPaneShotPayload;
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

function ShotPane({ payload, registry }: { payload: DesktopPaneShotPayload; registry: PluginRegistry }) {
  const instance = payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId);
  if (!instance) throw new Error(`Pane instance ${payload.paneId} is missing from the screenshot layout.`);

  const pane = registry.panes.get(instance.paneId);
  if (!pane) throw new Error(`Pane ${instance.paneId} is not registered in the desktop renderer.`);

  // The registry already bound its runtime to this pane component.
  const titleState = {
    config: payload.config,
    paneState: payload.paneState,
  } as Pick<AppState, "config" | "paneState">;
  const title = getPaneDisplayTitle(titleState, instance, pane, registry.panes);
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
  const payload = decodeRpcValue<DesktopPaneShotPayload | undefined>(window.__GLOOM_CLI_SHOT_PAYLOAD__);
  if (!payload) throw new Error("Missing CLI pane screenshot payload.");
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing root element.");
  installShotFetchTracker();
  installShotCloudApiTransport();
  installShotHttpFetchTransport();
  hydrateValuationSeries(payload.valuationSeries ?? []);
  statsCache.hydrate(payload.statSeries ?? []);
  const services = createShotAppServices(payload);
  window.addEventListener("pagehide", () => services.destroy(), { once: true });
  // Panes contributed from an async setup() only exist once every plugin has
  // finished registering, so the tree cannot mount before that resolves.
  await services.ready;
  // Plugin setup hydrates its in-memory persistence and may reset apiClient.
  // Restore the proxied cloud session only after registration is complete.
  await restoreShotCloudSession();

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
                  <ChartSnapshotContext.Provider value={payload.chartModel ?? null}>
                    <ShotPane payload={payload} registry={services.pluginRegistry} />
                  </ChartSnapshotContext.Provider>
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
