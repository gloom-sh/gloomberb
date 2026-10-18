import { mkdir } from "fs/promises";
import { join } from "path";
import { evaluate, sleep, type Cdp } from "./browser";

/**
 * The real web build in headless Chrome, signed out, for the sweeps that open
 * every function: the layout sweep (layout-sweep.ts) and the UI audit
 * (ui-audit.ts).
 *
 * The page reads Gloom Cloud through a local stand-in for the web app's
 * worker: GETs and the market batch reads go to the public API and are kept
 * under a replay folder for the next run, and every page runs on the first
 * run's clock so the next run asks for the same dates; every write, the live
 * socket and telemetry are refused.
 *
 * An offline replay never reaches upstream: a read it did not keep is
 * answered 503, so a run on a kept snapshot draws the same views every time
 * (the CI checks), and one with no snapshot draws every pane's offline state.
 */

const UPSTREAM = "https://api.gloom.sh";
const READ_POSTS = /^\/api\/market\/[a-z-]+\/batch$/;
const REFUSED = /telemetry|crash|usage|analytics|research-activity|\/events|collect|beacon|track|posthog|sentry/i;

export interface CatalogEntry { token: string; paneId: string; argKind?: string | null; defaultSettings?: Record<string, unknown> }
interface Answer { status: number; type: string; bytes: Uint8Array<ArrayBuffer> }

function keyOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 40);
}

async function upstream(url: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("event-stream")) return { status: 503, type: "text/plain", bytes: new TextEncoder().encode("No streams") };
  return { status: response.status, type, bytes: new Uint8Array(await response.arrayBuffer()) };
}

interface Replay {
  /** A read the page made before, from disk; otherwise from upstream, kept when it worked. */
  read(label: string, load: () => Promise<Answer>): Promise<Answer>;
  /** Whether `text` came in an answer as it is: raw, or escaped in a JSON string. */
  arrived(text: string): boolean;
  /** The time every page starts at: the first run's, kept with the reads. */
  clock(): Promise<number>;
}

/** The clock of an offline run with no snapshot: a fixed weekday morning, so dated panes ask for the same dates. */
const OFFLINE_CLOCK_MS = Date.UTC(2026, 0, 6, 14, 30);

/** Answered for a read an offline replay did not keep, as the worker answers when Gloom Cloud is down. */
const NOT_KEPT: Answer = { status: 503, type: "text/plain", bytes: new TextEncoder().encode("Not in the replay") };

export function createReplay(dir: string, { offline = false }: { offline?: boolean } = {}): Replay {
  /** The text of every answer served this run: a cut string found here arrived cut, the page did not cut it. */
  const served = new Set<string>();
  const remember = (answer: Answer): Answer => {
    if (/json|text|xml/.test(answer.type) && answer.bytes.length < 8_000_000) served.add(new TextDecoder().decode(answer.bytes));
    return answer;
  };
  return {
    async read(label, load) {
      const file = join(dir, keyOf(label));
      if (await Bun.file(`${file}.json`).exists()) {
        const meta = await Bun.file(`${file}.json`).json();
        return remember({ status: meta.status, type: meta.type, bytes: new Uint8Array(await Bun.file(`${file}.body`).arrayBuffer()) });
      }
      if (offline) return NOT_KEPT;
      const fresh = remember(await load().catch((error) => ({ status: 502, type: "text/plain", bytes: new TextEncoder().encode(String(error)) })));
      if (fresh.status < 500 && fresh.status !== 429) {
        await mkdir(dir, { recursive: true });
        await Bun.write(`${file}.body`, fresh.bytes);
        await Bun.write(`${file}.json`, JSON.stringify({ status: fresh.status, type: fresh.type, label }));
      }
      return fresh;
    },
    arrived(text) {
      if (text.length < 8) return false;
      const escaped = JSON.stringify(text).slice(1, -1);
      for (const body of served) if (body.includes(text) || body.includes(escaped)) return true;
      return false;
    },
    // A pane asks for dates from the clock (an options chain's expiries, a
    // week's calendar), so on a later day a replay would ask for dates it
    // never kept and draw an empty state instead of the pane.
    async clock() {
      const file = Bun.file(join(dir, "clock.json"));
      if (await file.exists()) return (await file.json()).ms;
      // With nothing kept, an offline run still needs one clock for every page: a fixed one.
      if (offline) return OFFLINE_CLOCK_MS;
      const ms = Date.now();
      await mkdir(dir, { recursive: true });
      await Bun.write(file, JSON.stringify({ ms, iso: new Date(ms).toISOString() }));
      return ms;
    },
  };
}

/** The web build in `dist`, with /api and the plugin proxy answered as the worker would for a signed-out visitor. */
export function serveWebApp(dist: string, replay: Replay): { url: string; stop(): void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 120,
    async fetch(request) {
      const url = new URL(request.url);
      const target = `${url.pathname}${url.search}`;
      if (url.pathname.startsWith("/api/")) {
        const body = request.method === "POST" ? await request.text() : "";
        const isRead = request.method === "GET" || (request.method === "POST" && READ_POSTS.test(url.pathname));
        if (!isRead || REFUSED.test(url.pathname) || url.pathname === "/api/cloud/ws") return new Response("Refused in the sweep", { status: 503 });
        const answer = await replay.read(`${request.method} ${target}\n${body}`, () => upstream(`${UPSTREAM}${target.slice(4)}`, {
          method: request.method,
          headers: body ? { "content-type": "application/json" } : {},
          body: body || undefined,
        }));
        return new Response(answer.status === 204 ? null : answer.bytes, { status: answer.status, headers: answer.type ? { "content-type": answer.type } : {} });
      }
      if (url.pathname === "/http-proxy") {
        const envelope = await request.json().catch(() => null) as { url?: string; init?: { method?: string } } | null;
        if (!envelope?.url || (envelope.init?.method ?? "GET").toUpperCase() !== "GET" || REFUSED.test(envelope.url)) {
          return Response.json({ error: "Refused in the sweep" }, { status: 403 });
        }
        const answer = await replay.read(`PROXY ${envelope.url}`, async () => {
          const response = await fetch(envelope.url!, { signal: AbortSignal.timeout(45_000) });
          const headers: Record<string, string> = {};
          response.headers.forEach((value, name) => { if (name !== "set-cookie") headers[name] = value; });
          const wrapped = { status: response.status, statusText: response.statusText, headers, body: await response.text() };
          return { status: 200, type: "application/json", bytes: new TextEncoder().encode(JSON.stringify(wrapped)) };
        });
        return new Response(answer.bytes, { status: answer.status, headers: { "content-type": answer.type } });
      }
      const file = Bun.file(join(dist, url.pathname.slice(1)));
      if (!url.pathname.includes("..") && url.pathname !== "/" && await file.exists()) return new Response(file);
      return new Response(Bun.file(join(dist, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

/** Reads the web app makes straight from another site (the release feed) go through the same replay. */
export async function routeDirectReads(cdp: Cdp, replay: Replay): Promise<void> {
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://*" }] });
  cdp.on("Fetch.requestPaused", async (event: any) => {
    const { requestId, request } = event;
    if (request.method === "OPTIONS") {
      await cdp.send("Fetch.fulfillRequest", { requestId, responseCode: 204, responseHeaders: [{ name: "access-control-allow-origin", value: "*" }, { name: "access-control-allow-headers", value: "*" }] }).catch(() => {});
      return;
    }
    if (request.method !== "GET" || REFUSED.test(request.url)) {
      await cdp.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }).catch(() => {});
      return;
    }
    const answer = await replay.read(`DIRECT ${request.url}`, () => upstream(request.url, { headers: { accept: request.headers?.Accept ?? "*/*" } }));
    await cdp.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: answer.status,
      responseHeaders: [{ name: "content-type", value: answer.type || "application/octet-stream" }, { name: "access-control-allow-origin", value: "*" }],
      body: Buffer.from(answer.bytes).toString("base64"),
    }).catch(() => {});
  });
}

/** Saved settings a sweep can give the page beyond its layout: the theme, or onboarding left to run. */
export interface SeedOptions { theme?: string; onboardingComplete?: boolean }

/** A fresh workspace each load: one layout, onboarding done, usage and crash reports off, and the sweep's clock. */
function seedScript(layout: object, clockMs: number, focused?: string, options: SeedOptions = {}): string {
  const config = {
    layouts: [{ name: "Sweep", layout, ...(focused ? { focusedPaneId: focused } : {}) }],
    activeLayoutIndex: 0,
    layout,
    onboardingComplete: options.onboardingComplete ?? true,
    telemetry: { crashReports: false, usage: false },
    ...(options.theme ? { theme: options.theme } : {}),
  };
  return `(() => {
  const RealDate = Date, startedAt = RealDate.now(), now = () => ${clockMs} + (RealDate.now() - startedAt);
  globalThis.Date = class extends RealDate { constructor(...args) { if (args.length === 0) super(now()); else super(...args); } static now() { return now(); } };
})();
localStorage.clear(); localStorage.setItem("gloomberb.web.config.v1", ${JSON.stringify(JSON.stringify(config))});`;
}

export async function loadLayout(cdp: Cdp, url: string, replay: Replay, layout: object, focused?: string, options?: SeedOptions): Promise<void> {
  const { identifier } = await cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: seedScript(layout, await replay.clock(), focused, options) });
  const loaded = cdp.once("Page.loadEventFired", 60_000);
  await cdp.send("Page.navigate", { url });
  await loaded;
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
}

/** Until nothing in `scope` has changed for `quietMs`, at most `maxMs`. */
export async function settle(cdp: Cdp, scope: string, quietMs = 800, maxMs = 9_000): Promise<void> {
  await evaluate(cdp, `(() => { window.__changed = performance.now(); window.__settle?.disconnect(); const root = document.querySelector(${JSON.stringify(scope)}) ?? document.body; window.__settle = new MutationObserver(() => { window.__changed = performance.now(); }); window.__settle.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); })()`);
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await sleep(200);
    if (await evaluate<number>(cdp, "performance.now() - window.__changed") >= quietMs) return;
  }
}

export async function key(cdp: Cdp, keyName: string, code: string, keyCode: number, modifiers = 0, text?: string): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
}

/** Types `query` into the command bar (Ctrl+P) and runs it. */
export async function runCommand(cdp: Cdp, query: string, { submit = true } = {}): Promise<void> {
  await key(cdp, "p", "KeyP", 80, 2);
  await sleep(300);
  for (const char of query) await key(cdp, char, "", 0, 0, char);
  await sleep(900);
  if (submit) await key(cdp, "Enter", "Enter", 13);
}

function argument(entry: CatalogEntry): string {
  if (entry.argKind === "ticker") return "AAPL";
  if (entry.argKind === "tickers" || entry.argKind === "symbol-list") return "AAPL,MSFT";
  return "";
}

const EMPTY_LAYOUT = { dockRoot: null, instances: [], floating: [], detached: [] };

/** The pane a function opens through the command bar, as the app saves it. */
export async function discover(cdp: Cdp, url: string, replay: Replay, entry: CatalogEntry): Promise<Record<string, unknown> | null> {
  await loadLayout(cdp, url, replay, EMPTY_LAYOUT);
  await sleep(800);
  await runCommand(cdp, `${entry.token} ${argument(entry)}`.trim());
  await sleep(1200);
  await evaluate(cdp, `window.dispatchEvent(new Event("pagehide"))`);
  await sleep(300);
  const config = JSON.parse(await evaluate<string>(cdp, `localStorage.getItem("gloomberb.web.config.v1")`) ?? "{}");
  const instances = (config.layouts?.[config.activeLayoutIndex ?? 0]?.layout?.instances ?? []) as Array<Record<string, unknown>>;
  const instance = instances.find((item) => item.paneId === entry.paneId) ?? instances[0];
  if (!instance) return null;
  const { placementMemory: _memory, ...rest } = instance;
  return rest;
}

/** The instance a function's pane opens as when the command bar did not open one. */
export function fallbackInstance(entry: CatalogEntry): Record<string, unknown> {
  return {
    instanceId: `${entry.paneId}:sweep`,
    paneId: entry.paneId,
    binding: argument(entry) ? { kind: "fixed", symbol: "AAPL" } : { kind: "none" },
    ...(entry.defaultSettings ? { settings: entry.defaultSettings } : {}),
  };
}

export async function shot(cdp: Cdp, scope: string | null, file: string, format: "jpeg" | "png" = "jpeg"): Promise<void> {
  const rect = scope ? await evaluate<{ x: number; y: number; width: number; height: number } | null>(cdp, `(() => { const r = document.querySelector(${JSON.stringify(scope)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`) : null;
  const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format, ...(format === "jpeg" ? { quality: 70 } : {}), ...(rect ? { clip: { ...rect, scale: 1 } } : {}) });
  await Bun.write(file, Buffer.from(data, "base64"));
}

/** Every function in the catalog, from the CLI of the checkout at `root`. */
export function readCatalog(root: string, home: string): CatalogEntry[] {
  const listed = Bun.spawnSync(["bun", "src/cli/entry.ts", "catalog", "--all", "--json"], { cwd: root, env: { ...process.env, GLOOMBERB_HOME: home } });
  return JSON.parse(listed.stdout.toString()).data as CatalogEntry[];
}
