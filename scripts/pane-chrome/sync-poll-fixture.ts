/**
 * Page for `sync-poll.ts`: the desktop view's Cloud sync on a large
 * invented workspace, with the cloud and the Bun process replaced in the
 * page. Every pull, push and baseline save crosses the same view-side path
 * as in the desktop app: Electrobun's preload (injected by the runner as the
 * native side injects it, from this checkout's patched node_modules), the
 * RPC value codec and the HTTP proxy response. Nothing leaves the page.
 */
import { createInitialState } from "../../src/core/state/app/state";
import { createDefaultConfig, createPaneInstance, type AppConfig } from "../../src/types/config";
import type { AppState } from "../../src/core/state/app/state";
import type { PricePoint, TickerFinancials } from "../../src/types/financials";
import type { TickerRecord } from "../../src/types/ticker";
import { createCoreSyncContributors } from "../../src/sync/core-contributors";
import { cloudSyncController } from "../../src/sync/controller";
import type { SyncBaselineStore, SyncSnapshot } from "../../src/sync/types";
import { decodeRpcValue, encodeRpcValue } from "../../src/renderers/electrobun/shared/rpc-codec";
import { createProxyResponse, toResponseEnvelope } from "../../src/utils/http-proxy-response";

declare global {
  interface Window {
    __electrobunSecretKeyBytes: number[];
    __electrobun_encrypt: (plaintext: string) => Promise<{ encryptedData: string; iv: string; tag: string }>;
    __electrobun_decrypt: (encryptedData: string, iv: string, tag: string) => Promise<string>;
    __syncPoll: {
      ready: boolean;
      sizes: Record<string, number>;
      poll(kind: "idle" | "quotes" | "layout"): Promise<{ blockMs: number; totalMs: number; pushed: boolean }>;
      codec(bytes: number): Promise<{ blockMs: number; totalMs: number }>;
    };
  }
}

const params = new URLSearchParams(location.search);
const count = (name: string, fallback: number) => Number(params.get(name) ?? fallback);
const POSITIONS = count("positions", 300);
const TICKERS = count("tickers", 1200);
const DAYS = count("days", 500);
const LAYOUTS = count("layouts", 10);
const PANES = count("panes", 12);
const PORTFOLIOS = 3;
const DAY_MS = 86_400_000;

// ---- the invented workspace ------------------------------------------------

function history(seed: number, last: number): PricePoint[] {
  const points: PricePoint[] = [];
  let close = 50 + (seed % 200);
  for (let day = DAYS; day >= 0; day--) {
    const date = new Date(last - day * DAY_MS);
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    close *= 1 + Math.sin(seed * 31 + day * 0.7) * 0.02;
    points.push({ date, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1_000_000 + seed });
  }
  return points;
}

function workspace(): AppState {
  const config: AppConfig = createDefaultConfig("/fixture");
  config.portfolios = Array.from({ length: PORTFOLIOS }, (_, index) => ({ id: `portfolio-${index}`, name: `Portfolio ${index}`, currency: "USD" }));
  const paneTypes = ["ticker-detail", "quote-monitor", "news", "portfolio-list", "chart", "heatmap"];
  config.layouts = Array.from({ length: LAYOUTS }, (_, layout) => {
    const instances = Array.from({ length: PANES }, (_, pane) => ({
      ...createPaneInstance(paneTypes[pane % paneTypes.length]!),
      instanceId: `pane-${layout}-${pane}`,
      settings: { columns: ["last", "change", "volume"], chartRange: "1Y", indicators: ["sma20", "rsi"] },
    }));
    return {
      name: `Layout ${layout}`,
      layout: {
        instances,
        dockRoot: null,
        detached: [],
        floating: instances.map(({ instanceId }, index) => ({ instanceId, x: index * 4, y: index * 2, width: 60, height: 24, zIndex: index })),
      },
    };
  });
  config.layout = config.layouts[0]!.layout;
  config.recentTickers = Array.from({ length: 40 }, (_, index) => `T${index}`);
  const tickers = new Map<string, TickerRecord>();
  const financials = new Map<string, TickerFinancials>();
  const last = Date.UTC(2026, 9, 16);
  for (let index = 0; index < TICKERS; index++) {
    const symbol = `T${index}`;
    const held = index < POSITIONS;
    const portfolio = `portfolio-${index % PORTFOLIOS}`;
    tickers.set(symbol, {
      metadata: {
        ticker: symbol,
        exchange: "NASDAQ",
        currency: "USD",
        name: `Invented Company ${index}`,
        portfolios: held ? [portfolio] : [],
        watchlists: held || index % 3 === 0 ? ["watchlist"] : [],
        positions: held ? [{ portfolio, shares: 10 + index, avgCost: 40, currency: "USD", broker: "manual" }] : [],
        custom: {},
        tags: [],
      },
    });
    if (held) {
      const points = history(index, last);
      financials.set(symbol, {
        annualStatements: [],
        quarterlyStatements: [],
        priceHistory: points,
        quote: { symbol, price: points.at(-1)!.close, currency: "USD", change: 0, changePercent: 0, lastUpdated: last },
      } as TickerFinancials);
    }
  }
  financials.set("SPY", { annualStatements: [], quarterlyStatements: [], priceHistory: history(9_999, last) });
  return { ...createInitialState(config), tickers, financials };
}

// ---- the Bun side and the cloud, in the page -------------------------------

// The runner sets the key and injects the preload before this script runs.
const bunKey = crypto.subtle.importKey("raw", new Uint8Array(window.__electrobunSecretKeyBytes), { name: "AES-GCM" }, false, ["encrypt"]);

/** What the Bun process sends: an encrypted packet, built outside the measured time. */
async function bunPacket(message: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await bunKey, new TextEncoder().encode(JSON.stringify(message))));
  const toBase64 = (bytes: Uint8Array) => (bytes as Uint8Array & { toBase64(): string }).toBase64();
  return JSON.stringify({ encryptedData: toBase64(sealed.subarray(0, -16)), iv: toBase64(iv), tag: toBase64(sealed.subarray(-16)) });
}

/** The view's half of one response: socket packet, preload decrypt, RPC decode, proxy response. */
async function receive(packet: string): Promise<unknown> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const { encryptedData, iv, tag } = JSON.parse(packet) as { encryptedData: string; iv: string; tag: string };
  const message = JSON.parse(await window.__electrobun_decrypt(encryptedData, iv, tag)) as { payload: { value: unknown } };
  return decodeRpcValue(message.payload.value);
}

/** The view's half of one request: RPC encode and preload encrypt; the packet goes nowhere. */
async function send(method: string, payload: unknown): Promise<void> {
  await window.__electrobun_encrypt(JSON.stringify({ type: "request", id: 1, method: "backend.request", params: { method, payload: encodeRpcValue(payload) } }));
}

let cloudSnapshot: SyncSnapshot | null = null;
let cloudRevision = 0;
let pullPacket: string | null = null;
let pushes = 0;

async function preparePull(): Promise<void> {
  const body = JSON.stringify({ snapshot: cloudSnapshot, revision: cloudRevision, updatedAt: cloudSnapshot?.createdAt ?? null });
  const envelope = await toResponseEnvelope(new Response(body, { headers: { "content-type": "application/json" } }));
  pullPacket = await bunPacket({ type: "response", id: 1, success: true, payload: { __gloomRpcResponse: 1, ok: true, value: encodeRpcValue(envelope) } });
}

const baseline: Record<string, Record<string, unknown> | null> = {};
const baselineStore: SyncBaselineStore = {
  load: () => baseline.payloads ?? null,
  save: (payloads) => {
    baseline.payloads = payloads;
    void send("persistence.setPluginState", { pluginId: "core.sync", key: "last-synced-payloads", value: payloads });
  },
  loadMemos: () => baseline.memos ?? null,
  saveMemos: (memos) => {
    baseline.memos = memos;
    void send("persistence.setPluginState", { pluginId: "core.sync", key: "contributor-memos", value: memos });
  },
};

// ---- main-thread blocks ----------------------------------------------------

let lastBeat = performance.now();
let longestBlock = 0;
function beat(): void {
  const now = performance.now();
  longestBlock = Math.max(longestBlock, now - lastBeat);
  lastBeat = now;
  setTimeout(beat, 0);
}

/** One message of `bytes` each way through the preload codec, as a large RPC response and request are. */
async function codec(bytes: number): Promise<{ blockMs: number; totalMs: number }> {
  const text = JSON.stringify({ rows: Array.from({ length: Math.ceil(bytes / 64) }, (_, index) => ({ t: 1_700_000_000 + index, c: 100 + (index % 97) / 7 })) }).slice(0, bytes);
  const packet = await bunPacket({ type: "response", id: 1, success: true, payload: text });
  await new Promise((resolve) => setTimeout(resolve, 50));
  longestBlock = 0;
  lastBeat = performance.now();
  const start = performance.now();
  const { encryptedData, iv, tag } = JSON.parse(packet) as { encryptedData: string; iv: string; tag: string };
  await window.__electrobun_decrypt(encryptedData, iv, tag);
  await window.__electrobun_encrypt(text);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return { blockMs: Math.round(longestBlock * 10) / 10, totalMs: Math.round(performance.now() - start) };
}

async function boot(): Promise<void> {
  for (let attempt = 0; typeof window.__electrobun_decrypt !== "function"; attempt++) {
    if (attempt > 200) throw new Error("the preload did not set up its codec");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  let state = workspace();
  const contributors = createCoreSyncContributors().map((contributor) => ({ pluginId: "core", contributor }));
  const transport = {
    id: "fixture",
    isAvailable: () => true,
    async pullSnapshot() {
      if (!pullPacket) await preparePull();
      const envelope = await receive(pullPacket!);
      return await createProxyResponse(envelope as never).json();
    },
    async pushSnapshot(snapshot: SyncSnapshot, options?: { baseRevision?: number | null }) {
      pushes++;
      await send("http.fetch", { url: "https://cloud.invalid/sync/snapshot", init: { method: "PUT", body: JSON.stringify({ snapshot, baseRevision: options?.baseRevision ?? null }) } });
      // Stored as sent; the copy the next pull returns is made outside the measured time.
      cloudSnapshot = snapshot;
      cloudRevision++;
      pullPacket = null;
      return { revision: cloudRevision, updatedAt: snapshot.createdAt };
    },
  };
  cloudSyncController.setRuntime({
    getState: () => state,
    dispatch: () => {},
    tickerRepository: { saveTicker: async () => {}, deleteTicker: async () => {} } as never,
    getContributors: () => contributors as never,
    getTransport: () => ({ pluginId: "fixture", transport }) as never,
    baselineStore,
  });
  // The first sync uploads the workspace, as on a device that has never pushed.
  await cloudSyncController.requestSync({ reason: "startup" });
  await preparePull();
  beat();

  let tick = 0;
  window.__syncPoll = {
    ready: true,
    codec,
    sizes: { snapshotBytes: JSON.stringify(cloudSnapshot).length, positions: POSITIONS, tickers: TICKERS, days: DAYS },
    async poll(kind) {
      tick++;
      if (kind === "quotes") {
        // A quote refresh: new quotes, the same bar histories.
        const financials = new Map(state.financials);
        for (const [symbol, entry] of financials) {
          if (!entry.quote) continue;
          financials.set(symbol, { ...entry, quote: { ...entry.quote, price: entry.quote.price * (1 + Math.sin(tick + symbol.length) * 0.001) } });
        }
        state = { ...state, financials };
      } else if (kind === "layout") {
        state = { ...state, config: { ...state.config, activeLayoutIndex: tick % LAYOUTS, layout: state.config.layouts[tick % LAYOUTS]!.layout } };
      }
      if (!pullPacket) await preparePull();
      const pushedBefore = pushes;
      await new Promise((resolve) => setTimeout(resolve, 50));
      longestBlock = 0;
      lastBeat = performance.now();
      const start = performance.now();
      await cloudSyncController.requestSync({ reason: "poll" });
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { blockMs: Math.round(longestBlock * 10) / 10, totalMs: Math.round(performance.now() - start), pushed: pushes > pushedBefore };
    },
  };
}

void boot().catch((error) => {
  console.error(error);
  document.title = `error: ${error instanceof Error ? error.message : String(error)}`;
});
