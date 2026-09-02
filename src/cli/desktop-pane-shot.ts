import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
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
  tickers: TickerRecord[];
  financials: Array<[string, TickerFinancials]>;
  optionsChains: Array<[string, OptionsChain]>;
  fredSeries: Array<[string, FredSeriesCacheEntry]>;
  valuationSeries: Array<[string, DatedObservation[]]>;
  capabilitySeries: Array<[string, ResolvedSeries]>;
  paneState: Record<string, PaneRuntimeState>;
}

export interface DesktopPaneShotRenderResult {
  visibleText: string;
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

const CHROME_POLL_ATTEMPTS = 80;
const SHOT_READY_TIMEOUT_MS = 10_000;
const CDP_CALL_TIMEOUT_MS = 10_000;
const SHOT_DEVICE_SCALE_FACTOR = 2;

export async function renderDesktopPaneScreenshot(
  payload: DesktopPaneShotPayload,
  outputPath: string,
): Promise<DesktopPaneShotRenderResult> {
  const tempDir = await mkdtemp(join(tmpdir(), "gloom-pane-shot-"));
  try {
    const outdir = join(tempDir, "assets");
    await mkdir(outdir, { recursive: true });
    const htmlPath = await buildShotPage(outdir, payload);
    const chrome = await findChromeExecutable();
    return await capturePageScreenshot({
      chrome,
      url: pathToFileURL(htmlPath).href,
      outputPath,
      widthPx: payload.widthPx,
      heightPx: payload.heightPx,
      userDataDir: join(tempDir, "chrome-profile"),
    });
  } finally {
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
      window.addEventListener("error", (event) => {
        window.__GLOOM_CLI_SHOT_ERROR__ = event.error && event.error.stack ? event.error.stack : String(event.error || event.message);
      });
      window.addEventListener("unhandledrejection", (event) => {
        window.__GLOOM_CLI_SHOT_ERROR__ = event.reason && event.reason.stack ? event.reason.stack : String(event.reason);
      });
`,
  });
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
  userDataDir,
}: {
  chrome: string;
  url: string;
  outputPath: string;
  widthPx: number;
  heightPx: number;
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
      deviceScaleFactor: SHOT_DEVICE_SCALE_FACTOR,
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

const EMPTY_STATE_PATTERNS = [
  /\bNo chart data\b/gi,
  /\bNo graph data\b/gi,
  /\bNo historical prices\b/gi,
  /\bNo financial statement rows\b/gi,
  /\bNo comparison tickers configured\b/gi,
  /\bNo relationship tickers configured\b/gi,
  /\bNo overlapping price history\b/gi,
  /\bLoading chart\.{0,3}\b/gi,
  /\bRendering pane\.{0,3}\b/gi,
  /\bNo tickers selected\b/gi,
  /\bMarket data unavailable\b/gi,
  /\bNo data(?: available)?\b/gi,
];

async function readRenderedPaneState(session: CdpSession): Promise<DesktopPaneShotRenderResult> {
  const result = await session.send("Runtime.evaluate", {
    expression: `(() => {
      const root = document.getElementById("root") || document.body;
      return {
        visibleText: root.innerText || root.textContent || "",
        error: window.__GLOOM_CLI_SHOT_ERROR__ || "",
        semanticUi: window.__GLOOM_CLI_SHOT_SEMANTIC_UI__ || [],
      };
    })()`,
    returnByValue: true,
  }) as {
    result?: {
      value?: {
        visibleText?: string;
        error?: string;
        semanticUi?: RemoteUiNodeSnapshot[];
      };
    };
  };
  const value = result.result?.value;
  if (value?.error) throw new Error(value.error);
  const visibleText = (value?.visibleText ?? "").replace(/\s+/g, " ").trim();
  const emptyStateMarkers = [...new Set(EMPTY_STATE_PATTERNS.flatMap((pattern) => (
    [...visibleText.matchAll(pattern)].map((match) => match[0])
  )))];
  return {
    visibleText,
    emptyStateDetected: emptyStateMarkers.length > 0,
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
