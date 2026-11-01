import type { ScannerCapture } from "../plugins/builtin/shared/scanner-capture";
import type { TapeCapture } from "../plugins/builtin/time-sales/snapshot-client";
import { mkdtemp, rm } from "fs/promises";
import { randomBytes, timingSafeEqual } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { writeOutputFile } from "./output-file";
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
import { readVisibleKeyValues } from "./visible-key-values";
import { scrollTruncationReasons } from "./scroll-truncation";
import {
  SHOT_API_PROXY_PREFIX,
  SHOT_API_SOCKET_PATH,
  SHOT_HTTP_BRIDGE_PATH,
  SHOT_MARKET_BRIDGE_PATH,
  type ShotApiSocketCall,
  type ShotApiSocketReply,
} from "./desktop-pane-shot-routes";
import { SESSION_COOKIE_NAMES } from "../api-client/session-cookie";
import { isShotApiRequestAllowed, isShotSessionPath } from "./desktop-pane-shot-api-policy";
import { renderElectrobunViewHtml } from "../renderers/dom/build-assets";
import { loadShotView, SHOT_VIEW_SCRIPT, SHOT_VIEW_STYLESHEET, type ShotViewFiles } from "./desktop-pane-shot-view";
import { errorMessage } from "../utils/errors";
import { findChromeExecutable, launchShotBrowser, type CdpPage } from "./desktop-pane-shot-browser";

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
  instrumentFinancials?: SnapshotMarketData["instrumentFinancials"];
  historyVariants?: SnapshotMarketData["historyVariants"];
  intradayHistories: DesktopPaneShotIntradayHistory[];
  optionsChains: NonNullable<SnapshotMarketData["optionsChains"]>;
  tapeSnapshots?: TapeCapture[];
  /** What each scanner pane's feed answered the capture process, which the page replays since its own socket cannot ask. */
  scannerSnapshots?: ScannerCapture[];
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
  httpFetch(request: HttpProxyRequestEnvelope): Promise<HttpProxyResponseEnvelope>;
}

interface DesktopPaneShotRenderedCell {
  columnId?: string;
  columnLabel: string;
  text: string;
  /** The ISO instant behind a cell whose text shortens a time ("Wed 11:27"), from the table cell's export value. */
  instant?: string;
  /** The full-precision number behind a cell whose text rounds it (a trade of -9.4596), from the same export value. */
  value?: number;
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
  /** A wall that needs an account, or a Pro lock on part of the pane. */
  accessGate?: PaneAccessGate | null;
  semanticUi: RemoteUiNodeSnapshot[];
  /** The status line drawn in the capture's footer, as it fit the width. */
  statusLine?: string | null;
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
}
type ShotStatusLine = (rendered: DesktopPaneShotRenderResult) => ShotStatusLineVariants | null | Promise<ShotStatusLineVariants | null>;

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

export async function renderDesktopPaneScreenshot(
  payload: DesktopPaneShotPayload,
  outputPath: string,
  apiProxy: DesktopPaneShotApiProxy,
  options: { captureImage?: boolean; bridge?: DesktopPaneShotBridge; statusLine?: ShotStatusLine } = {},
): Promise<DesktopPaneShotRenderResult> {
  const chrome = await findChromeExecutable();
  const view = await loadShotView();
  const tempDir = await mkdtemp(join(tmpdir(), "gloom-pane-shot-"));
  let server: ShotServer | null = null;
  try {
    server = serveShotPage(view, shotPageHtml(view, payload), apiProxy, options.bridge ?? null);
    return await capturePageScreenshot({
      chrome,
      url: server.url,
      outputPath,
      widthPx: payload.widthPx,
      heightPx: payload.heightPx,
      deviceScaleFactor: payload.deviceScaleFactor ?? DEFAULT_DEVICE_SCALE_FACTOR,
      userDataDir: join(tempDir, "chrome-profile"),
      captureImage: options.captureImage !== false,
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
    server?.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
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
        return proxyShotApiRequest(request, url, apiProxy);
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
        void answerShotApiCall(String(message), apiProxy).then((reply) => socket.send(reply));
      },
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/${secret}/`,
    stop: () => server.stop(true),
  };
}

/**
 * One read the page sent over its API socket (`SHOT_API_SOCKET_PATH`), made
 * as the proxy makes it, with the session the page never holds: the reply's
 * JSON, its body in base64. A call that is not an API path answers why.
 */
export async function answerShotApiCall(message: string, apiProxy: DesktopPaneShotApiProxy): Promise<string> {
  let id = 0;
  try {
    const call = JSON.parse(message) as Partial<ShotApiSocketCall>;
    id = typeof call.id === "number" ? call.id : 0;
    if (typeof call.path !== "string" || !call.path.startsWith("/") || call.path.startsWith("//")) throw new Error("Not an API path.");
    const url = new URL(`${SHOT_API_PROXY_PREFIX}${call.path}`, "http://127.0.0.1");
    const sent = new Headers(Array.isArray(call.headers) ? call.headers : []);
    const response = await proxyShotApiRequest(new Request(url, { headers: sent }), url, apiProxy);
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
  try {
    const payload = await request.json() as { operation?: unknown; args?: unknown };
    const operation = typeof payload.operation === "string" ? payload.operation : "";
    const args = Array.isArray(payload.args) ? payload.args : [];
    const data = await bridge.marketData(operation, args);
    return Response.json({ ok: true, data });
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
    const data = await bridge.httpFetch(payload);
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
): Promise<Response> {
  const baseUrl = new URL(apiProxy.baseUrl);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  let path = requestUrl.pathname.slice(SHOT_API_PROXY_PREFIX.length) || "/";
  let method = request.method.toUpperCase();
  if (!isShotApiRequestAllowed(method, path)) return shotApiError("The pane screenshot does not send this request.", 403);
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

  try {
    let body = method === "GET" || method === "HEAD" ? undefined : new Uint8Array(await request.arrayBuffer());
    for (let followed = 0; ; followed += 1) {
      const response = await fetch(target, { method, headers, body, redirect: "manual" });
      const location = SHOT_API_REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
      if (location === null) return await shotApiResponse(response, path);
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
  } catch {
    // Intentional ignore: the page is told the read failed, as a dropped connection tells fetch.
    return shotApiError("Cloud API request failed.", 502);
  }
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
  chrome,
  url,
  outputPath,
  widthPx,
  heightPx,
  deviceScaleFactor,
  userDataDir,
  captureImage,
  statusLine,
  fitRows,
}: {
  chrome: string;
  url: string;
  outputPath: string;
  widthPx: number;
  heightPx: number;
  deviceScaleFactor: number;
  userDataDir: string;
  captureImage: boolean;
  statusLine?: ShotStatusLine;
  fitRows?: { heightCells: number; maxHeightCells: number; roles: readonly string[] };
}): Promise<DesktopPaneShotRenderResult> {
  const browser = await launchShotBrowser(chrome, { widthPx, heightPx, userDataDir });
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
    await waitForShotReady(session);
    if (fitRows) await growToFitRows(session, { widthPx, heightPx, deviceScaleFactor, ...fitRows });
    const rendered = await readRenderedPaneState(session);
    if (captureImage && statusLine) {
      const line = await statusLine(rendered);
      rendered.statusLine = (await fitShotStatusLine(session, line ?? { variants: [] })) || null;
    }
    if (captureImage) {
      const screenshot = await session.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      }) as { data?: string };
      if (!screenshot.data) throw new Error("Chrome did not return screenshot data.");
      await writeOutputFile(outputPath, Buffer.from(screenshot.data, "base64"));
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

function stateMarkers(text: string, patterns: RegExp[]): string[] {
  return [...new Set(patterns.flatMap((pattern) => (
    [...text.matchAll(pattern)].map((match) => match[0])
  )))];
}

async function readRenderedPaneState(session: CdpPage): Promise<DesktopPaneShotRenderResult> {
  const result = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const root = document.getElementById("root") || document.body;
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
      const rows = [];
      const truncationReasons = new Set();
      const scrollReasons = (${scrollTruncationReasons.toString()});
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
        const reasons = scrollReasons({
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
          scrollLeft: element.scrollLeft,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          // A scroll box draws its scrollbar by default and its content is all in the page, so its
          // measures say what is cut; only a table's body holds rows it has not drawn.
          scrollbarY: managesRows(element) && element.getAttribute("data-gloom-scrollbar-y") === "visible",
          scrollbarX: managesRows(element) && element.getAttribute("data-gloom-scrollbar-x") === "visible",
        });
        reasons.forEach((reason) => truncationReasons.add(reason));
        if (!inReportedTable(element)) reasons.forEach((reason) => reportTruncationReasons.add(reason));
      };
      [...root.querySelectorAll(
        '[data-gloom-scrollbar-x="visible"], [data-gloom-scrollbar-y="visible"], [data-gloom-role="data-table-body-scroll"]',
      )].forEach(markScrollTruncation);
      visibleTables
        .forEach((table, tableIndex) => {
          const tableMetadata = semanticTables[tableIndex] && semanticTables[tableIndex].metadata || {};
          const semanticColumns = Array.isArray(tableMetadata.columns) ? tableMetadata.columns : [];
          const headers = [...table.querySelectorAll('[data-gloom-role="data-table-header-cell"]')]
            .map((cell) => normalize(cell.innerText || cell.textContent));
          const rowElements = [...table.querySelectorAll(
            '[data-gloom-role="data-table-row"], [data-gloom-role="data-table-section-header"]',
          )].filter(isVisible);
          rowElements.forEach((row, rowIndex) => {
            const cellElements = [...row.querySelectorAll('[data-gloom-role="data-table-cell"]')];
            const values = cellElements.length > 0 ? cellElements : [row];
            const rowKey = row.getAttribute("data-gloom-row-key");
            const cells = values.map((cell, cellIndex) => {
              const semanticColumn = semanticColumns[cellIndex] || {};
              const text = normalize(cell.innerText || cell.textContent);
              const textNodes = [cell, ...cell.querySelectorAll('*')];
              if (
                /\\u2026|\\.\\.\\./.test(text)
                || textNodes.some((node) => (
                  node instanceof HTMLElement
                  && isVisible(node)
                  && node.scrollWidth > node.clientWidth + 1
                ))
              ) {
                truncationReasons.add("one or more cells are visibly clipped");
                if (!reportedTables.has(table)) reportTruncationReasons.add("one or more cells are visibly clipped");
              }
              const instant = cell.getAttribute("data-gloom-cell-instant");
              const exact = Number(cell.getAttribute("data-gloom-cell-value") || "NaN");
              return {
                ...(typeof semanticColumn.id === "string" ? { columnId: semanticColumn.id } : {}),
                columnLabel: typeof semanticColumn.label === "string"
                  ? semanticColumn.label
                  : headers[cellIndex] || (values.length === 1 ? "Row" : String(cellIndex + 1)),
                text,
                ...(instant ? { instant } : {}),
                ...(Number.isFinite(exact) ? { value: exact } : {}),
              };
            }).filter((cell) => cell.text.length > 0);
            if (cells.length === 0) return;
            const captured = {
              tableIndex,
              rowIndex,
              ...(rowKey ? { key: rowKey } : {}),
              selected: row.getAttribute("data-selected") === "true",
              cells,
            };
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
            const text = normalize(row.innerText || row.textContent);
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
        visibleText: root.innerText || root.textContent || "",
        footerText: [...root.querySelectorAll('[data-gloom-role="pane-footer"]')]
          .map((footer) => normalize(footer.innerText || footer.textContent))
          .filter(Boolean)
          .join(" "),
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
        // The shared sign-in wall and the Pro lock prompt every gated pane draws.
        accessGate: [...root.querySelectorAll('[data-gloom-ui="sign-in-wall"]')].some(isVisible) ? "sign-in"
          : [...root.querySelectorAll('[data-gloom-ui="pro-lock"]')].some(isVisible) ? "pro" : "",
        rows,
        truncated: truncationReasons.size > 0,
        truncationReasons: [...truncationReasons],
        ...(reportedTables.size > 0 ? { reportRows, reportTruncationReasons: [...reportTruncationReasons] } : {}),
        semanticUi,
      };
    })()`,
    returnByValue: true,
  }) as {
    result?: {
      value?: {
        visibleText?: string;
        footerText?: string;
        visibleKeyValues?: Array<{ label: string; text: string }>;
        surfaces?: DesktopPaneShotSurface[];
        error?: string;
        loadingStateDetected?: boolean;
        errorStateDetected?: boolean;
        emptyStateDetected?: boolean;
        accessGate?: string;
        rows?: DesktopPaneShotRenderedRow[];
        truncated?: boolean;
        truncationReasons?: string[];
        reportRows?: DesktopPaneShotRenderedRow[];
        reportTruncationReasons?: string[];
        semanticUi?: RemoteUiNodeSnapshot[];
      };
    };
  };
  const value = result.result?.value;
  if (value?.error) throw new Error(value.error);
  const visibleText = (value?.visibleText ?? "").replace(/\s+/g, " ").trim();
  const loadingStateMarkers = stateMarkers(visibleText, LOADING_STATE_PATTERNS);
  const errorStateMarkers = stateMarkers(visibleText, ERROR_STATE_PATTERNS);
  const emptyStateMarkers = stateMarkers(visibleText, EMPTY_STATE_PATTERNS);
  const accessGate: PaneAccessGate | null = value?.accessGate === "sign-in" || stateMarkers(visibleText, SIGN_IN_WALL_PATTERNS).length > 0 ? "sign-in"
    : value?.accessGate === "pro" || stateMarkers(visibleText, PRO_WALL_PATTERNS).length > 0 ? "pro" : null;
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
  return {
    visibleText,
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
    loadingStateDetected: value?.loadingStateDetected === true || loadingStateMarkers.length > 0,
    errorStateDetected: value?.errorStateDetected === true || errorStateMarkers.length > 0,
    errorStateMarkers,
    emptyStateDetected: value?.emptyStateDetected === true || emptyStateMarkers.length > 0,
    emptyStateMarkers,
    accessGate,
    semanticUi: Array.isArray(value?.semanticUi) ? value.semanticUi : [],
  };
}

/** Draws the first variant that fits the pane footer, and returns what it drew. */
async function fitShotStatusLine(session: CdpPage, { variants, dates }: ShotStatusLineVariants): Promise<string | null> {
  const result = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const fit = window.__GLOOM_CLI_SHOT_FIT_STATUS__;
      return fit ? fit(${JSON.stringify(variants)}, ${JSON.stringify({ dates: dates ?? null })}) : null;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }) as { result?: { value?: unknown } };
  const value = result.result?.value;
  return typeof value === "string" ? value : null;
}

async function waitForShotReady(session: CdpPage): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SHOT_READY_TIMEOUT_MS) {
    const result = await session.send("Runtime.evaluate", {
      expression: "({ ready: window.__GLOOM_CLI_SHOT_READY__ === true, error: window.__GLOOM_CLI_SHOT_ERROR__ || '' })",
      returnByValue: true,
    }) as { result?: { value?: { ready?: boolean; error?: string } } };
    const value = result.result?.value;
    if (value?.error) throw new Error(value.error);
    if (value?.ready) return;
    await sleep(100);
  }
  throw new Error("Timed out waiting for the desktop pane screenshot renderer.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
