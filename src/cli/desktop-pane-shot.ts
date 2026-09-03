import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join, resolve, sep } from "path";
import type { AppConfig } from "../types/config";
import type { ResolvedSeries } from "../time-series/types";
import type { OptionsChain, TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import type { PaneRuntimeState } from "../core/state/app/state";
import type { RemoteUiNodeSnapshot } from "../remote/types";
import type { FredSeriesCacheEntry } from "../data/fred-series";
import type { DatedObservation } from "../plugins/builtin/market-valuation/series";
import {
  electrobunViewPath,
  writeElectrobunViewPage,
} from "../renderers/electrobun/view/build-assets";

export interface DesktopPaneShotPayload {
  config: AppConfig;
  paneId: string;
  widthCells: number;
  heightCells: number;
  widthPx: number;
  heightPx: number;
  /** Chrome device scale factor; 2 keeps text crisp, higher values zoom the layout. */
  deviceScaleFactor?: number;
  /** Label drawn at the right edge of the pane title bar; null draws nothing. */
  watermark?: string | null;
  tickers: TickerRecord[];
  financials: Array<[string, TickerFinancials]>;
  optionsChains: Array<[string, OptionsChain]>;
  fredSeries: Array<[string, FredSeriesCacheEntry]>;
  valuationSeries: Array<[string, DatedObservation[]]>;
  statSeries: Array<[string, DatedObservation[]]>;
  capabilitySeries: Array<[string, ResolvedSeries]>;
  paneState: Record<string, PaneRuntimeState>;
}

/** Kept in Bun memory and never serialized into the browser page or CLI result. */
export interface DesktopPaneShotApiProxy {
  baseUrl: string;
  sessionToken: string | null;
}

export interface DesktopPaneShotRenderedCell {
  columnId?: string;
  columnLabel: string;
  text: string;
}

export interface DesktopPaneShotRenderedRow {
  tableIndex: number;
  rowIndex: number;
  key?: string;
  selected: boolean;
  cells: DesktopPaneShotRenderedCell[];
}

export interface DesktopPaneShotRenderResult {
  visibleText: string;
  rows: DesktopPaneShotRenderedRow[];
  loadingStateDetected: boolean;
  errorStateDetected: boolean;
  errorStateMarkers: string[];
  emptyStateDetected: boolean;
  emptyStateMarkers: string[];
  semanticUi: RemoteUiNodeSnapshot[];
}

type CdpResponse = {
  id?: number;
  result?: unknown;
  error?: { message?: string; data?: string };
};

type PendingCdpCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const SHOT_MODE_CSS = [
  "[data-gloom-role='composite-chart-toolbar']",
  "[data-gloom-role='chart-series-quick-add']",
  "[data-gloom-role='pane-close']",
].join(", ") + " { display: none !important; }\n"
  // Sits where the hidden close button was: one cell high, right-aligned in the title bar.
  + "[data-gloom-role='shot-watermark'] { position: fixed; top: 1px; right: 10px; height: var(--cell-h);"
  + " line-height: var(--cell-h); font-size: 12px; letter-spacing: 0.02em; color: var(--gloom-text-dim, #888);"
  + " pointer-events: none; z-index: 1000; }";

const CHROME_POLL_ATTEMPTS = 80;
const SHOT_READY_TIMEOUT_MS = 45_000;
const CDP_CALL_TIMEOUT_MS = 10_000;
const DEFAULT_DEVICE_SCALE_FACTOR = 2;
const SHOT_API_PROXY_PREFIX = "/__gloom_cli_api__";
const SESSION_COOKIE_NAMES = ["__Secure-gloomberb.session_token", "gloomberb.session_token"] as const;

export async function renderDesktopPaneScreenshot(
  payload: DesktopPaneShotPayload,
  outputPath: string,
  apiProxy: DesktopPaneShotApiProxy,
): Promise<DesktopPaneShotRenderResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "gloom-pane-shot-"));
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    const outdir = join(tempDir, "assets");
    await mkdir(outdir, { recursive: true });
    await buildShotPage(outdir, payload);
    server = serveShotPage(outdir, apiProxy);
    const chrome = await findChromeExecutable();
    return await capturePageScreenshot({
      chrome,
      url: new URL("/", server.url).href,
      outputPath,
      widthPx: payload.widthPx,
      heightPx: payload.heightPx,
      deviceScaleFactor: payload.deviceScaleFactor ?? DEFAULT_DEVICE_SCALE_FACTOR,
      userDataDir: join(tempDir, "chrome-profile"),
    });
  } finally {
    server?.stop(true);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function buildShotPage(outdir: string, payload: DesktopPaneShotPayload): Promise<string> {
  const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  return writeElectrobunViewPage({
    entrypoint: electrobunViewPath("cli-pane-shot-entry.tsx"),
    outdir,
    pluginName: "desktop-pane-shot-native-bridges",
    extraAliasRules: [
      ["backend-rpc", "native-stubs/backend-rpc.ts"],
    ],
    failureMessage: "Failed to build desktop pane screenshot renderer.",
    missingEntryMessage: "Desktop pane screenshot build did not produce a JavaScript entrypoint.",
    title: "Gloomberb Pane Shot",
    loadingText: "Rendering pane...",
    bootstrapScript: `
      window.__GLOOM_CLI_SHOT_PAYLOAD__ = ${payloadJson};
      (() => {
        // A screenshot cannot be interacted with, so drawing tools, the
        // quick-add input and the close button only add noise to the image.
        const style = document.createElement("style");
        style.textContent = ${JSON.stringify(SHOT_MODE_CSS)};
        document.head.appendChild(style);
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

function serveShotPage(
  outdir: string,
  apiProxy: DesktopPaneShotApiProxy,
): ReturnType<typeof Bun.serve> {
  const staticRoot = resolve(outdir);
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 60,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith(`${SHOT_API_PROXY_PREFIX}/`)) {
        return proxyShotApiRequest(request, url, apiProxy);
      }
      return serveShotAsset(url, staticRoot);
    },
  });
}

async function serveShotAsset(url: URL, staticRoot: string): Promise<Response> {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(staticRoot, relativePath);
  if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${sep}`)) {
    return new Response("Not found", { status: 404 });
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) return new Response("Not found", { status: 404 });
  return new Response(file);
}

async function proxyShotApiRequest(
  request: Request,
  requestUrl: URL,
  apiProxy: DesktopPaneShotApiProxy,
): Promise<Response> {
  const baseUrl = new URL(apiProxy.baseUrl);
  const proxiedPath = requestUrl.pathname.slice(SHOT_API_PROXY_PREFIX.length) || "/";
  const target = new URL(baseUrl);
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  target.pathname = `${basePath}${proxiedPath.startsWith("/") ? proxiedPath : `/${proxiedPath}`}`;
  target.search = requestUrl.search;
  target.hash = "";
  const headers = new Headers(request.headers);
  for (const name of [
    "authorization",
    "connection",
    "content-length",
    "cookie",
    "host",
    "origin",
    "proxy-authorization",
    "referer",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
  ]) {
    headers.delete(name);
  }
  const browserOwnedHeaders: string[] = [];
  headers.forEach((_value, name) => {
    if (name.startsWith("sec-") || name === "accept-encoding") browserOwnedHeaders.push(name);
  });
  for (const name of browserOwnedHeaders) headers.delete(name);
  headers.set("Origin", baseUrl.origin);
  if (apiProxy.sessionToken) {
    headers.set(
      "Cookie",
      SESSION_COOKIE_NAMES.map((name) => `${name}=${apiProxy.sessionToken}`).join("; "),
    );
  }

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "follow",
    });
    const responseHeaders = new Headers(response.headers);
    for (const name of [
      "access-control-allow-credentials",
      "access-control-allow-origin",
      "content-encoding",
      "content-length",
      "set-cookie",
      "transfer-encoding",
    ]) {
      responseHeaders.delete(name);
    }
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch {
    return Response.json({ error: "Cloud API request failed." }, { status: 502 });
  }
}

async function findChromeExecutable(): Promise<string> {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    Bun.which("google-chrome"),
    Bun.which("chromium"),
    Bun.which("chromium-browser"),
  ].filter((value): value is string => !!value);

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) return candidate;
  }
  throw new Error("Could not find Chrome or Chromium to render the desktop pane screenshot.");
}

async function capturePageScreenshot({
  chrome,
  url,
  outputPath,
  widthPx,
  heightPx,
  deviceScaleFactor,
  userDataDir,
}: {
  chrome: string;
  url: string;
  outputPath: string;
  widthPx: number;
  heightPx: number;
  deviceScaleFactor: number;
  userDataDir: string;
}): Promise<DesktopPaneShotRenderResult> {
  await mkdir(userDataDir, { recursive: true });
  const port = 43000 + Math.floor(Math.random() * 10000);
  const proc = Bun.spawn([
    chrome,
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-popup-blocking",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--allow-file-access-from-files",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${widthPx},${heightPx}`,
    url,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  let session: CdpSession | null = null;
  try {
    const wsUrl = await waitForPageWebSocket(port, url);
    session = await CdpSession.connect(wsUrl);
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: widthPx,
      height: heightPx,
      deviceScaleFactor,
      mobile: false,
    });
    await waitForShotReady(session);
    const rendered = await readRenderedPaneState(session);
    const screenshot = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    }) as { data?: string };
    if (!screenshot.data) throw new Error("Chrome did not return screenshot data.");
    await writeFile(outputPath, Uint8Array.from(Buffer.from(screenshot.data, "base64")));
    return rendered;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message);
  } finally {
    session?.close();
    proc.kill();
    await proc.exited.catch(() => {});
  }
}

const LOADING_STATE_PATTERNS = [
  /\bLoading(?: [^.]{0,80})?\.{3}/gi,
  /\bRendering pane\.{3}/gi,
];

const ERROR_STATE_PATTERNS = [
  /\b[^.]{1,100} unavailable\./gi,
  /\bFailed to fetch\b/gi,
  /\bCould not load\b/gi,
  /\bSign in to\b/gi,
  /\bVerify your email\b/gi,
  /\bpart of Gloom Cloud Pro\b/gi,
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
];

function stateMarkers(text: string, patterns: RegExp[]): string[] {
  return [...new Set(patterns.flatMap((pattern) => (
    [...text.matchAll(pattern)].map((match) => match[0])
  )))];
}

async function readRenderedPaneState(session: CdpSession): Promise<DesktopPaneShotRenderResult> {
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
      [...root.querySelectorAll('[data-gloom-role="data-table"]')]
        .filter(isVisible)
        .forEach((table, tableIndex) => {
          const tableMetadata = semanticTables[tableIndex] && semanticTables[tableIndex].metadata || {};
          const semanticColumns = Array.isArray(tableMetadata.columns) ? tableMetadata.columns : [];
          const semanticRows = Array.isArray(tableMetadata.rows) ? tableMetadata.rows : [];
          const headers = [...table.querySelectorAll('[data-gloom-role="data-table-header-cell"]')]
            .map((cell) => normalize(cell.innerText || cell.textContent));
          const rowElements = [...table.querySelectorAll(
            '[data-gloom-role="data-table-row"], [data-gloom-role="data-table-section-header"]',
          )].filter(isVisible);
          rowElements.forEach((row, rowIndex) => {
            const cellElements = [...row.querySelectorAll('[data-gloom-role="data-table-cell"]')];
            const values = cellElements.length > 0 ? cellElements : [row];
            const semanticRow = semanticRows[rowIndex] || {};
            const cells = values.map((cell, cellIndex) => {
              const semanticColumn = semanticColumns[cellIndex] || {};
              return {
                ...(typeof semanticColumn.id === "string" ? { columnId: semanticColumn.id } : {}),
                columnLabel: typeof semanticColumn.label === "string"
                  ? semanticColumn.label
                  : headers[cellIndex] || (values.length === 1 ? "Row" : String(cellIndex + 1)),
                text: normalize(cell.innerText || cell.textContent),
              };
            }).filter((cell) => cell.text.length > 0);
            if (cells.length === 0) return;
            rows.push({
              tableIndex,
              rowIndex,
              ...(typeof semanticRow.key === "string" ? { key: semanticRow.key } : {}),
              selected: row.getAttribute("data-selected") === "true" || semanticRow.selected === true,
              cells,
            });
          });
        });
      if (rows.length === 0) {
        [...root.querySelectorAll('[data-gloom-role="desktop-list-row"]')]
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
        error: window.__GLOOM_CLI_SHOT_ERROR__ || "",
        loadingStateDetected: root.querySelector('[data-gloom-status="loading"]') !== null,
        errorStateDetected: root.querySelector('[data-gloom-status="error"]') !== null,
        emptyStateDetected: root.querySelector('[data-gloom-status="empty"]') !== null,
        rows,
        semanticUi,
      };
    })()`,
    returnByValue: true,
  }) as {
    result?: {
      value?: {
        visibleText?: string;
        error?: string;
        loadingStateDetected?: boolean;
        errorStateDetected?: boolean;
        emptyStateDetected?: boolean;
        rows?: DesktopPaneShotRenderedRow[];
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
  return {
    visibleText,
    rows: Array.isArray(value?.rows) ? value.rows : [],
    loadingStateDetected: value?.loadingStateDetected === true || loadingStateMarkers.length > 0,
    errorStateDetected: value?.errorStateDetected === true || errorStateMarkers.length > 0,
    errorStateMarkers,
    emptyStateDetected: value?.emptyStateDetected === true || emptyStateMarkers.length > 0,
    emptyStateMarkers,
    semanticUi: Array.isArray(value?.semanticUi) ? value.semanticUi : [],
  };
}

async function waitForPageWebSocket(port: number, targetUrl: string): Promise<string> {
  for (let attempt = 0; attempt < CHROME_POLL_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json() as Array<{ url?: string; type?: string; webSocketDebuggerUrl?: string }>;
        const page = targets.find((target) => (
          target.type === "page"
          && target.webSocketDebuggerUrl
          && (target.url === targetUrl || target.url?.startsWith("file:"))
        ));
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
      }
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for Chrome DevTools.");
}

async function waitForShotReady(session: CdpSession): Promise<void> {
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

class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCdpCall>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    ws.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error("Chrome DevTools connection closed."));
      }
      this.pending.clear();
    });
  }

  static connect(url: string): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new CdpSession(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error("Could not connect to Chrome DevTools.")), { once: true });
    });
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Chrome DevTools connection is not open."));
        return;
      }

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Chrome DevTools method ${method}.`));
      }, CDP_CALL_TIMEOUT_MS);
      const settle = {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };

      this.pending.set(id, settle);
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        settle.reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.ws.close();
  }

  private async handleMessage(data: unknown): Promise<void> {
    let response: CdpResponse;
    try {
      response = JSON.parse(await stringifyWebSocketMessage(data)) as CdpResponse;
    } catch {
      return;
    }
    if (!response.id) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error([response.error.message, response.error.data].filter(Boolean).join("\n")));
    } else {
      pending.resolve(response.result);
    }
  }
}

async function stringifyWebSocketMessage(data: unknown): Promise<string> {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data as Uint8Array);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data);
}
