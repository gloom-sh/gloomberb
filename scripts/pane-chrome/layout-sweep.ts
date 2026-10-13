import { appendFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir, evaluate, launchBrowser, sleep, type Cdp } from "./browser";
import { LAYOUT_SIZES } from "./layout-checks";
import { LAYOUT_MEASURE, layoutFailures, type LayoutMeasure } from "./layout-measure";

/**
 * Every function in the catalog on the real web build, docked and floating, at
 * three window sizes, with its detail opened where Enter opens one: where each
 * pane's content stops against its footer and its width (layout-measure.ts).
 * The layout checks hold a few fixtures to this in CI; this is the whole
 * registry, on demand.
 *
 *   bun run web:build
 *   bun run check:pane-layout [--only TRIAL,CHG] [--shard 0/3] [--out <dir>] [--root <checkout>]
 *
 * Functions open through the command bar, signed out, so a function behind
 * sign-in shows its gate. The page reads Gloom Cloud through a local stand-in
 * for the web app's worker: GETs and the market batch reads go to the public
 * API and are kept under the cache folder for the next run, and every page
 * runs on the first run's clock so the next run asks for the same dates; every
 * write, the live socket and telemetry are refused. Results, a summary of every failing
 * pane and a picture of each view go to `--out` (default
 * ~/.cache/gloomberb-pane-chrome/layout-sweep).
 */

const UPSTREAM = "https://api.gloom.sh";
const READ_POSTS = /^\/api\/market\/[a-z-]+\/batch$/;
const REFUSED = /telemetry|crash|usage|analytics|research-activity|\/events|collect|beacon|track|posthog|sentry/i;

interface CatalogEntry { token: string; paneId: string; argKind?: string | null; defaultSettings?: Record<string, unknown> }
interface Answer { status: number; type: string; bytes: Uint8Array<ArrayBuffer> }

const args = process.argv.slice(2);
const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
const only = takeOption(args, "--only")?.split(",");
const [shardIndex, shardCount] = (takeOption(args, "--shard") ?? "0/1").split("/").map(Number) as [number, number];
const out = resolve(takeOption(args, "--out") ?? cacheDir("layout-sweep"));
const replay = cacheDir("layout-sweep-replay");

function keyOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 40);
}

/** The text of every answer served this run: a cut string found here arrived cut, the page did not cut it. */
const served = new Set<string>();

function remember(answer: Answer): Answer {
  if (/json|text|xml/.test(answer.type) && answer.bytes.length < 8_000_000) served.add(new TextDecoder().decode(answer.bytes));
  return answer;
}

/** Whether `text` came in an answer as it is: raw, or escaped in a JSON string. */
function arrived(text: string): boolean {
  if (text.length < 8) return false;
  const escaped = JSON.stringify(text).slice(1, -1);
  for (const body of served) if (body.includes(text) || body.includes(escaped)) return true;
  return false;
}

/** A read the page made before, from disk; otherwise from upstream, kept when it worked. */
async function read(label: string, load: () => Promise<Answer>): Promise<Answer> {
  const file = join(replay, keyOf(label));
  if (await Bun.file(`${file}.json`).exists()) {
    const meta = await Bun.file(`${file}.json`).json();
    return remember({ status: meta.status, type: meta.type, bytes: new Uint8Array(await Bun.file(`${file}.body`).arrayBuffer()) });
  }
  const fresh = remember(await load().catch((error) => ({ status: 502, type: "text/plain", bytes: new TextEncoder().encode(String(error)) })));
  if (fresh.status < 500 && fresh.status !== 429) {
    await mkdir(replay, { recursive: true });
    await Bun.write(`${file}.body`, fresh.bytes);
    await Bun.write(`${file}.json`, JSON.stringify({ status: fresh.status, type: fresh.type, label }));
  }
  return fresh;
}

async function upstream(url: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("event-stream")) return { status: 503, type: "text/plain", bytes: new TextEncoder().encode("No streams") };
  return { status: response.status, type, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** The web build, with /api and the plugin proxy answered as the worker would for a signed-out visitor. */
function serve(): { url: string; stop(): void } {
  const dist = join(root, "dist/web");
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
        const answer = await read(`${request.method} ${target}\n${body}`, () => upstream(`${UPSTREAM}${target.slice(4)}`, {
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
        const answer = await read(`PROXY ${envelope.url}`, async () => {
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

/**
 * The time every page starts at: the first run's, kept with the reads. A pane
 * asks for dates from the clock (an options chain's expiries, a week's
 * calendar), so on a later day a replay would ask for dates it never kept and
 * draw an empty state instead of the pane.
 */
async function sweepClock(): Promise<number> {
  const file = Bun.file(join(replay, "clock.json"));
  if (await file.exists()) return (await file.json()).ms;
  const ms = Date.now();
  await mkdir(replay, { recursive: true });
  await Bun.write(file, JSON.stringify({ ms, iso: new Date(ms).toISOString() }));
  return ms;
}

/** A fresh workspace each load: one layout, onboarding done, usage and crash reports off, and the sweep's clock. */
function seedScript(layout: object, clockMs: number, focused?: string): string {
  const config = { layouts: [{ name: "Sweep", layout, ...(focused ? { focusedPaneId: focused } : {}) }], activeLayoutIndex: 0, layout, onboardingComplete: true, telemetry: { crashReports: false, usage: false } };
  return `(() => {
  const RealDate = Date, startedAt = RealDate.now(), now = () => ${clockMs} + (RealDate.now() - startedAt);
  globalThis.Date = class extends RealDate { constructor(...args) { if (args.length === 0) super(now()); else super(...args); } static now() { return now(); } };
})();
localStorage.clear(); localStorage.setItem("gloomberb.web.config.v1", ${JSON.stringify(JSON.stringify(config))});`;
}

async function load(cdp: Cdp, url: string, layout: object, focused?: string): Promise<void> {
  const { identifier } = await cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: seedScript(layout, await sweepClock(), focused) });
  const loaded = cdp.once("Page.loadEventFired", 60_000);
  await cdp.send("Page.navigate", { url });
  await loaded;
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
}

/** Until nothing in `scope` has changed for `quietMs`, at most `maxMs`. */
async function settle(cdp: Cdp, scope: string, quietMs = 800, maxMs = 9_000): Promise<void> {
  await evaluate(cdp, `(() => { window.__changed = performance.now(); window.__settle?.disconnect(); const root = document.querySelector(${JSON.stringify(scope)}) ?? document.body; window.__settle = new MutationObserver(() => { window.__changed = performance.now(); }); window.__settle.observe(root, { subtree: true, childList: true, attributes: true, characterData: true }); })()`);
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await sleep(200);
    if (await evaluate<number>(cdp, "performance.now() - window.__changed") >= quietMs) return;
  }
}

async function key(cdp: Cdp, keyName: string, code: string, keyCode: number, modifiers = 0, text?: string): Promise<void> {
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers, ...(text ? { text } : {}) });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers });
}

/** The pane a function opens through the command bar, as the app saves it. */
async function discover(cdp: Cdp, url: string, entry: CatalogEntry): Promise<Record<string, unknown> | null> {
  await load(cdp, url, { dockRoot: null, instances: [], floating: [], detached: [] });
  await sleep(800);
  await key(cdp, "p", "KeyP", 80, 2);
  await sleep(300);
  const query = `${entry.token} ${argument(entry)}`.trim();
  for (const char of query) await key(cdp, char, "", 0, 0, char);
  await sleep(900);
  await key(cdp, "Enter", "Enter", 13);
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

function argument(entry: CatalogEntry): string {
  if (entry.argKind === "ticker") return "AAPL";
  if (entry.argKind === "tickers" || entry.argKind === "symbol-list") return "AAPL,MSFT";
  return "";
}

function layoutFor(instance: Record<string, unknown>, mode: "dock" | "float", width: number, height: number, cell: { width: number; height: number }): object {
  const id = instance.instanceId as string;
  if (mode === "dock") return { dockRoot: { kind: "pane", instanceId: id }, instances: [instance], floating: [], detached: [] };
  const columns = width / cell.width, rows = height / cell.height;
  return { dockRoot: null, instances: [instance], floating: [{ instanceId: id, x: 2.5, y: 2.25, width: Math.round(columns * 78) / 100 + 0.37, height: Math.round(rows * 78) / 100 + 0.41, zIndex: 50 }], detached: [] };
}

async function shot(cdp: Cdp, scope: string, file: string): Promise<void> {
  const rect = await evaluate<{ x: number; y: number; width: number; height: number } | null>(cdp, `(() => { const r = document.querySelector(${JSON.stringify(scope)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`);
  const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 70, ...(rect ? { clip: { ...rect, scale: 1 } } : {}) });
  await Bun.write(file, Buffer.from(data, "base64"));
}

async function main(): Promise<void> {
  if (!await Bun.file(join(root, "dist/web/index.html")).exists()) throw new Error(`No web build in ${root}; run bun run web:build first.`);
  const listed = Bun.spawnSync(["bun", "src/cli/entry.ts", "catalog", "--all", "--json"], { cwd: root, env: { ...process.env, GLOOMBERB_HOME: cacheDir("layout-sweep-home") } });
  const catalog = (JSON.parse(listed.stdout.toString()).data as CatalogEntry[])
    .filter((entry, index) => index % shardCount === shardIndex && (!only || only.includes(entry.token)));
  await mkdir(join(out, "shots"), { recursive: true });
  const app = serve();
  const browser = await launchBrowser("layout-sweep", LAYOUT_SIZES[1].width, LAYOUT_SIZES[1].height);
  const { cdp } = browser;
  const rows: string[] = [];
  const results: unknown[] = [];
  try {
    // Reads the web app makes straight from another site (the release feed) go through the same reads.
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
      const answer = await read(`DIRECT ${request.url}`, () => upstream(request.url, { headers: { accept: request.headers?.Accept ?? "*/*" } }));
      await cdp.send("Fetch.fulfillRequest", {
        requestId,
        responseCode: answer.status,
        responseHeaders: [{ name: "content-type", value: answer.type || "application/octet-stream" }, { name: "access-control-allow-origin", value: "*" }],
        body: Buffer.from(answer.bytes).toString("base64"),
      }).catch(() => {});
    });
    await cdp.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
    for (const entry of catalog) {
      const instance = await discover(cdp, app.url, entry) ?? {
        instanceId: `${entry.paneId}:sweep`,
        paneId: entry.paneId,
        binding: argument(entry) ? { kind: "fixed", symbol: "AAPL" } : { kind: "none" },
        ...(entry.defaultSettings ? { settings: entry.defaultSettings } : {}),
      };
      const scope = `[data-gloom-pane-id="${instance.instanceId as string}"]`;
      for (const mode of ["dock", "float"] as const) {
        for (const size of LAYOUT_SIZES) {
          await cdp.send("Emulation.setDeviceMetricsOverride", { ...size, deviceScaleFactor: 1, mobile: false });
          const cell = await evaluate<{ width: number; height: number }>(cdp, `({ width: parseFloat(getComputedStyle(document.body).getPropertyValue("--cell-w")) || 8, height: parseFloat(getComputedStyle(document.body).getPropertyValue("--cell-h")) || 18 })`);
          await load(cdp, app.url, layoutFor(instance, mode, size.width, size.height, cell), instance.instanceId as string);
          await settle(cdp, scope);
          for (const view of ["root", "detail"] as const) {
            if (view === "detail") {
              const before = await evaluate<string>(cdp, `document.querySelector(${JSON.stringify(scope)})?.innerText ?? ""`);
              await key(cdp, "Enter", "Enter", 13);
              await settle(cdp, scope, 700, 6_000);
              if (await evaluate<string>(cdp, `document.querySelector(${JSON.stringify(scope)})?.innerText ?? ""`) === before) continue;
            }
            const measure = await evaluate<LayoutMeasure>(cdp, LAYOUT_MEASURE(instance.instanceId as string));
            if (measure.missing) continue;
            // A headline a feed sent already cut is the source's, not a count of columns.
            measure.arrivedCut = measure.cut.filter((entry) => arrived(entry.whole));
            measure.cut = measure.cut.filter((entry) => !measure.arrivedCut!.includes(entry));
            const name = `${entry.token}-${mode}-${size.width}x${size.height}-${view}`;
            await shot(cdp, scope, join(out, "shots", `${name}.jpg`));
            const failures = layoutFailures(measure);
            results.push({ token: entry.token, paneId: entry.paneId, mode, size, view, failures, measure });
            if (failures.length > 0) rows.push(`| ${entry.token} | ${view} | ${mode} ${size.width}x${size.height} | ${failures.join("; ").replace(/\|/g, "/")} |`);
          }
        }
      }
      console.log(`${entry.token}: ${rows.filter((row) => row.startsWith(`| ${entry.token} |`)).length} failing views`);
    }
  } finally {
    await browser.close();
    app.stop();
  }
  await Bun.write(join(out, `results-${shardIndex}of${shardCount}.json`), JSON.stringify(results, null, 1));
  const summary = ["| Function | View | Layout | What fails |", "|---|---|---|---|", ...rows].join("\n");
  await Bun.write(join(out, `summary-${shardIndex}of${shardCount}.md`), `${summary}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Pane layout sweep\n\n${summary}\n`);
  console.log(`\n${rows.length} failing views in ${catalog.length} functions; ${join(out, `summary-${shardIndex}of${shardCount}.md`)}`);
  if (rows.length > 0) process.exitCode = 1;
}

await main();
