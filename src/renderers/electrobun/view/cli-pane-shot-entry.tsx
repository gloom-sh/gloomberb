/** @jsxImportSource react */
import { createRoot } from "react-dom/client";
import { useEffect, useState, type ReactNode } from "react";
import { TapeClientContext } from "../../../plugins/builtin/time-sales/use-tape";
import { createSnapshotTapeClient } from "../../../plugins/builtin/time-sales/snapshot-client";
import { createSnapshotScannerClient, ScannerClientContext } from "../../../plugins/builtin/shared/scanner-capture";
import type { TapeSnapshot } from "../../../api-client/tape";
import { AppProvider, useAppDispatch } from "../../../state/app/context";
import { createCliPaneShotConnectionHealth } from "./cli-pane-shot-health";
import { changedThePage, createShotStabilityCheck, SHOT_MUTATION_OPTIONS } from "./cli-pane-shot-mutations";
import { ChartSnapshotContext } from "../../../time-series/hooks";
import { TableColumnFitContext } from "../../../components/ui/data-table/column-fit";
import { decodeRpcValue } from "../shared/rpc-codec";
import { createSnapshotDataProvider } from "../../../market-data/snapshot-provider";
import { TickerSnapshotLoadTracker } from "../../../market-data/hooks";
import { createAppRuntime } from "../../../core/app-runtime";
import { JsonPersistence } from "../../../data/json-persistence";
import { JsonTickerRepository } from "../../../data/json-ticker-repository";
import type { DesktopPaneShotPayload } from "../../../cli/desktop-pane-shot";
import {
  SHOT_API_PROXY_PREFIX,
  SHOT_API_SOCKET_PATH,
  SHOT_HTTP_BRIDGE_PATH,
  SHOT_MARKET_BRIDGE_PATH,
  shotRouteUrl,
} from "../../../cli/desktop-pane-shot-routes";
import { openShotApiSocket, type ShotApiSocketSend } from "./cli-pane-shot-socket";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { buildQuoteKey, instrumentFromQuoteTarget } from "../../../market-data/selectors";
import type { RendererHost } from "../../../ui/host";
import { DomHostProviders } from "../../dom/dom-host-providers";
import { webUiHost } from "./ui-host";
import { getLoadablePlugins } from "../../../plugins/catalog";
import { setCurrentPluginTarget } from "../../../plugins/current-target";
import type { LoadedExternalPlugin } from "../../../plugins/loader";
import type { PluginRegistry } from "../../../plugins/registry";
import { loadDesktopExternalPlugins } from "./external-plugins";
import {
  RemoteUiRegistryProvider,
  useRemoteUiRegistry,
} from "../../../remote/semantic-tree";
import type { RemoteUiNodeSnapshot } from "../../../remote/types";
import { PaneShotFrame } from "./cli-pane-shot-frame";
import { PaneContent } from "../../../components/layout/pane/content";
import { getPaneDisplayTitle } from "../../../components/layout/pane/title";
import type {
  DataProvider,
  EarningsEvent,
  QuoteBatchResult,
  SecFilingDocument,
  SecFilingItem,
  SecFilingsPage,
} from "../../../types/data-provider";
import type {
  AnalystResearchData,
  CorporateActionsData,
  HolderData,
  OptionsChain,
  PricePoint,
  Quote,
  QuoteMetadata,
  SplitHistory,
} from "../../../types/financials";
import type { NewsCapability } from "../../../capabilities/types";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import {
  createProxyResponse,
  toRequestEnvelope,
  type HttpProxyResponseEnvelope,
} from "../../../utils/http-proxy-response";
import type { AppState } from "../../../core/state/app/state";
import { canonicalTickerKey, parsePublicTickerKey } from "../../../utils/exchanges";
import { valuationCache } from "../../../plugins/builtin/market-valuation/cache";
import { statsCache } from "../../../plugins/builtin/econ-statistics/cache";
import { apiClient, setCloudApiFetchTransport } from "../../../api-client";
import { createGloomberbCloudCapabilities, createGloomberbCloudProvider } from "../../../sources/gloomberb-cloud";
import { logFailure } from "../../../utils/log-failure";
import { markSavedCopy, stampRetrievedAt } from "../../../data/saved-copies";

declare global {
  interface Window {
    __GLOOM_CLI_SHOT_PAYLOAD__?: DesktopPaneShotPayload;
    __GLOOM_CLI_SHOT_READY__?: boolean;
    __GLOOM_CLI_SHOT_PENDING__?: number;
    __GLOOM_CLI_SHOT_ERROR__?: string;
    __GLOOM_CLI_SHOT_SEMANTIC_UI__?: RemoteUiNodeSnapshot[];
    /** Redraws the pane this many cells tall and waits for it to settle again: a capture growing to fit its rows. */
    __GLOOM_CLI_SHOT_RESIZE__?: (heightCells: number) => void;
  }
}

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

/**
 * The page's own address, read once before anything can change it: the
 * server answers only inside the secret folder the page opened at.
 */
const SHOT_PAGE_URL = window.location.href;

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

function beginShotWork(): () => void {
  updatePendingShotWork(pendingShotWork + 1);
  let pending = true;
  return () => {
    if (!pending) return;
    pending = false;
    updatePendingShotWork(pendingShotWork - 1);
  };
}

function trackShotWork<T>(promise: Promise<T>): Promise<T> {
  return promise.finally(beginShotWork());
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

let shotApiSocket: Promise<ShotApiSocketSend | null> | null = null;

/** The page's one socket to the Bun server, opened at its first call; null when it does not open. */
function shotSocket(): Promise<ShotApiSocketSend | null> {
  shotApiSocket ??= openShotApiSocket(() => {
    const url = shotRouteUrl(SHOT_API_SOCKET_PATH, SHOT_PAGE_URL);
    url.protocol = "ws:";
    return new WebSocket(url);
  });
  return shotApiSocket;
}

function installShotCloudApiTransport(): void {
  apiClient.setCookieSessionMode(true);
  setCloudApiFetchTransport((url, init = {}) => {
    const upstream = new URL(url);
    const proxyUrl = shotRouteUrl(`${SHOT_API_PROXY_PREFIX}${upstream.pathname}`, SHOT_PAGE_URL);
    proxyUrl.search = upstream.search;
    const headers = new Headers(init.headers);
    // Bun owns the real session cookie. The browser only talks to the local
    // same-origin proxy and never receives or serializes the credential.
    headers.delete("Cookie");
    headers.delete("Origin");
    const viaFetch = () => window.fetch(proxyUrl, {
      ...init,
      headers,
      credentials: "same-origin",
    });
    if ((init.method ?? "GET").toUpperCase() !== "GET" || init.body != null) return viaFetch();
    return trackShotWork((async () => {
      const send = await shotSocket();
      return await send?.({ path: `${upstream.pathname}${upstream.search}`, headers: [...headers] }, init.signal) ?? await viaFetch();
    })());
  });
}

/**
 * External plugins can request third-party data through httpFetch. The preview
 * page sends those requests through its local Bun server, matching the desktop
 * renderer's native HTTP bridge and preserving upstream response cookies.
 */
function installShotHttpFetchTransport(): void {
  setHttpFetchTransport(async (url, init) => {
    const response = await window.fetch(shotRouteUrl(SHOT_HTTP_BRIDGE_PATH, SHOT_PAGE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await toRequestEnvelope(url, init)),
      // A pane's own deadline ends the read here as in the app, not when the Bun side gives up.
      signal: init?.signal ?? null,
    });
    const result = await response.json() as { ok: boolean; error?: string; data?: HttpProxyResponseEnvelope };
    if (!result.ok || !result.data) throw new Error(result.error ?? `Request failed: ${url}`);
    return createProxyResponse(result.data);
  });
}

async function restoreShotCloudSession(): Promise<void> {
  await apiClient.getSession().catch(logFailure("desktop-pane-shot", "Could not restore the session for a pane screenshot", null));
}

/**
 * Runs an asset-data request in the Bun process so the page sees exactly what
 * `gloom fn` sees. The page can only reach the cloud API on its own, and
 * the cloud is one source among several: analyst rating price targets and part
 * of the corporate action history come from providers the router merges in.
 */
async function requestShotMarketData<T>(operation: string, args: unknown[], signal?: AbortSignal): Promise<T> {
  return (await requestShotMarketReply<T>(operation, args, signal)).data as T;
}

/**
 * A dataset read through the bridge (holders, filings, analyst research,
 * corporate actions), marked as the Bun side served it: a copy saved earlier
 * that a failed refresh fell back to, or one read earlier and served again,
 * with the time it was saved or read. JSON keeps no marks, so the reply
 * carries the times; `revive` restores what else JSON loses first.
 */
async function requestShotDataset<T extends object>(operation: string, args: unknown[], revive: (value: T) => T = (value) => value): Promise<T> {
  const reply = await requestShotMarketReply<T>(operation, args);
  const data = revive(reply.data as T);
  if (typeof reply.savedAt === "number") return markSavedCopy(data, reply.savedAt);
  return typeof reply.retrievedAt === "number" ? stampRetrievedAt(data, reply.retrievedAt) : data;
}

async function requestShotMarketReply<T>(operation: string, args: unknown[], signal?: AbortSignal): Promise<{ data?: T; savedAt?: number; retrievedAt?: number }> {
  const viaFetch = () => window.fetch(shotRouteUrl(SHOT_MARKET_BRIDGE_PATH, SHOT_PAGE_URL), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, args }),
    // A board that stops waiting for a slow batch drops it, so the capture is not held for it.
    ...(signal ? { signal } : {}),
  });
  // Over the socket, the quotes a board asks for one at a time do not wait for the page's six connections.
  const response = await trackShotWork((async () => {
    const send = await shotSocket();
    return await send?.({ market: { operation, args } }, signal) ?? await viaFetch();
  })());
  const result = await response.json() as { ok: boolean; data?: T; error?: string; savedAt?: number; retrievedAt?: number };
  if (!result.ok) throw new Error(result.error ?? `Screenshot data request failed: ${operation}`);
  return result;
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

/**
 * A WebGL surface still being drawn: its first frame is not on the canvas, or
 * a refreshed mesh is mid-morph. A frame with no mesh counts as drawn, so an
 * empty sheet fails the capture's checks instead of holding it until timeout.
 */
function hasUndrawnSurface(): boolean {
  return document.querySelector(
    '[data-gloom-surface-renderer="webgl"]:not([data-gloom-surface-state="drawn"]):not([data-gloom-surface-state="blank"])',
  ) !== null;
}

/** A chart pane holds the capture by publishing `ready: false` on its chart-data node. */
function hasUnresolvedChartData(): boolean {
  return (window.__GLOOM_CLI_SHOT_SEMANTIC_UI__ ?? []).some((node) => (
    node.role === "chart-data" && node.metadata?.ready === false
  ));
}

function waitForShotReadiness(readTickerReport = false): () => void {
  let cancelled = false;
  let mutationVersion = 0;
  let lastSeenMutationVersion = 0;
  const stable = createShotStabilityCheck(readTickerReport);
  const observer = new MutationObserver((records) => {
    if (changedThePage(records)) mutationVersion += 1;
  });
  observer.observe(document.body, SHOT_MUTATION_OPTIONS);

  const check = (now: number) => {
    if (cancelled || window.__GLOOM_CLI_SHOT_READY__) return;
    const changedSinceLastFrame = mutationVersion !== lastSeenMutationVersion;
    lastSeenMutationVersion = mutationVersion;
    if (stable(now,
      pendingShotWork === 0
      && !isShotLoadingTextVisible()
      && !hasUnresolvedChartData()
      && !hasUndrawnSurface()
      && !changedSinceLastFrame
      && (!readTickerReport || document.fonts.status === "loaded"),
    )) {
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
  // The instruments a stream subscription has had its one frame for.
  const streamedQuotes = new Set<string>();
  const bridge: Partial<DataProvider> = {
    id: payload.marketDataProviderId ?? cloudProvider.id,
    getQuote: (symbol, exchange, context) => requestShotMarketData<Quote>("getQuote", [symbol, exchange, context]),
    getQuoteMetadata: (symbol, exchange, context) => requestShotMarketData<QuoteMetadata | null>("getQuoteMetadata", [symbol, exchange, context]),
    getQuotesBatch: (targets, options) => {
      const { signal, ...sent } = options ?? {};
      return requestShotMarketData<QuoteBatchResult[]>("getQuotesBatch", [targets, sent], signal)
        .catch(() => targets.map((target) => ({ target, quote: null })));
    },
    getOptionsChain: (symbol, exchange, expirationDate, context) => requestShotMarketData<OptionsChain>("getOptionsChain", [symbol, exchange, expirationDate, context]),
    getPriceHistory: (symbol, exchange, range, context) => requestShotMarketData<PricePoint[]>("getPriceHistory", [symbol, exchange, range, context])
      .then(revivePricePoints).catch(logFailure("desktop-pane-shot", "Could not load price history for a pane screenshot", [])),
    getPriceHistoryForResolution: (symbol, exchange, range, resolution, context) => requestShotMarketData<PricePoint[]>(
      "getPriceHistoryForResolution", [symbol, exchange, range, resolution, context],
    ).then(revivePricePoints),
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
    getAnalystResearch: (symbol, exchange) => requestShotDataset<AnalystResearchData>("getAnalystResearch", [symbol, exchange]),
    getCorporateActions: (symbol, exchange) => requestShotDataset<CorporateActionsData>("getCorporateActions", [symbol, exchange]),
    getSplitHistoryBatch: (symbols) => requestShotMarketData<Array<[string, SplitHistory | null]> | null>("getSplitHistoryBatch", [symbols])
      .then((answers) => answers ? new Map(answers) : null),
    getHolders: (symbol, exchange) => requestShotDataset<HolderData>("getHolders", [symbol, exchange]),
    getSecFilings: (symbol, count, exchange) => requestShotDataset<SecFilingItem[]>("getSecFilings", [symbol, count, exchange], reviveSecFilings),
    getSecFilingsPage: (symbol, query, exchange) => requestShotDataset<SecFilingsPage>("getSecFilingsPage", [symbol, query, exchange],
      (page) => ({ ...page, filings: reviveSecFilings(page.filings) })),
    // The page holds no session credential, so verified cloud reads such as
    // Form 4 content would fail as signed out if the page made them itself.
    getSecFilingDocuments: (filing) => requestShotMarketData<SecFilingDocument[]>("getSecFilingDocuments", [filing]),
    getSecFilingContent: (filing) => requestShotMarketData<string | null>("getSecFilingContent", [filing]),
    getEarningsCalendar: (symbols) => requestShotMarketData<EarningsEvent[]>("getEarningsCalendar", [symbols]).then(reviveEarningsEvents),
    subscribeQuotes: (targets, onQuote) => {
      // A capture has no stream. Each target gets the quote a poll reads, once,
      // so a pane that streams its rows (Market Movers with live on) shows them
      // as its user sees them, not as its list alone draws them.
      const fresh = targets.filter((target) => {
        const key = buildQuoteKey(instrumentFromQuoteTarget(target));
        if (streamedQuotes.has(key)) return false;
        streamedQuotes.add(key);
        return true;
      });
      if (fresh.length > 0) {
        void requestShotMarketData<QuoteBatchResult[]>("getQuotesBatch", [fresh, {}])
          .then((results) => results.forEach((result, index) => {
            const target = fresh[index];
            if (target && result?.quote) onQuote(target, result.quote);
          }))
          .catch(logFailure("desktop-pane-shot", "Could not load the quotes a pane streams for a screenshot"));
      }
      return () => {};
    },
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

function createShotAppServices(payload: DesktopPaneShotPayload, externalPlugins: LoadedExternalPlugin[]) {
  const dataProvider = createShotDataProvider(payload);
  const persistence = new JsonPersistence();
  for (const { pluginId, key, value } of payload.deviceState ?? []) persistence.pluginState.set(pluginId, key, value);
  return createAppRuntime({
    config: payload.config,
    plugins: getLoadablePlugins(externalPlugins),
    dataProvider,
    persistence,
    tickerRepository: new JsonTickerRepository(undefined, payload.tickers),
    registryOptions: {
      enableCapabilityHandlers: false,
      connectionHealth: createCliPaneShotConnectionHealth(),
      // A capture is a command: it draws the alerts it is given and checks none, so `gloom shot ALRT` sets nothing off.
      runtime: "command",
    },
    configure({ pluginRegistry, marketData, newsService }) {
      pluginRegistry.bindHost({ getPaneRuntimeState: (paneId) => payload.paneState[paneId] ?? null });
      // Capability handlers are off, so nothing registers a news source and
      // every news pane rendered its empty state. The desktop view registers
      // the cloud feed by hand for the same reason; the proxied session makes
      // it the same feed the signed-in app shows.
      for (const capability of createGloomberbCloudCapabilities()) {
        if (capability.kind === "news") newsService.register(capability as NewsCapability);
      }
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
    for (const [instanceId, accounts] of Object.entries(payload.brokerAccounts ?? {})) {
      dispatch({ type: "SET_BROKER_ACCOUNTS", instanceId, accounts });
    }
    dispatch({ type: "SET_INITIALIZED" });

    return waitForShotReadiness(payload.readTickerReport);
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
  const [height, setHeight] = useState(payload.heightCells);
  useEffect(() => {
    let cancelReadiness: (() => void) | null = null;
    window.__GLOOM_CLI_SHOT_RESIZE__ = (heightCells) => {
      window.__GLOOM_CLI_SHOT_READY__ = false;
      setHeight(heightCells);
      cancelReadiness?.();
      cancelReadiness = waitForShotReadiness();
    };
    return () => {
      cancelReadiness?.();
      delete window.__GLOOM_CLI_SHOT_RESIZE__;
    };
  }, []);
  // PORT keeps what its basket covers, so a capture never reads as the whole account.
  return (
    <PaneShotFrame paneId={instance.instanceId} title={title} width={width} height={height} statusLine={payload.statusLine === true} preserveStatus={["time-sales", "gpu", "hiring", "apps", "catalysts", "litigation", "perps", "members", "analytics"].includes(pane.id)}>
      {(bodyFrame) => <PaneContent
        component={pane.component}
        paneId={instance.instanceId}
        paneType={instance.paneId}
        title={title}
        focused
        width={bodyFrame.width ?? 1}
        height={bodyFrame.height ?? 1}
      />}
    </PaneShotFrame>
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
  valuationCache.hydrate(payload.valuationSeries ?? []);
  statsCache.hydrate(payload.statSeries ?? []);
  // This page is the desktop view's renderer, so installed plugins run here
  // the way they do in the app: compiled by the Bun process, evaluated from
  // the payload. A broken plugin is reported and skipped, not fatal.
  setCurrentPluginTarget("desktop");
  const externalPlugins = await loadDesktopExternalPlugins(payload.externalPlugins ?? []);
  const services = createShotAppServices(payload, externalPlugins);
  window.addEventListener("pagehide", () => services.destroy(), { once: true });
  // Panes contributed from an async setup() only exist once every plugin has
  // finished registering, so the tree cannot mount before that resolves.
  await services.ready;
  // Plugin setup hydrates its in-memory persistence and may reset apiClient.
  // Restore the proxied cloud session only after registration is complete.
  await restoreShotCloudSession();

  const tapeClient = createSnapshotTapeClient(payload.tapeSnapshots ?? [],
    (symbol, exchange) => requestShotMarketData<TapeSnapshot>("getCloudTape", [symbol, exchange]));
  const scannerClient = createSnapshotScannerClient(payload.scannerSnapshots ?? []);
  createRoot(rootElement).render(
    <TapeClientContext.Provider value={tapeClient}>
      <ScannerClientContext.Provider value={scannerClient}>
        <RemoteUiRegistryProvider>
          <CaptureShotSemanticUi />
          <DomHostProviders ui={webUiHost} renderer={rendererHost}>
            {/* The capture shows what the function asked for, a tab only Pro opens included. */}
            <AppProvider config={payload.config} paneStateChosen desktopSnapshot={{
              config: payload.config,
              paneState: payload.paneState,
              focusedPaneId: payload.paneId,
              statusBarVisible: false,
            }}>
              <HydratePayload payload={payload}>
                <ChartSnapshotContext.Provider value={payload.chartModel ?? null}>
                  <TickerSnapshotLoadTracker.Provider value={payload.readTickerReport ? beginShotWork : null}>
                    <TableColumnFitContext.Provider value={payload.everyColumn !== true}>
                      <ShotPane payload={payload} registry={services.pluginRegistry} />
                    </TableColumnFitContext.Provider>
                  </TickerSnapshotLoadTracker.Provider>
                </ChartSnapshotContext.Provider>
              </HydratePayload>
            </AppProvider>
          </DomHostProviders>
        </RemoteUiRegistryProvider>
      </ScannerClientContext.Provider>
    </TapeClientContext.Provider>,
  );
}

render().catch((error) => {
  window.__GLOOM_CLI_SHOT_ERROR__ = error instanceof Error ? error.stack ?? error.message : String(error);
  throw error;
});
