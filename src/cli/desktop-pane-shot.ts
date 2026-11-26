import type { ScannerCapture } from "../plugins/builtin/shared/scanner-capture";
import type { TapeCapture } from "../plugins/builtin/time-sales/snapshot-client";
import { randomBytes, timingSafeEqual } from "crypto";
import { join } from "path";
import { withShotTempDir } from "./shot-temp-dir";
import { encodeRpcValue } from "../renderers/electrobun/shared/rpc-codec";
import type { AppConfig } from "../types/config";
import type { ChartResolutionResult } from "../time-series/types";
import type { PricePoint, TickerFinancials } from "../types/financials";
import type { ManualChartResolution } from "../time-series/resolution";
import type { SnapshotMarketData } from "../market-data/snapshot-provider";
import type { InstrumentRef } from "../market-data/request-types";
import type { TickerRecord } from "../types/ticker";
import type { BrokerAccount } from "../types/trading";
import type { PaneRuntimeState } from "../core/state/app/state";
import type { RemoteUiNodeSnapshot } from "../remote/types";
import type { DatedObservation } from "../plugins/builtin/market-valuation/series";
import type { DesktopExternalPluginBundle } from "../renderers/electrobun/shared/protocol";
import type { HttpProxyRequestEnvelope, HttpProxyResponseEnvelope } from "../utils/http-proxy-response";
import type { PaneAccessGate } from "./pane-functions/access-gate";
import { countContentFigures } from "./content-figures";
import { retrievedAtOf, savedCopyAt, savedCopyShownAt } from "../data/saved-copies";
import { readVisibleKeyValues } from "./visible-key-values";
import { readRenderedTableRows } from "./rendered-table-rows";
import { rowViewportVisibility, scrollTruncationReasons } from "./scroll-truncation";
import {
  SHOT_API_PROXY_PREFIX,
  SHOT_API_SOCKET_PATH,
  SHOT_HTTP_BRIDGE_PATH,
  SHOT_MARKET_BRIDGE_PATH,
  type ShotApiSocketRead,
  type ShotApiSocketReply,
  type ShotMarketSocketCall,
} from "./desktop-pane-shot-routes";
import { SHOT_REQUEST_REFUSED } from "../api-client/errors";
import {
  dataServiceAnswerCount, dataServiceReachEpoch, dataServiceUnreachable, isProxyRefusal, MARKET_REQUEST_TIMEOUT_MS, noteDataServiceReach,
  SHOT_SERVICE_UNREACHABLE_HEADER, UNREACHABLE_REQUEST_TIMEOUT_MS,
} from "../api-client/request";
import type { FuturesContractTermsPayload } from "../api-client/futures-curve";
import { rememberFuturesContractTerms, savedFuturesContractTerms } from "../market-data/futures-contract";
import { DATA_SERVICE_UNREACHABLE_MESSAGE, isNetworkFailure } from "../utils/network-failure";
import { SESSION_COOKIE_NAMES } from "../api-client/session-cookie";
import { isShotApiRequestAllowed, isShotSessionPath } from "./desktop-pane-shot-api-policy";
import { renderElectrobunViewHtml } from "../renderers/dom/build-assets";
import { loadShotView, SHOT_VIEW_SCRIPT, SHOT_VIEW_STYLESHEET, type ShotViewFiles } from "./desktop-pane-shot-view";
import { errorMessage } from "../utils/errors";
import { openShotPage, type CdpPage } from "./desktop-pane-shot-browser";

export interface DesktopPaneShotIntradayHistory {
  target?: InstrumentRef;
  symbol: string;
  exchange: string;
  rangePreset: "1D" | "1W";
  resolution: ManualChartResolution;
  requestedSession: string | null;
  sessionDates: string[];
  points: PricePoint[];
  bufferedPoints?: PricePoint[];
  start: string | null;
  end: string | null;
  unavailableReason: string | null;
}

export interface DesktopPaneShotPayload {
  config: AppConfig;
  deviceState?: Array<{ pluginId: string; key: string; value: unknown }>;
  /** Identity of the host provider serving bridged market requests. */
  marketDataProviderId?: string;
  paneId: string;
  widthCells: number;
  heightCells: number;
  widthPx: number;
  heightPx: number;
  /** Chrome device scale factor; 2 keeps text crisp, higher values zoom the layout. */
  deviceScaleFactor?: number;
  /** Label drawn at the right edge of the pane title bar; null draws nothing. */
  watermark?: string | null;
  /**
   * The pane footer keeps a row for the capture's dated status line, filled
   * once the pane has loaded. Absent for `--no-status` and for reports.
   */
  statusLine?: boolean;
  /** A DES overview report tracks its deferred snapshot explicitly, rather than settling like a screenshot. */
  readTickerReport?: boolean;
  /**
   * A report reads every column of a table, the ones past its right edge
   * too: no table leaves a column out for width, as a picture's does
   * (`DataTableProps.columnDropOrder`).
   */
  everyColumn?: boolean;
  /**
   * The tallest the capture may grow, in cells, to show every row its tables
   * scroll past or all the text its reader scrolls past; absent keeps the
   * requested height (`--height`, most panes).
   */
  maxHeightCells?: number;
  /** The `data-gloom-role`s of the scrolling boxes the capture grows to fit; the tables' bodies when absent. */
  fitRoles?: string[];
  tickers: TickerRecord[];
  /** Broker accounts as last synced, by profile, so a broker portfolio shows its equity and cash. */
  brokerAccounts?: Record<string, BrokerAccount[]>;
  financials: Array<[string, TickerFinancials]>;
  valuationFx?: Array<{ currency: string; first: string; asOf: string; closes: Array<[string, number]> }>;
  instrumentFinancials?: SnapshotMarketData["instrumentFinancials"];
  historyVariants?: SnapshotMarketData["historyVariants"];
  intradayHistories: DesktopPaneShotIntradayHistory[];
  optionsChains: NonNullable<SnapshotMarketData["optionsChains"]>;
  tapeSnapshots?: TapeCapture[];
  /** What each scanner pane's feed answered the capture process, which the page replays since its own socket cannot ask. */
  scannerSnapshots?: ScannerCapture[];
  /** Rows of a list whose read failed: shown without figures, and named on the capture's status line. */
  unreadRows?: string[];
  /** Why each of `unreadRows` did not load, as the source answered. */
  unreadReasons?: Record<string, string>;
  valuationSeries: Array<[string, DatedObservation[]]>;
  statSeries: Array<[string, DatedObservation[]]>;
  chartModel?: ChartResolutionResult;
  paneState: Record<string, PaneRuntimeState>;
  /**
   * Installed plugins compiled for the browser, the same way the desktop view
   * receives them. Without these a pane from the plugins folder resolves in
   * the CLI but is unknown to the page that renders it.
   */
  externalPlugins?: DesktopExternalPluginBundle[];
}

/** Kept in Bun memory and never serialized into the browser page or CLI result. */
export interface DesktopPaneShotApiProxy {
  baseUrl: string;
  sessionToken: string | null;
  /**
   * Called with when a copy was saved (ms) each time the proxy answers a
   * read the data service did not answer from a copy saved earlier, so the
   * report dates what it shows as saved (`SHOT_SAVED_COPY_READS`).
   */
  onSavedCopy?: (savedAt: number) => void;
}

/**
 * The reads the proxy keeps a copy of and answers from it when the data
 * service does not answer: a futures symbol's contract terms, which a pane's
 * settle line and Contract block are drawn from beside the bridged quote's
 * saved copy. Offline, DES GC=F kept the saved price and lost both.
 */
const SHOT_SAVED_COPY_READS: ReadonlyArray<{
  path: RegExp;
  save(key: string, body: unknown): void;
  read(key: string): { value: unknown; savedAt: number } | null;
}> = [{
  path: /^\/cloud\/futures\/contract\/([^/?#]+)$/,
  save: (symbol, body) => rememberFuturesContractTerms(symbol, body as FuturesContractTermsPayload),
  read: (symbol) => {
    const saved = savedFuturesContractTerms(symbol);
    return saved && { value: saved.terms, savedAt: saved.savedAt };
  },
}];

/** The kept read a GET path is, with its key (the symbol), or null. */
function savedCopyRead(method: string, path: string): { read: typeof SHOT_SAVED_COPY_READS[number]; key: string } | null {
  if (method !== "GET") return null;
  for (const read of SHOT_SAVED_COPY_READS) {
    const match = read.path.exec(path);
    if (!match?.[1]) continue;
    try {
      return { read, key: decodeURIComponent(match[1]) };
    } catch {
      // Intentional ignore: a symbol whose percent-encoding is malformed names no kept copy, so the read goes out as sent.
      return null;
    }
  }
  return null;
}

/**
 * The page renders panes that fetch their own data. Left alone it can only
 * reach the cloud API, so a pane whose values come from a provider the router
 * merges in (analyst price targets, cash dividends) rendered thinner than the
 * same pane in the terminal. The bridge lets the page ask the Bun process to
 * run those requests through the real provider router instead.
 */
export interface DesktopPaneShotBridge {
  marketData(operation: string, args: unknown[]): Promise<unknown>;
  /** `signal` ends the read when the page gives up on it (its own deadline), so it holds nothing past that. */
  httpFetch(request: HttpProxyRequestEnvelope, signal?: AbortSignal): Promise<HttpProxyResponseEnvelope>;
}

interface DesktopPaneShotRenderedCell {
  /**
   * The cell can be blank with nothing missing: its whole column can
   * (DataTableColumn.mayBeBlank), or its row owes no value here
   * (DataTableCell.mayBeBlank). A strict capture leaves it out of a blank
   * column's count whatever its text.
   */
  mayBeBlank?: true;
  columnId?: string;
  columnLabel: string;
  text: string;
  /** The ISO instant behind a cell whose text shortens a time ("Wed 11:27"), from the table cell's export value. */
  instant?: string;
  /** The full-precision number behind a cell whose text rounds it (a trade of -9.4596), from the same export value. */
  value?: number;
  /** A column only the JSON and CSV carry (DataTable `reportColumns`): the text report leaves it out. Only in `reportRows`. */
  reportOnly?: true;
}

export interface DesktopPaneShotRenderedRow {
  tableIndex: number;
  rowIndex: number;
  key?: string;
  selected: boolean;
  /** A section header the table reports among its rows (FUT's sector); only in `reportRows`. */
  section?: true;
  cells: DesktopPaneShotRenderedCell[];
}

interface DesktopPaneShotSurface {
  renderer: string;
  state: string;
}

export interface DesktopPaneShotRenderResult {
  visibleText: string;
  /**
   * What the visible text fields hold (OVME's Underlying, a search box), which
   * `visibleText` leaves out: an input's value is not its text. A password
   * field is never read. Absent when no field holds anything.
   */
  fieldValues?: string[];
  /**
   * The visible text a line per block of the page, as the browser lays it out,
   * where `visibleText` has run them together: the words of a pane that is prose
   * and not a table, to be read as paragraphs. Absent in a capture that did not read it.
   */
  visibleLines?: string[];
  /**
   * The rows a report reads, when a table reports every row (an option chain's
   * strike window) rather than those in the viewport; `rows` stays what the
   * capture shows. Absent when every table is read from the viewport.
   */
  reportRows?: DesktopPaneShotRenderedRow[];
  /**
   * The rows each visible table holds, by `tableIndex`, drawn or not (the
   * table's `rowCount`); null for a table that does not say. With `rows`, what
   * a capture that cuts a list says it shows: "36 of 76 rows".
   */
  tableRowTotals?: Array<number | null>;
  /** `truncationReasons` without the cuts of tables whose every row is in `reportRows`. */
  reportTruncationReasons?: string[];
  /** Text of the pane footers, where a pane says whether its data is live, delayed or stale. */
  footerText?: string;
  /** How each 3D surface in the view was drawn: `webgl`, `software` (a CPU raster) or `grid` (the 2D stand-in), and its last frame's state. */
  surfaces?: DesktopPaneShotSurface[];
  visibleKeyValues?: Array<{ label: string; text: string }>;
  rows: DesktopPaneShotRenderedRow[];
  truncated: boolean;
  truncationReasons: string[];
  loadingStateDetected: boolean;
  errorStateDetected: boolean;
  errorStateMarkers: string[];
  emptyStateDetected: boolean;
  emptyStateMarkers: string[];
  /**
   * The words of the one empty or failed state a pane body shows with
   * nothing else but its chrome (query bar, tabs, a table's header): its
   * title, message and hint, a line each, without its buttons. Absent when
   * the body shows anything more.
   */
  emptyStateText?: string[];
  /**
   * What each visible error and empty state says, its title and message
   * without its buttons, a line each: the words a `--strict` Reason quotes.
   * Absent when no state shows, or in a capture that did not read them.
   */
  stateText?: { error?: string[]; empty?: string[] };
  /**
   * The headers of the table columns the capture cut: drawn past the edge of
   * their table's viewport (a table too wide for the pane scrolls sideways),
   * whole or in part. Absent when none is, or in a capture that did not read them.
   */
  cutColumns?: string[];
  /** A wall that needs an account, or a Pro lock on part of the pane. */
  accessGate?: PaneAccessGate | null;
  signInGate?: "verify-email" | "pro" | "free";
  /**
   * The blocks of text with a figure in them that the pane's body shows
   * outside its controls, chrome, notices, charts and labels
   * (`countContentFigures`): what a pane that marks no rows (DIAG's prose,
   * CORR's matrix) is read by. Absent in a capture that did not count them.
   */
  contentFigures?: number;
  semanticUi: RemoteUiNodeSnapshot[];
  /** The status line drawn in the capture's footer, as it fit the width. */
  statusLine?: string | null;
  statusLineClipped?: boolean;
}

/**
 * The status line variants for a capture, longest first, worked out from what
 * the pane rendered; null gives the footer row back to the pane, for a capture
 * with nothing loaded to date (a wall, an empty state). `dates` says what the
 * line dates (`CaptureStatusLine`): the pane's own data, whose `as of` text is
 * then left out rather than repeat the date, or the quotes on screen.
 */
interface ShotStatusLineVariants {
  variants: readonly string[];
  dates?: "data" | "quotes" | null;
  dateEvidence?: readonly (readonly string[])[];
  /** The view dates its data in its own footer, which the capture keeps beside the line. */
  ownStatus?: boolean;
}
type ShotStatusLine = (rendered: DesktopPaneShotRenderResult) => ShotStatusLineVariants | null | Promise<ShotStatusLineVariants | null>;

export function shotStatusDateClipped(line: ShotStatusLineVariants | null, statusText: string | null): boolean {
  if (line?.dates == null || line.variants.includes(statusText ?? "")) return false;
  const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  const shown = normalize(statusText ?? "");
  return !line.dateEvidence?.some((parts) => parts.length > 0 && parts.every((part) => shown.includes(normalize(part))));
}

const SHOT_MODE_CSS = [
  "[data-gloom-role='composite-chart-toolbar']",
  "[data-gloom-role='chart-series-quick-add']",
  "[data-gloom-role='pane-close']",
  "[data-gloom-role='resize-handle']",
].join(", ") + " { display: none !important; }\n"
  // The pane fills the viewport and has rounded corners. With the page painted
  // in the theme background, the PNG carried square theme-coloured corners
  // that showed on any other backdrop; a transparent page keeps only the pane.
  + "html, body, #root { background: transparent !important; }\n"
  + "[data-gloom-role='pane-window'][data-floating='true'] { box-shadow: none !important; }\n"
  // Sits where the hidden close button was: one cell high, right-aligned in the title bar.
  + "[data-gloom-role='shot-watermark'] { position: fixed; top: 1px; right: 10px; height: var(--cell-h);"
  + " line-height: var(--cell-h); font-size: 12px; letter-spacing: 0.02em; color: var(--gloom-text-dim, #888);"
  + " pointer-events: none; z-index: 1000; }";

const SHOT_READY_TIMEOUT_MS = 45_000;
const DEFAULT_DEVICE_SCALE_FACTOR = 2;

/**
 * Starts building the capture's page while its data is read: the build is
 * the same for every capture, and `renderDesktopPaneScreenshot` waits on it.
 * A build that fails is retried there, and reported.
 */
export function prepareDesktopPaneShotView(): void {
  loadShotView().catch(() => { /* Intentional ignore: the render loads the view again and reports its failure. */ });
}

export async function renderDesktopPaneScreenshot(
  payload: DesktopPaneShotPayload,
  apiProxy: DesktopPaneShotApiProxy,
  options: { captureImage?: boolean; bridge?: DesktopPaneShotBridge; statusLine?: ShotStatusLine } = {},
): Promise<DesktopPaneShotRenderResult & { image?: Uint8Array }> {
  const view = await loadShotView();
  return withShotTempDir("gloom-pane-shot-", async (tempDir) => {
    const server = serveShotPage(view, shotPageHtml(view, payload), apiProxy, options.bridge ?? null);
    try {
      return await capturePageScreenshot({
        url: server.url,
        widthPx: payload.widthPx,
        heightPx: payload.heightPx,
        deviceScaleFactor: payload.deviceScaleFactor ?? DEFAULT_DEVICE_SCALE_FACTOR,
        userDataDir: join(tempDir, "chrome-profile"),
        captureImage: options.captureImage !== false,
        readTickerReport: payload.readTickerReport,
        statusLine: payload.statusLine ? options.statusLine : undefined,
        ...(payload.maxHeightCells ? {
          fitRows: {
            heightCells: payload.heightCells,
            maxHeightCells: payload.maxHeightCells,
            roles: payload.fitRoles ?? ["data-table-body-scroll"],
          },
        } : {}),
      });
    } finally {
      server.stop();
    }
  });
}

/** The page for one capture: the shared view, with this capture's pane and data in its bootstrap script. */
function shotPageHtml(view: ShotViewFiles, payload: DesktopPaneShotPayload): string {
  const payloadJson = JSON.stringify(encodeRpcValue(payload)).replace(/</g, "\\u003c");
  return renderElectrobunViewHtml({
    stylesheet: view.get(SHOT_VIEW_STYLESHEET) ?? "",
    entrySrc: `./${SHOT_VIEW_SCRIPT}`,
    title: "Gloom Pane Shot",
    loadingText: "Rendering pane...",
    bootstrapScript: `
      window.__GLOOM_CLI_SHOT_PAYLOAD__ = ${payloadJson};
      (() => {
        // A screenshot cannot be interacted with, so drawing tools, the
        // quick-add input and the close button only add noise to the image.
        const style = document.createElement("style");
        style.textContent = ${JSON.stringify(SHOT_MODE_CSS)};
        document.head.appendChild(style);
        // Same brand mark charts show for in-app pane captures and OS screenshots.
        document.documentElement.setAttribute("data-gloom-screenshot", "true");
        const watermark = ${JSON.stringify(payload.watermark ?? null)};
        if (watermark) {
          const mark = document.createElement("div");
          mark.setAttribute("data-gloom-role", "shot-watermark");
          mark.textContent = watermark;
          document.addEventListener("DOMContentLoaded", () => document.body.appendChild(mark));
        }
      })();
      window.addEventListener("error", (event) => {
        window.__GLOOM_CLI_SHOT_ERROR__ = event.error && event.error.stack ? event.error.stack : String(event.error || event.message);
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__GLOOM_CLI_SHOT_ERROR__ = event.reason && event.reason.stack ? event.reason.stack : String(event.reason);
      });
`,
  });
}

/** A capture's page server: `url` is the page Chrome opens, the only way in. */
export interface ShotServer {
  url: string;
  stop(): void;
}

/**
 * The route a request to the shot server asks for, or null when it is not
 * the capture's own page asking. Any program on this machine and any website
 * open in the user's browser can reach the port, and behind it are the
 * capture's data, reads made with the user's session and fetches made from
 * this machine. So every request must name the server as `127.0.0.1:<port>`
 * (a website that rebinds its own name to this address sends its own name),
 * come from no other origin, and start its path with the secret folder the
 * page was opened at, which nothing but Chrome is given.
 */
function shotRequestRoute(request: Request, port: number | undefined, secret: string): URL | null {
  if (port === undefined) return null;
  const origin = `http://127.0.0.1:${port}`;
  if (request.headers.get("host") !== `127.0.0.1:${port}`) return null;
  const sentFrom = request.headers.get("origin");
  if (sentFrom !== null && sentFrom !== origin) return null;
  const url = new URL(request.url);
  const folder = `/${secret}/`;
  const given = Buffer.from(url.pathname.slice(0, folder.length));
  const expected = Buffer.from(folder);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const route = new URL(url);
  route.pathname = url.pathname.slice(folder.length - 1);
  return route;
}

/**
 * Serves one capture's page under a secret folder made for this run (see
 * `shotRequestRoute`). The page reaches its API proxy, socket and bridges by
 * paths relative to that folder.
 */
export function serveShotPage(
  view: ShotViewFiles,
  html: string,
  apiProxy: DesktopPaneShotApiProxy,
  bridge: DesktopPaneShotBridge | null,
): ShotServer {
  const secret = randomBytes(32).toString("hex");
  // Every read the page has the proxy make ends when the capture does, answered or not: a read through a proxy that
  // never answers must not hold the command's process open after its report is printed.
  const upstream = new AbortController();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    fetch(request, server) {
      const url = shotRequestRoute(request, server.port, secret);
      if (!url) return new Response("Forbidden", { status: 403 });
      if (url.pathname === SHOT_API_SOCKET_PATH) {
        // A browser always sends a socket's origin; only the page's own gets here.
        if (request.headers.get("origin") === null) return new Response("Forbidden", { status: 403 });
        return server.upgrade(request, { data: undefined }) ? undefined : new Response("Expected a WebSocket upgrade", { status: 426 });
      }
      if (url.pathname.startsWith(`${SHOT_API_PROXY_PREFIX}/`)) {
        // Also given up when the page stops waiting for it.
        return proxyShotApiRequest(request, url, apiProxy, AbortSignal.any([request.signal, upstream.signal]));
      }
      if (url.pathname === SHOT_MARKET_BRIDGE_PATH || url.pathname === SHOT_HTTP_BRIDGE_PATH) {
        if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
        return url.pathname === SHOT_MARKET_BRIDGE_PATH ? runShotMarketBridge(request, bridge) : runShotHttpBridge(request, bridge);
      }
      if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      return serveShotAsset(url, view, html);
    },
    websocket: {
      message(socket, message) {
        void answerShotApiCall(String(message), apiProxy, bridge, upstream.signal).then((reply) => replyOverShotSocket(socket, reply));
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/${secret}/`,
    stop: () => {
      upstream.abort();
      return server.stop(true);
    },
  };
}

/**
 * Sends a call's reply to the page. A socket that drops it (Bun's send gives
 * 0: the socket closed, or its buffer is past the limit) is closed, so the
 * read waiting for it, and every read after it, is made over HTTP instead of
 * holding the capture until it times out.
 */
export function replyOverShotSocket(socket: { send(data: string): number; close(): void }, reply: string): void {
  if (socket.send(reply) === 0) socket.close();
}

/**
 * One call the page sent over its API socket (`SHOT_API_SOCKET_PATH`): a read
 * made as the proxy makes it, with the session the page never holds, or an
 * asset-data operation answered as the market bridge answers it. The reply's
 * JSON, its body in base64. A call that is neither answers why.
 */
export async function answerShotApiCall(
  message: string,
  apiProxy: DesktopPaneShotApiProxy,
  bridge: DesktopPaneShotBridge | null = null,
  signal?: AbortSignal,
): Promise<string> {
  let id = 0;
  try {
    const call = JSON.parse(message) as Partial<ShotApiSocketRead & ShotMarketSocketCall>;
    id = typeof call.id === "number" ? call.id : 0;
    let response: Response;
    if (call.market && typeof call.market === "object") {
      response = await answerShotMarketCall(call.market, bridge);
    } else {
      if (typeof call.path !== "string" || !call.path.startsWith("/") || call.path.startsWith("//")) throw new Error("Not an API path.");
      const url = new URL(`${SHOT_API_PROXY_PREFIX}${call.path}`, "http://127.0.0.1");
      const sent = new Headers(Array.isArray(call.headers) ? call.headers : []);
      response = await proxyShotApiRequest(new Request(url, { headers: sent }), url, apiProxy, signal);
    }
    const body = Buffer.from(await response.arrayBuffer()).toString("base64");
    const headers: Array<[string, string]> = [];
    response.headers.forEach((value, name) => headers.push([name, value]));
    const reply: ShotApiSocketReply = { id, status: response.status, statusText: response.statusText, headers, body };
    return JSON.stringify(reply);
  } catch (error) {
    const reply: ShotApiSocketReply = { id, error: errorMessage(error) };
    return JSON.stringify(reply);
  }
}

async function runShotMarketBridge(
  request: Request,
  bridge: DesktopPaneShotBridge | null,
): Promise<Response> {
  if (!bridge) return Response.json({ ok: false, error: "No market bridge" }, { status: 404 });
  let payload: { operation?: unknown; args?: unknown };
  try {
    payload = await request.json() as typeof payload;
  } catch (error) {
    return Response.json({ ok: false, error: errorMessage(error) });
  }
  return answerShotMarketCall(payload, bridge);
}

/** One asset-data operation run through the bridge, posted (`SHOT_MARKET_BRIDGE_PATH`) or sent over the socket. */
async function answerShotMarketCall(
  payload: { operation?: unknown; args?: unknown },
  bridge: DesktopPaneShotBridge | null,
): Promise<Response> {
  if (!bridge) return Response.json({ ok: false, error: "No market bridge" }, { status: 404 });
  try {
    const operation = typeof payload.operation === "string" ? payload.operation : "";
    const args = Array.isArray(payload.args) ? payload.args : [];
    const data = await bridge.marketData(operation, args);
    // JSON drops the marks of a copy served again: the page is told when it was saved or read, and marks it back.
    const savedAt = savedCopyAt(data) ?? savedCopyShownAt(data);
    const retrievedAt = savedAt == null ? retrievedAtOf(data) : null;
    return Response.json({ ok: true, data, ...(savedAt != null ? { savedAt } : {}), ...(retrievedAt != null ? { retrievedAt } : {}) });
  } catch (error) {
    return Response.json({ ok: false, error: errorMessage(error) });
  }
}

async function runShotHttpBridge(
  request: Request,
  bridge: DesktopPaneShotBridge | null,
): Promise<Response> {
  if (!bridge) return Response.json({ ok: false, error: "No HTTP bridge" }, { status: 404 });
  try {
    const payload = await request.json() as HttpProxyRequestEnvelope;
    const data = await bridge.httpFetch(payload, request.signal);
    return Response.json({ ok: true, data });
  } catch (error) {
    return Response.json({ ok: false, error: errorMessage(error) });
  }
}

function serveShotAsset(url: URL, view: ShotViewFiles, html: string): Response {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (pathname === "/" || pathname === "/index.html") {
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const path = pathname.replace(/^\/+/, "");
  const body = view.get(path);
  if (body === undefined) return new Response("Not found", { status: 404 });
  // A module script is only run when served as JavaScript.
  const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/plain";
  return new Response(body, { headers: { "Content-Type": `${type}; charset=utf-8` } });
}

/**
 * The request headers the proxy passes on: what the page accepts and sends, a
 * cached copy's validators and the client's feature list. Everything else is
 * the proxy's to set (the session cookie, the API's origin) or nobody's: a
 * client address, a method override, a key.
 */
const SHOT_API_REQUEST_HEADERS = ["accept", "accept-language", "content-type", "if-modified-since", "if-none-match", "x-gloom-features"];
/** Response headers that belong to the API's own origin, not the page's. */
const SHOT_API_DROPPED_RESPONSE_HEADERS = [
  "access-control-allow-credentials",
  "access-control-allow-origin",
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
];
const SHOT_API_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SHOT_API_MAX_REDIRECTS = 5;

function shotApiError(message: string, status: number): Response {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Sends one of the page's API requests with the user's session, if the page
 * may send it (`isShotApiRequestAllowed`). A redirect is followed only within
 * the API, to a path the page may ask for too.
 */
async function proxyShotApiRequest(
  request: Request,
  requestUrl: URL,
  apiProxy: DesktopPaneShotApiProxy,
  signal?: AbortSignal,
): Promise<Response> {
  // The command this read is for, which records what it came to.
  const epoch = dataServiceReachEpoch();
  const baseUrl = new URL(apiProxy.baseUrl);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  let path = requestUrl.pathname.slice(SHOT_API_PROXY_PREFIX.length) || "/";
  let method = request.method.toUpperCase();
  if (!isShotApiRequestAllowed(method, path)) return shotApiError(SHOT_REQUEST_REFUSED, 403);
  const headers = new Headers();
  for (const name of SHOT_API_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  headers.set("Origin", baseUrl.origin);
  if (apiProxy.sessionToken) {
    headers.set(
      "Cookie",
      SESSION_COOKIE_NAMES.map((name) => `${name}=${apiProxy.sessionToken}`).join("; "),
    );
  }
  let target = new URL(baseUrl);
  target.pathname = `${basePath}${path}`;
  target.search = requestUrl.search;
  target.hash = "";
  const kept = requestUrl.search ? null : savedCopyRead(method, path);
  // Not reached: a kept read answers from its saved copy, dated as saved; any other is told the service was not reached.
  const savedAnswer = () => {
    const saved = kept?.read.read(kept.key);
    if (!saved) return null;
    noteDataServiceReach(false, epoch);
    apiProxy.onSavedCopy?.(saved.savedAt);
    return Response.json(saved.value, { headers: { "Cache-Control": "no-store" } });
  };
  const unreachable = () => savedAnswer() ?? shotApiUnreachable(epoch);
  // Once a read of this command went unanswered, a kept read is its saved copy at once: the page, which knows the
  // service is down too, waits no longer for it than the proxy would for the network.
  if (kept && dataServiceUnreachable()) {
    const saved = savedAnswer();
    if (saved) return saved;
  }
  // As the client's own requests wait (`deadlineFor`): ten seconds for the service to answer anything, three once a
  // read of this command went unanswered. A hung connection was otherwise held until the page gave up, or to the end.
  const answerMs = dataServiceUnreachable() ? UNREACHABLE_REQUEST_TIMEOUT_MS : MARKET_REQUEST_TIMEOUT_MS;
  const answersAtStart = dataServiceAnswerCount();
  const cut = new AbortController();
  const abortFromPage = () => cut.abort(signal?.reason);
  if (signal?.aborted) abortFromPage();
  else signal?.addEventListener("abort", abortFromPage, { once: true });
  let cutOff = false;
  const deadline = setTimeout(function giveUp() {
    // Another read answered meanwhile: the service is up and this one is slow, not cut off.
    if (dataServiceAnswerCount() > answersAtStart) return;
    cutOff = true;
    cut.abort(new Error("The data service sent nothing back"));
  }, answerMs);

  try {
    let body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
    for (let followed = 0; ; followed += 1) {
      const response = await fetch(target, { method, headers, body, redirect: "manual", signal: cut.signal });
      clearTimeout(deadline);
      // The proxy in HTTPS_PROXY refusing to reach the service answers for it: the page is told the service was not reached.
      if (isProxyRefusal(target.href, response)) {
        await response.body?.cancel().catch(() => { /* Intentional ignore: the refusal's own body is never read. */ });
        return unreachable();
      }
      noteDataServiceReach(true, epoch);
      const location = SHOT_API_REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
      if (location === null) return kept && response.ok ? await keptResponse(response, kept) : await shotApiResponse(response, path);
      await response.body?.cancel().catch(() => { /* Intentional ignore: a redirect's own body is never read, only dropped. */ });
      if (followed >= SHOT_API_MAX_REDIRECTS) return shotApiError("Cloud API redirected too many times.", 502);
      const next = new URL(location, target);
      if (
        (response.status === 303 && method !== "GET" && method !== "HEAD")
        || ((response.status === 301 || response.status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers.delete("content-type");
      }
      const inApi = next.origin === baseUrl.origin && (next.pathname === basePath || next.pathname.startsWith(`${basePath}/`));
      path = next.pathname.slice(basePath.length) || "/";
      if (!inApi || !isShotApiRequestAllowed(method, path)) return shotApiError("Cloud API redirected the request elsewhere.", 502);
      target = next;
    }
  } catch (error) {
    // A read that never reached the service (no connection, a refused proxy, nothing back by its deadline) is said
    // as one, in the words every command uses; any other failure is told as a dropped connection tells fetch.
    if (cutOff || isNetworkFailure(error)) return unreachable();
    return shotApiError("Cloud API request failed.", 502);
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener("abort", abortFromPage);
  }
}

/** A kept read's answer as the page gets it, its copy saved for a later run the service does not answer. */
async function keptResponse(response: Response, kept: NonNullable<ReturnType<typeof savedCopyRead>>): Promise<Response> {
  const text = await response.text();
  try {
    kept.read.save(kept.key, JSON.parse(text));
  } catch {
    // Intentional ignore: an answer that is not the terms' JSON is passed on as it came, and kept nowhere.
  }
  const headers = new Headers(response.headers);
  for (const name of SHOT_API_DROPPED_RESPONSE_HEADERS) headers.delete(name);
  headers.set("Cache-Control", "no-store");
  return new Response(text, { status: response.status, statusText: response.statusText, headers });
}

/**
 * The page's answer for a read the proxy could not get to the data service:
 * the page's request reads it as the service being unreachable
 * (SHOT_SERVICE_UNREACHABLE_HEADER), as it would a refused connection of its own.
 */
function shotApiUnreachable(epoch: number): Response {
  noteDataServiceReach(false, epoch);
  return Response.json({ error: DATA_SERVICE_UNREACHABLE_MESSAGE }, {
    status: 502,
    headers: { "Cache-Control": "no-store", [SHOT_SERVICE_UNREACHABLE_HEADER]: "1" },
  });
}

/**
 * The API's answer as the page gets it: without the API origin's headers, and
 * for the session read only its user, since the session's token rides along
 * in that answer and the page never holds the session.
 */
async function shotApiResponse(response: Response, path: string): Promise<Response> {
  const headers = new Headers(response.headers);
  for (const name of SHOT_API_DROPPED_RESPONSE_HEADERS) headers.delete(name);
  headers.set("Cache-Control", "no-store");
  if (!isShotSessionPath(path)) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  let user: unknown = null;
  try {
    const answer = await response.json() as { user?: unknown } | null;
    user = answer?.user ?? null;
  } catch {
    // Intentional ignore: an answer that is not JSON names no user, which reads as signed out.
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ user }), { status: response.status, statusText: response.statusText, headers });
}

async function capturePageScreenshot({
  url,
  widthPx,
  heightPx,
  deviceScaleFactor,
  userDataDir,
  captureImage,
  readTickerReport = false,
  statusLine,
  fitRows,
}: {
  url: string;
  widthPx: number;
  heightPx: number;
  deviceScaleFactor: number;
  userDataDir: string;
  captureImage: boolean;
  readTickerReport?: boolean;
  statusLine?: ShotStatusLine;
  fitRows?: { heightCells: number; maxHeightCells: number; roles: readonly string[] };
}): Promise<DesktopPaneShotRenderResult & { image?: Uint8Array }> {
  const browser = await openShotPage({ widthPx, heightPx, userDataDir });
  const session = browser.page;
  try {
    await session.send("Runtime.enable");
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: widthPx,
      height: heightPx,
      deviceScaleFactor,
      mobile: false,
    });
    await session.send("Emulation.setDefaultBackgroundColorOverride", {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });
    await browser.open(url);
    await waitForShotReady(session, readTickerReport ? 20 : 100);
    if (fitRows) await growToFitRows(session, { widthPx, heightPx, deviceScaleFactor, ...fitRows });
    if (captureImage) await hideCutRows(session);
    let rendered = await readRenderedPaneState(session);
    if (captureImage && statusLine) {
      const line = await statusLine(rendered);
      const statusText = (await fitShotStatusLine(session, line ?? { variants: [] })) || null;
      await hideCutRows(session);
      rendered = await readRenderedPaneState(session);
      rendered.statusLine = statusText;
      rendered.statusLineClipped = shotStatusDateClipped(line, statusText);
    }
    if (captureImage) {
      const screenshot = await session.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      }) as { data?: string };
      if (!screenshot.data) throw new Error("Chrome did not return screenshot data.");
      return { ...rendered, image: Buffer.from(screenshot.data, "base64") };
    }
    return rendered;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  } finally {
    await browser.close();
  }
}

/**
 * Grows the viewport and the pane by the rows their tables scroll past, or the
 * text a reader's body scrolls past, up to `maxHeightCells`, then waits for the
 * taller pane to settle: a board a default capture would cut (FUT's last
 * sectors) shows every row, and a docs page its whole text.
 */
async function growToFitRows(session: CdpPage, size: {
  widthPx: number;
  heightPx: number;
  deviceScaleFactor: number;
  heightCells: number;
  maxHeightCells: number;
  roles: readonly string[];
}): Promise<void> {
  const selector = size.roles.map((role) => `[data-gloom-role="${role}"]`).join(", ");
  const result = await session.send("Runtime.evaluate", {
    expression: `Math.max(0, ...[...document.querySelectorAll(${JSON.stringify(selector)})]
      .map((element) => element.scrollHeight - element.clientHeight))`,
    returnByValue: true,
  }) as { result?: { value?: unknown } };
  const overflowPx = Number(result.result?.value);
  // One pixel is subpixel layout, not a hidden row.
  if (!Number.isFinite(overflowPx) || overflowPx <= 1) return;
  const cellPx = size.heightPx / size.heightCells;
  const heightCells = Math.min(size.maxHeightCells, size.heightCells + Math.ceil(overflowPx / cellPx));
  if (heightCells <= size.heightCells) return;
  await session.send("Emulation.setDeviceMetricsOverride", {
    width: size.widthPx,
    height: Math.round(heightCells * cellPx),
    deviceScaleFactor: size.deviceScaleFactor,
    mobile: false,
  });
  await session.send("Runtime.evaluate", {
    expression: `window.__GLOOM_CLI_SHOT_RESIZE__ && window.__GLOOM_CLI_SHOT_RESIZE__(${heightCells})`,
    returnByValue: true,
  });
  await waitForShotReady(session);
}

/**
 * A capture draws whole rows beneath the sticky header and above the bottom
 * edge. It also draws the table's vertical scrollbar when rows scroll past
 * those edges. The live table keeps smooth scrolling and its partial rows.
 */
async function hideCutRows(session: CdpPage): Promise<void> {
  await session.send("Runtime.evaluate", {
    expression: `(() => {
      const root = document.getElementById("root") || document.body;
      const visibilityOf = (${rowViewportVisibility.toString()});
      const bodyRole = 'data-table-body-scroll';
      for (const body of root.querySelectorAll('[data-gloom-role="' + bodyRole + '"]')) {
        const showsOverflow = body.clientHeight > 0 && body.scrollHeight > body.clientHeight + 1
          && body.getAttribute('data-gloom-scrollbar-y') === 'visible'
          && /auto|scroll/.test(getComputedStyle(body).overflowY);
        if (showsOverflow) {
          body.style.scrollbarWidth = 'auto';
          body.style.scrollbarColor = 'auto';
          body.setAttribute('data-gloom-scrollbar-active', 'true');
        }
        body.toggleAttribute('data-gloom-shot-table-overflow', showsOverflow);
      }
      const rows = [...root.querySelectorAll(
        '[data-gloom-role="data-table-row"], [data-gloom-role="data-table-section-header"], [data-gloom-role="desktop-list-row"], [data-gloom-row="true"]',
      )];
      const clips = (element) => {
        const style = getComputedStyle(element);
        return /(auto|scroll|hidden|clip)/.test(style.overflowY) && element.clientHeight > 0;
      };
      const viewports = new Map();
      const wholeRows = new Set();
      const cut = [];
      for (const row of rows) {
        if (row.hasAttribute('data-gloom-shot-cut-row')) {
          row.style.removeProperty('visibility');
          row.removeAttribute('data-gloom-shot-cut-row');
        }
        let box = row.parentElement;
        while (box && box !== root && !clips(box)) box = box.parentElement;
        if (!box || box === root) continue;
        if (!viewports.has(box)) {
          const area = box.getBoundingClientRect();
          const top = area.top + box.clientTop;
          const header = box.getAttribute('data-gloom-role') === bodyRole
            ? box.querySelector('[data-gloom-role="data-table-header-row"]') : null;
          viewports.set(box, { top: Math.max(top, header?.getBoundingClientRect().bottom ?? top), bottom: top + box.clientHeight });
        }
        const viewport = viewports.get(box);
        const rect = row.getBoundingClientRect();
        if (rect.height <= 0) continue;
        const visibility = visibilityOf(rect.top, rect.bottom, viewport.top, viewport.bottom);
        if (visibility === 'whole') wholeRows.add(box);
        else cut.push({ row, box, visibility });
      }
      for (const { row, box, visibility } of cut) {
        if (visibility === 'outside' || wholeRows.has(box)) {
          row.style.visibility = 'hidden';
          row.setAttribute('data-gloom-shot-cut-row', '');
        }
      }
    })()`,
    returnByValue: true,
  });
}

const LOADING_STATE_PATTERNS = [
  /\bLoading(?: [^.]{0,80})?\.{3}/gi,
  /\bRendering pane\.{3}/gi,
];

const SIGN_IN_WALL_PATTERNS = [
  /\bSign in to\b/gi,
  /\bVerify your email\b/gi,
  /\brequires signup and email verification\b/gi,
];

const PRO_WALL_PATTERNS = [
  /\bpart of Gloom Cloud Pro\b/gi,
];

const ERROR_STATE_PATTERNS = [
  /\b[^.]{1,100} unavailable\./gi,
  /\bFailed to fetch\b/gi,
  /\bCould not load\b/gi,
  ...SIGN_IN_WALL_PATTERNS,
  ...PRO_WALL_PATTERNS,
  /\bCloud API request failed\b/gi,
];

const EMPTY_STATE_PATTERNS = [
  /\bNo chart data\b/gi,
  /\bNo graph data\b/gi,
  /\bNo historical prices\b/gi,
  /\bNo financial statement rows\b/gi,
  /\bNo comparison tickers configured\b/gi,
  /\bNo relationship tickers configured\b/gi,
  /\bNo overlapping price history\b/gi,
  /\bNo tickers? selected\b/gi,
  /\bNo data(?: available)?\b/gi,
  /\bNothing to show yet\b/gi,
  /\bNo transcribed calls(?: for [^.]+)? yet\b/gi,
  /\bNo short interest (?:data|found)\b/gi,
  /\bNo (?:House PTR |insider )?(?:trades|members|transactions|filings)\b/gi,
  // OMON on an expiry the chain does not list, with the dates nearest it.
  /\bNo (?:option contracts returned for )?expiry \d{4}-\d{2}-\d{2}(?:; (?:available|nearest others): \d{4}-\d{2}-\d{2}(?:, \d{4}-\d{2}-\d{2})*(?: \(\+\d+ more\))?|; the chain lists no expiries)?/gi,
];

/**
 * The text a capture reads the pane's state from: what it shows, less its
 * footer's note line. A note says what the data shown leaves out ("Grossing
 * and genre ranks are unavailable."), never that the pane failed: a full
 * table under it is a usable pane, and an empty state under it is that state.
 * Both texts come whitespace-collapsed, as the page reads them.
 */
function paneStateText(visibleText: string, footerNotes: readonly string[]): string {
  return footerNotes.reduce((text, note) => {
    const at = note ? text.lastIndexOf(note) : -1;
    return at < 0 ? text : `${text.slice(0, at)} ${text.slice(at + note.length)}`;
  }, visibleText).replace(/\s+/g, " ").trim();
}

/** The words that mark a capture's loading, error, empty and gated states, read from its text less its note line (paneStateText). */
export function paneStateMarkers(visibleText: string, footerNotes: readonly string[] = []) {
  const text = paneStateText(visibleText, footerNotes);
  return {
    loading: stateMarkers(text, LOADING_STATE_PATTERNS),
    error: stateMarkers(text, ERROR_STATE_PATTERNS),
    empty: stateMarkers(text, EMPTY_STATE_PATTERNS),
    signIn: stateMarkers(text, SIGN_IN_WALL_PATTERNS).length > 0,
    pro: stateMarkers(text, PRO_WALL_PATTERNS).length > 0,
  };
}

function stateMarkers(text: string, patterns: RegExp[]): string[] {
  return [...new Set(patterns.flatMap((pattern) => (
    [...text.matchAll(pattern)].map((match) => match[0])
  )))];
}

/** Omit decorative placeholders from text extraction without changing the screenshot or layout. */
function withoutReportDecorations<T>(root: HTMLElement, read: (root: HTMLElement) => T): T {
  const selector = '[data-gloom-report-ignore="true"]';
  if (!root.querySelector(selector)) return read(root);
  const style = root.ownerDocument.createElement("style");
  style.textContent = `${selector}, ${selector} * { visibility: hidden !important; }`;
  root.ownerDocument.head.appendChild(style);
  try {
    return read(root);
  } finally {
    style.remove();
  }
}

export async function readRenderedPaneState(session: CdpPage): Promise<DesktopPaneShotRenderResult> {
  const result = await session.send("Runtime.evaluate", {
    expression: `(${withoutReportDecorations.toString()})(document.getElementById("root") || document.body, (root) => {
      const semanticUi = window.__GLOOM_CLI_SHOT_SEMANTIC_UI__ || [];
      const normalize = (value) => String(value || "").replace(/\\s+/g, " ").trim();
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && rect.right > 0 && rect.bottom > 0
          && rect.left < window.innerWidth && rect.top < window.innerHeight;
      };
      const semanticTables = semanticUi.filter((node) => node && node.role === "table");
      const clippedFigures = [...root.querySelectorAll('[data-gloom-essential="true"]')].flatMap((cell) => {
        const bounds = cell.getBoundingClientRect();
        const parts = [...cell.querySelectorAll('[data-gloom-role="stat-grid-label"], [data-gloom-role="stat-grid-value"]')];
        const clipped = !isVisible(cell) || parts.some((part) => {
          const rect = part.getBoundingClientRect();
          return !isVisible(part) || part.scrollWidth > part.clientWidth + 1
            || rect.left < bounds.left - 1 || rect.right > bounds.right + 1
            || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1;
        });
        return clipped ? [cell.querySelector('[data-gloom-role="stat-grid-label"]')?.textContent?.trim()].filter(Boolean) : [];
      });
      for (const node of semanticUi.filter((node) => node.role === "figure-layout" && node.metadata)) {
        node.metadata.omitted = [...(node.metadata.omitted ?? []), ...clippedFigures];
      }
      const rows = [];
      const truncationReasons = new Set();
      const scrollReasons = (${scrollTruncationReasons.toString()});
      const readTableRows = (${readRenderedTableRows.toString()});
      const visibleTables = [...root.querySelectorAll('[data-gloom-role="data-table"]')].filter(isVisible);
      // A table that publishes every row has nothing cut from a report, whatever the viewport shows.
      const reportedRowsOf = (tableIndex) => {
        const metadata = semanticTables[tableIndex] && semanticTables[tableIndex].metadata;
        return metadata && Array.isArray(metadata.rows) ? metadata.rows : null;
      };
      const reportedTables = new Set(visibleTables.filter((_table, tableIndex) => reportedRowsOf(tableIndex)));
      const reportRows = [];
      const reportTruncationReasons = new Set();
      const inReportedTable = (element) => {
        const table = element.closest('[data-gloom-role="data-table"]');
        return !!table && reportedTables.has(table);
      };
      const managesRows = (element) => element.getAttribute("data-gloom-role") === "data-table-body-scroll";
      const markScrollTruncation = (element) => {
        if (!(element instanceof HTMLElement) || !isVisible(element)) return;
        const metrics = {
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollLeft: element.scrollLeft,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          // A table's vertical spacer includes virtual rows. Its scrollbar
          // attribute allows a bar, but does not prove that a bar is drawn.
          scrollbarY: false,
          scrollbarX: managesRows(element) && element.getAttribute("data-gloom-scrollbar-x") === "visible",
        };
        const table = element.closest('[data-gloom-role="data-table"]');
        const total = semanticTables[visibleTables.indexOf(table)]?.metadata?.rowCount;
        const rowCountAnnouncesCut = typeof total === 'number' && total > [...element.querySelectorAll('[data-gloom-role="data-table-row"]')].filter(isVisible).length;
        const rowsAnnounced = managesRows(element) && (element.hasAttribute('data-gloom-shot-table-overflow') || rowCountAnnouncesCut);
        scrollReasons(metrics, rowsAnnounced).forEach((reason) => truncationReasons.add(reason));
        if (!inReportedTable(element)) scrollReasons(metrics).forEach((reason) => reportTruncationReasons.add(reason));
      };
      [...root.querySelectorAll(
        '[data-gloom-scrollbar-x="visible"], [data-gloom-scrollbar-y="visible"], [data-gloom-role="data-table-body-scroll"]',
      )].forEach(markScrollTruncation);
      const cutColumns = [];
      visibleTables
        .forEach((table, tableIndex) => {
          const tableMetadata = semanticTables[tableIndex] && semanticTables[tableIndex].metadata || {};
          const semanticColumns = Array.isArray(tableMetadata.columns) ? tableMetadata.columns : [];
          const headerCells = [...table.querySelectorAll('[data-gloom-role="data-table-header-cell"]')];
          const headers = headerCells.map((cell) => normalize(cell.innerText));
          // A column drawn past the edge of the table's viewport, whole or in part, is one the picture cut.
          const scroller = table.querySelector('[data-gloom-role="data-table-body-scroll"]');
          if (scroller instanceof HTMLElement) {
            const box = scroller.getBoundingClientRect();
            const left = Math.max(0, box.left);
            const right = Math.min(window.innerWidth, box.left + scroller.clientWidth);
            headerCells.forEach((cell, cellIndex) => {
              const rect = cell.getBoundingClientRect();
              if (rect.width <= 0 || (rect.left >= left - 1 && rect.right <= right + 1)) return;
              // A centred header is padded with spaces (FA's "      FY2024      ").
              const label = normalize((semanticColumns[cellIndex] || {}).label) || headers[cellIndex] || String(cellIndex + 1);
              if (!cutColumns.includes(label)) cutColumns.push(label);
            });
          }
          const drawn = readTableRows(table, tableIndex, semanticColumns, isVisible);
          if (drawn.clipped) {
            truncationReasons.add("one or more cells are visibly clipped");
            if (!reportedTables.has(table)) reportTruncationReasons.add("one or more cells are visibly clipped");
          }
          drawn.rows.forEach((captured) => {
            rows.push(captured);
            if (!reportedTables.has(table)) reportRows.push(captured);
          });
          const reported = reportedRowsOf(tableIndex);
          if (!reported) return;
          reported.forEach((row, rowIndex) => {
            const cells = Array.isArray(row && row.cells) ? row.cells.filter((cell) => cell && cell.text) : [];
            if (cells.length === 0) return;
            reportRows.push({
              tableIndex,
              rowIndex,
              ...(typeof row.key === "string" ? { key: row.key } : {}),
              selected: row.selected === true,
              ...(row.section === true ? { section: true } : {}),
              cells,
            });
          });
        });
      // Panes that lay out entries as prose rather than a table, such as the
      // 8-K feed, mark each entry as a row so the capture can count it.
      if (rows.length === 0) {
        [...root.querySelectorAll('[data-gloom-role="desktop-list-row"], [data-gloom-row="true"]')]
          .filter(isVisible)
          .forEach((row, rowIndex) => {
            const text = normalize(row.innerText);
            if (!text) return;
            rows.push({
              tableIndex: 0,
              rowIndex,
              selected: row.getAttribute("data-selected") === "true",
              cells: [{ columnLabel: "Row", text }],
            });
          });
      }
      return {
        visibleText: root.innerText || "",
        // What the visible text fields hold, which innerText leaves out: OVME's Underlying is one.
        fieldValues: [...root.querySelectorAll("input, textarea")]
          .filter((field) => isVisible(field) && field.type !== "password" && field.type !== "hidden")
          .map((field) => normalize(field.value))
          .filter(Boolean),
        footerText: [...root.querySelectorAll('[data-gloom-role="pane-footer"]')]
          .map((footer) => normalize(footer.innerText))
          .filter(Boolean)
          .join(" "),
        footerNotes: [...root.querySelectorAll('[data-gloom-role="pane-footer-notes"]')]
          .map((note) => normalize(note.innerText))
          .filter(Boolean),
        visibleKeyValues: (${readVisibleKeyValues.toString()})(root),
        surfaces: [...root.querySelectorAll('[data-gloom-surface-renderer]')].filter(isVisible).map((element) => ({
          renderer: element.getAttribute("data-gloom-surface-renderer") || "",
          state: element.getAttribute("data-gloom-surface-state") || "",
        })),
        error: window.__GLOOM_CLI_SHOT_ERROR__ || "",
        loadingStateDetected: root.querySelector('[data-gloom-status="loading"]') !== null,
        errorStateDetected: root.querySelector('[data-gloom-status="error"]') !== null,
        // An empty sub-section off screen, such as a ticker's news list below
        // the fold, does not make the captured view empty.
        emptyStateDetected: [...root.querySelectorAll('[data-gloom-status="empty"]')].some(isVisible),
        // A body that shows one empty or failed state and only its chrome
        // beside it reads as the state's words, not as its filters' labels.
        emptyStateText: (() => {
          const body = root.querySelector('[data-gloom-role="pane-body"]') || root;
          const states = [...body.querySelectorAll('[data-gloom-ui="empty-state"]')].filter(isVisible);
          if (states.length !== 1) return [];
          const chrome = '[data-gloom-role="query-bar"], [data-gloom-role="data-table-header-row"], [data-gloom-role="tab-list"], [data-gloom-role="page-stack-header"], [data-gloom-role="pane-footer"], [data-gloom-role="pane-footer-notes"], [data-gloom-ui="empty-state"]';
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const parent = node.parentElement;
            if (!normalize(node.textContent) || !parent || parent.closest(chrome) || !isVisible(parent)) continue;
            return [];
          }
          return [...states[0].children]
            .filter((child) => isVisible(child) && !child.querySelector('button, [role="button"]'))
            .map((child) => normalize(child.innerText))
            .filter(Boolean);
        })(),
        // What each visible error and empty state says, for the Reason a strict capture gives.
        stateText: (() => {
          const said = (status) => [...new Set([...root.querySelectorAll('[data-gloom-status="' + status + '"]')]
            // The innermost: a pane's status body holds the state it draws.
            .filter((state) => isVisible(state) && !state.querySelector('[data-gloom-status="' + status + '"]'))
            .map((state) => {
              const parts = state.children.length > 0 ? [...state.children] : [state];
              return parts
                .filter((part) => isVisible(part) && !part.matches('button, [role="button"]') && !part.querySelector('button, [role="button"]'))
                .map((part) => normalize(part.innerText))
                .filter(Boolean)
                // A title and its message read as two sentences.
                .reduce((text, part) => !text ? part : /[.!?:]$/.test(text) ? text + " " + part : text + ". " + part, "");
            })
            .filter(Boolean))].slice(0, 3);
          const error = said("error");
          const empty = said("empty");
          return { ...(error.length ? { error } : {}), ...(empty.length ? { empty } : {}) };
        })(),
        contentFigures: (${countContentFigures.toString()})(root, isVisible),
        cutColumns,
        // The shared sign-in wall and the Pro lock prompt every gated pane draws.
        accessGate: [...root.querySelectorAll('[data-gloom-ui="sign-in-wall"]')].some(isVisible) ? "sign-in"
          : [...root.querySelectorAll('[data-gloom-ui="pro-lock"]')].some(isVisible) ? "pro" : "",
        signInGate: [...root.querySelectorAll('[data-gloom-sign-in]')].find(isVisible)?.getAttribute("data-gloom-sign-in"),
        rows,
        truncated: truncationReasons.size > 0,
        truncationReasons: [...truncationReasons],
        ...(reportedTables.size > 0 ? { reportRows, reportTruncationReasons: [...reportTruncationReasons] } : {}),
        tableRowTotals: visibleTables.map((_table, tableIndex) => {
          const metadata = semanticTables[tableIndex] && semanticTables[tableIndex].metadata;
          return metadata && typeof metadata.rowCount === "number" ? metadata.rowCount : null;
        }),
        semanticUi,
      };
    })`,
    returnByValue: true,
  }) as {
    result?: {
      value?: {
        visibleText?: string;
        fieldValues?: unknown;
        footerText?: string;
        footerNotes?: unknown;
        visibleKeyValues?: Array<{ label: string; text: string }>;
        surfaces?: DesktopPaneShotSurface[];
        error?: string;
        loadingStateDetected?: boolean;
        errorStateDetected?: boolean;
        emptyStateDetected?: boolean;
        emptyStateText?: string[];
        stateText?: { error?: unknown; empty?: unknown };
        contentFigures?: number;
        cutColumns?: unknown;
        accessGate?: string;
        signInGate?: string;
        rows?: DesktopPaneShotRenderedRow[];
        truncated?: boolean;
        truncationReasons?: string[];
        reportRows?: DesktopPaneShotRenderedRow[];
        reportTruncationReasons?: string[];
        tableRowTotals?: Array<number | null>;
        semanticUi?: RemoteUiNodeSnapshot[];
      };
    };
  };
  const value = result.result?.value;
  if (value?.error) throw new Error(value.error);
  const visibleText = (value?.visibleText ?? "").replace(/\s+/g, " ").trim();
  const footerNotes = Array.isArray(value?.footerNotes) ? value.footerNotes.filter((note): note is string => typeof note === "string") : [];
  const markers = paneStateMarkers(visibleText, footerNotes);
  const loadingStateMarkers = markers.loading;
  const errorStateMarkers = markers.error;
  const emptyStateMarkers = markers.empty;
  const accessGate: PaneAccessGate | null = value?.accessGate === "sign-in" || value?.accessGate === "pro" ? value.accessGate
    : markers.signIn ? "sign-in" : markers.pro ? "pro" : null;
  const signInGate = value?.signInGate;
  const rows = Array.isArray(value?.rows) ? value.rows : [];
  const textShowsEllipsis = rows.some((row) => row.cells.some((cell) => /\u2026|\.\.\./.test(cell.text)));
  const truncationReasons = Array.isArray(value?.truncationReasons)
    ? value.truncationReasons.filter((reason): reason is string => typeof reason === "string")
    : [];
  if (textShowsEllipsis && !truncationReasons.includes("one or more cells are visibly clipped")) {
    truncationReasons.push("one or more cells are visibly clipped");
  }
  const visibleLines = (value?.visibleText ?? "").split("\n")
    .map((line) => line.replace(/\u00a0/g, " ").trimEnd())
    .filter((line) => line.trim().length > 0);
  const fieldValues = Array.isArray(value?.fieldValues) ? value.fieldValues.filter((field): field is string => typeof field === "string") : [];
  return {
    visibleText,
    ...(fieldValues.length > 0 ? { fieldValues } : {}),
    visibleLines,
    footerText: typeof value?.footerText === "string" ? value.footerText : "",
    visibleKeyValues: Array.isArray(value?.visibleKeyValues) ? value.visibleKeyValues : [],
    ...(Array.isArray(value?.surfaces) && value.surfaces.length > 0 ? { surfaces: value.surfaces } : {}),
    rows,
    truncated: value?.truncated === true || textShowsEllipsis,
    truncationReasons,
    ...(Array.isArray(value?.reportRows) ? {
      reportRows: value.reportRows,
      reportTruncationReasons: (value.reportTruncationReasons ?? []).filter((reason): reason is string => typeof reason === "string"),
    } : {}),
    ...(Array.isArray(value?.tableRowTotals) && value.tableRowTotals.length > 0 ? {
      tableRowTotals: value.tableRowTotals.map((total) => typeof total === "number" && Number.isFinite(total) ? total : null),
    } : {}),
    loadingStateDetected: value?.loadingStateDetected === true || loadingStateMarkers.length > 0,
    errorStateDetected: value?.errorStateDetected === true || errorStateMarkers.length > 0,
    errorStateMarkers,
    emptyStateDetected: value?.emptyStateDetected === true || emptyStateMarkers.length > 0,
    emptyStateMarkers,
    ...(Array.isArray(value?.emptyStateText) && value.emptyStateText.length > 0
      ? { emptyStateText: value.emptyStateText.filter((line): line is string => typeof line === "string" && line.length > 0) } : {}),
    accessGate,
    ...(signInGate === "verify-email" || signInGate === "pro" || signInGate === "free" ? { signInGate } : {}),
    ...shotStateText(value?.stateText),
    ...(typeof value?.contentFigures === "number" ? { contentFigures: value.contentFigures } : {}),
    ...(Array.isArray(value?.cutColumns) && value.cutColumns.length > 0
      ? { cutColumns: value.cutColumns.filter((label): label is string => typeof label === "string" && label.length > 0) } : {}),
    semanticUi: Array.isArray(value?.semanticUi) ? value.semanticUi : [],
  };
}

/** The state words a page read, as strings only; nothing when it read none. */
function shotStateText(value: { error?: unknown; empty?: unknown } | undefined): Pick<DesktopPaneShotRenderResult, "stateText"> {
  const lines = (said: unknown) => Array.isArray(said) ? said.filter((line): line is string => typeof line === "string" && line.length > 0) : [];
  const error = lines(value?.error);
  const empty = lines(value?.empty);
  if (error.length === 0 && empty.length === 0) return {};
  return { stateText: { ...(error.length ? { error } : {}), ...(empty.length ? { empty } : {}) } };
}

/** Draws the first variant that fits the pane footer, and returns what it drew. */
async function fitShotStatusLine(session: CdpPage, { variants, dates, ownStatus }: ShotStatusLineVariants): Promise<string | null> {
  const result = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const fit = window.__GLOOM_CLI_SHOT_FIT_STATUS__;
      return fit ? fit(${JSON.stringify(variants)}, ${JSON.stringify({ dates: dates ?? null, ...(ownStatus ? { ownStatus } : {}) })}) : null;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }) as { result?: { value?: unknown } };
  const value = result.result?.value;
  return typeof value === "string" ? value : null;
}

async function waitForShotReady(session: CdpPage, pollMs = 100): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SHOT_READY_TIMEOUT_MS) {
    const result = await session.send("Runtime.evaluate", {
      expression: "({ ready: window.__GLOOM_CLI_SHOT_READY__ === true, error: window.__GLOOM_CLI_SHOT_ERROR__ || '' })",
      returnByValue: true,
    }) as { result?: { value?: { ready?: boolean; error?: string } } };
    const value = result.result?.value;
    if (value?.error) throw new Error(value.error);
    if (value?.ready) return;
    await sleep(pollMs);
  }
  throw new Error("Timed out waiting for the desktop pane screenshot renderer.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
