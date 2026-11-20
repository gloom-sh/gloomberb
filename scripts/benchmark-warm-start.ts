import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join, resolve } from "path";
import type { AppConfig, DockLayoutNode, SavedLayout } from "../src/types/config";
import { testAppEnv } from "./test-app-env";
import { evaluate, launchBrowser, sleep } from "./pane-chrome/browser";
import { routeDirectReads } from "./pane-chrome/web-app";
import { median, positiveInteger, runTmux, shellQuote, takeOption, writeFreshInstallConfig } from "./tui-benchmark-harness";
import type { WarmStartPlan } from "./warm-start/plan";
import { domProbeSource, type PaneShownState, type PaneTimeline, type ProbeEntry } from "./warm-start/pane-states";
import { installWarmStartNetwork } from "./warm-start/network";
import { startWarmStartWebServer, type WarmStartWebServer } from "./warm-start/web-server";
import { startDesktopStandIn, type DesktopStandIn } from "./warm-start/desktop-stand-in";

/**
 *   bun scripts/benchmark-warm-start.ts <tui|web|desktop> [--runs 5] [--network normal,slow]
 *     [--layouts 1,2] [--label before] [--app <checkout>] [--root <dir>] [--out <dir>]
 *     [--metrics] [--heap-snapshot] [--settle-ms 18000]
 *
 * A warm restart, pane by pane. One pane of every type the catalog lists
 * (scripts/warm-start/plan.ts) is laid out in layouts of 16; for each layout
 * the app is launched once to fill its caches and is killed, then the profile
 * left by that exit is restored before each of `--runs` restarts per network.
 * Every frame, each pane's body is read as blank,
 * loading, empty, error or content (scripts/warm-start/pane-states.ts), and
 * the report gives per pane and renderer:
 *
 * - first content: ms from launch to the first frame with content (p50, worst),
 *   and the frames between the pane's own first frame and that one;
 * - loading shown: in how many runs the pane showed a loading or empty state
 *   at any point although the fill launch left it with content to keep.
 *
 * Renderers: `tui` the terminal in tmux; `web` the web build (`--build` runs
 * `bun run web:build`) in headless Chromium, served the way the Worker serves
 * it; `desktop` the desktop view in headless Chromium against a stand-in for
 * the desktop's Bun process that keeps its data in the same SQLite cache
 * (scripts/warm-start/desktop-stand-in.ts). The network is
 * scripts/warm-start/network.ts: each read goes out once and is replayed
 * after the time it took; `slow` adds 5 s to every answer.
 *
 * Profiles live under `--root` (default ~/.cache/gloom-smoke/warm-start); the
 * replayed reads are shared by every renderer and label so a before and an
 * after run see the same answers.
 */

type Target = "tui" | "web" | "desktop";
type Network = "normal" | "slow";

const args = process.argv.slice(2);
const target = args[0] as Target;
if (!["tui", "web", "desktop"].includes(target)) throw new Error("Usage: benchmark-warm-start.ts <tui|web|desktop> [--runs 5] [--network normal,slow]");
const runs = positiveInteger(takeOption(args, "--runs"), 5, "runs");
const networks = (takeOption(args, "--network") ?? "normal,slow").split(",") as Network[];
const label = takeOption(args, "--label") ?? "run";
const root = resolve(takeOption(args, "--root") ?? join(homedir(), ".cache", "gloom-smoke", "warm-start"));
const outDir = resolve(takeOption(args, "--out") ?? join(root, "results"));
const perLayout = positiveInteger(takeOption(args, "--per-layout"), 16, "per-layout");
const build = args.includes("--build");
const capture = args.includes("--capture");
const heapSnapshot = args.includes("--heap-snapshot");
const metrics = args.includes("--metrics") || heapSnapshot;
const settleOption = takeOption(args, "--settle-ms");
const settleMs = settleOption ? positiveInteger(settleOption, 18_000, "settle-ms") : 0;
const cold = args.includes("--cold");
const proFixture = process.env.WARM_START_PRO_FIXTURE === "1";
if (proFixture && process.env.WARM_START_REPLAY_ONLY !== "1") throw new Error("The synthetic Pro account is replay-only");
/** The harness's own checkout, for its scripts. */
const checkout = resolve(join(import.meta.dir, ".."));
/** The checkout whose app is launched: `--app`, for a before run of the base while this branch changes. */
const app = resolve(takeOption(args, "--app") ?? checkout);
const webRoot = resolve(takeOption(args, "--web-root") ?? join(app, "dist", "web"));
const SLOW_MS = 5_000;
const WIDTH = { tui: 256, view: 2048 };
const HEIGHT = { tui: 80, view: 1280 };

const profile = join(root, `${target}-${label}`);
const filledProfile = `${profile}-filled`;
const networkDir = join(root, "network");
const interrupted = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    interrupted.abort();
  });
}

interface RunRecord {
  layout: number;
  network: Network | "fill";
  run: number;
  launchedAt: number;
  panes: PaneTimeline[];
  requests?: Record<string, number>;
  heapBytes?: number;
  backendHeapBytes?: number;
  cacheKiB?: number;
  cache?: CacheFootprint;
  authResponseAtMs?: number;
}

interface CacheFootprint { rows: number; bytes: number; byNamespace: Record<string, number>; }

function grid(ids: string[]): DockLayoutNode {
  const columns = Math.ceil(Math.sqrt(ids.length));
  const rows: string[][] = [];
  for (let index = 0; index < ids.length; index += columns) rows.push(ids.slice(index, index + columns));
  const row = (cells: string[]): DockLayoutNode => cells.length === 1
    ? { kind: "pane", instanceId: cells[0]! }
    : { kind: "split", axis: "horizontal", ratio: 1 / cells.length, first: { kind: "pane", instanceId: cells[0]! }, second: row(cells.slice(1)) };
  const stack = (lines: string[][]): DockLayoutNode => lines.length === 1
    ? row(lines[0]!)
    : { kind: "split", axis: "vertical", ratio: 1 / lines.length, first: row(lines[0]!), second: stack(lines.slice(1)) };
  return stack(rows);
}

async function loadPlan(): Promise<WarmStartPlan> {
  const file = join(root, "plan.json");
  if (!existsSync(file)) {
    const planHome = join(root, "plan-profile");
    await writeFreshInstallConfig(planHome);
    const child = Bun.spawn(["bun", join(checkout, "scripts/warm-start/plan.ts"), "--out", file], {
      cwd: checkout, env: testAppEnv({ GLOOMBERB_HOME: planHome }), stdout: "inherit", stderr: "inherit",
    });
    if (await child.exited !== 0) throw new Error("Planning the layouts failed");
    await rm(planHome, { recursive: true, force: true });
  }
  return JSON.parse(await readFile(file, "utf8")) as WarmStartPlan;
}

function layoutsOf(plan: WarmStartPlan): SavedLayout[] {
  const layouts: SavedLayout[] = [];
  for (let index = 0; index < plan.panes.length; index += perLayout) {
    const panes = plan.panes.slice(index, index + perLayout);
    layouts.push({
      name: `Warm ${layouts.length + 1}`,
      layout: { dockRoot: grid(panes.map((pane) => pane.instance.instanceId)), instances: panes.map((pane) => pane.instance), floating: [], detached: [] },
      paneState: {},
    });
  }
  return layouts;
}

/** The config every launch starts from: the plan's layouts, the one measured in front. */
function configFor(base: AppConfig, layouts: SavedLayout[], active: number): AppConfig {
  return {
    ...base,
    layouts,
    activeLayoutIndex: active,
    layout: structuredClone(layouts[active]!.layout),
    onboardingComplete: true,
    onboardingProgress: undefined,
    // A banner or a prompt drawn over the panes is not what is measured.
    telemetry: { ...base.telemetry, crashReports: false, usageCounts: false },
  } as AppConfig;
}

interface Launch {
  /** Each pane's states so far. */
  timeline(): Map<string, PaneTimeline>;
  launchedAt: number;
  requests(): Record<string, number> | undefined | Promise<Record<string, number>>;
  heap(snapshot?: string): Promise<{ heapBytes: number; backendHeapBytes?: number }>;
  cacheFootprint?(): Promise<CacheFootprint>;
  authResponseAtMs?(): Promise<number | undefined>;
  quit(): Promise<void>;
}

/** Waits for a settled frame or a quiet replay window; panes left loading are still recorded. */
async function settle(launch: Launch, expected: number, network: Network | "fill", filledPanes?: ReadonlySet<string>): Promise<void> {
  const minimum = network === "fill" ? 15_000 : network === "slow" ? SLOW_MS + 7_000 : 7_000;
  const limit = network === "fill" ? 90_000 : network === "slow" ? 45_000 : 35_000;
  const quietWindow = network === "fill" ? 12_000 : network === "slow" ? SLOW_MS + 3_000 : 5_000;
  const started = Date.now();
  let stableSince = Date.now();
  let signature = "";
  while (!interrupted.signal.aborted && Date.now() - started < limit) {
    await sleep(250);
    const timelines = [...launch.timeline().values()];
    const current = timelines.map((timeline) => `${timeline.paneId}=${timeline.states.at(-1)?.state}`).sort().join(",");
    if (current !== signature) {
      signature = current;
      stableSince = Date.now();
    }
    const settled = timelines.every((timeline) =>
      (filledPanes && !filledPanes.has(timeline.paneId)) || ["content", "empty", "error"].includes(timeline.states.at(-1)?.state ?? ""));
    if (timelines.length >= expected && Date.now() - started >= minimum && Date.now() - launch.launchedAt >= settleMs
      && Date.now() - stableSince >= (settled ? 3_000 : quietWindow)) return;
  }
}

function record(timelines: Map<string, PaneTimeline>, at: number, frame: number, panes: Record<string, PaneShownState>): void {
  for (const [paneId, state] of Object.entries(panes)) {
    const timeline = timelines.get(paneId) ?? { paneId, states: [] };
    timeline.states.push({ at, frame, state });
    timelines.set(paneId, timeline);
  }
}

// ---------------------------------------------------------------- terminal

async function launchTui(network: Network | "fill"): Promise<Launch> {
  const session = `gloom-warm-${process.pid}`;
  const probeFile = join(profile, "probe.jsonl");
  await rm(probeFile, { force: true });
  const env = [
    `GLOOMBERB_HOME=${shellQuote(profile)}`,
    "GLOOMBERB_NO_TELEMETRY=1",
    "DO_NOT_TRACK=1",
    `WARM_START_PROBE_OUT=${shellQuote(probeFile)}`,
    `WARM_START_NET_DIR=${shellQuote(networkDir)}`,
    `WARM_START_NET_DELAY_MS=${network === "slow" ? SLOW_MS : 0}`,
    `WARM_START_REPLAY_ONLY=${process.env.WARM_START_REPLAY_ONLY === "1" ? 1 : 0}`,
    ...(proFixture ? ["WARM_START_PRO_FIXTURE=1"] : []),
    `WARM_START_METRICS=${metrics ? 1 : 0}`,
    `GLOOMBERB_PERF_TRACE=${shellQuote(process.env.GLOOMBERB_PERF_TRACE ?? "")}`,
    `BUN_RUNTIME_TRANSPILER_CACHE_PATH=${shellQuote(join(root, "transpiler"))}`,
  ].join(" ");
  const launchedAt = Date.now();
  await runTmux([
    "new-session", "-d", "-s", session, "-x", String(WIDTH.tui), "-y", String(HEIGHT.tui), "-c", app,
    `exec env ${env} ${shellQuote(process.execPath)} --preload ${shellQuote(join(checkout, "scripts/warm-start/tui-preload.ts"))} ${shellQuote(join(app, "src/cli/entry.ts"))} 2>${shellQuote(join(profile, "stderr.log"))}`,
  ]);
  let timelines = new Map<string, PaneTimeline>();
  let requests: Record<string, number> | undefined;
  // The whole file each time: it is small, and a line still being written is skipped until it ends.
  const poll = async () => {
    if (!existsSync(probeFile)) return;
    const next = new Map<string, PaneTimeline>();
    for (const line of (await readFile(probeFile, "utf8")).split("\n")) {
      let entry: { at: number; frame: number; panes?: Record<string, PaneShownState>; network?: Record<string, number> };
      try { entry = JSON.parse(line); } catch { continue; }
      if (entry.panes) record(next, entry.at - launchedAt, entry.frame, entry.panes);
      if (entry.network) requests = entry.network;
    }
    timelines = next;
  };
  let polling = true;
  const loop = (async () => { while (polling) { await poll().catch(() => {}); await sleep(100); } })();
  return {
    launchedAt,
    timeline: () => timelines,
    requests: () => requests,
    async heap(snapshot) {
      const trigger = join(profile, "collect-heap");
      const result = join(profile, "heap-bytes");
      await rm(result, { force: true });
      await writeFile(trigger, snapshot ?? "");
      const deadline = Date.now() + (snapshot ? 45_000 : 5_000);
      while (!interrupted.signal.aborted && Date.now() < deadline) {
        const sample = await readFile(result, "utf8").catch(() => "");
        if (sample) return { heapBytes: Number(sample) };
        await sleep(50);
      }
      throw new Error("The terminal did not respond to the heap request");
    },
    async quit() {
      const panePid = Number(Bun.spawnSync(["tmux", "display-message", "-p", "-t", `=${session}:`, "#{pane_pid}"]).stdout.toString());
      try {
        if (Number.isInteger(panePid) && panePid > 1) process.kill(panePid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      } finally {
        await runTmux(["kill-session", "-t", `=${session}`], false);
      }
      polling = false;
      await loop;
      await poll().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------- web and desktop

let webServer: WarmStartWebServer | null = null;
let standIn: DesktopStandIn | null = null;

async function launchView(network: Network | "fill", screenshot?: string): Promise<Launch> {
  const timelines = new Map<string, PaneTimeline>();
  const delayMs = network === "slow" ? SLOW_MS : 0;
  let origin: string;
  let path = "/";
  let launchedAt: number;
  if (target === "web") {
    webServer ??= await startWarmStartWebServer({ webRoot, networkDir });
    webServer.setDelay(delayMs);
    origin = webServer.origin;
    launchedAt = Date.now();
  } else {
    installWarmStartNetwork({ dir: networkDir, extraDelayMs: delayMs, replayOnly: process.env.WARM_START_REPLAY_ONLY === "1" }).setExtraDelay(delayMs);
    standIn ??= await startDesktopStandIn({ checkout, app, home: profile, viewDir: `${profile}-view`, networkDir });
    launchedAt = Date.now();
    await standIn.restart(delayMs);
    origin = standIn.origin;
    path = standIn.pagePath;
  }
  const server = (webServer ?? standIn)!;
  const browser = await launchBrowser(`warm-${target}`, WIDTH.view, HEIGHT.view, { profileDir: join(profile, "chrome") });
  const exceptions = new Map<string, number>();
  browser.cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
    const name = exceptionDetails?.exception?.className ?? "Unknown";
    exceptions.set(name, (exceptions.get(name) ?? 0) + 1);
  });
  let picture: Promise<void> | undefined;
  const takePicture = (file: string) => browser.cdp.send("Page.captureScreenshot", { format: "png" }, 3_000).then(async ({ data }) => {
    await writeFile(file, Buffer.from(data, "base64"));
  }).catch((error) => { console.error("Could not capture a benchmark screenshot:", error); });
  const binding = "__gloomWarmFrame";
  browser.cdp.on("Runtime.bindingCalled", ({ name, payload }) => {
    if (name !== binding) return;
    const entry = JSON.parse(payload) as ProbeEntry;
    record(timelines, entry.at - launchedAt, entry.frame, entry.panes);
    if (screenshot && network !== "fill" && !picture && Object.values(entry.panes).some((state) => state !== "blank")) picture = takePicture(screenshot);
  });
  try {
    await routeDirectReads(browser.cdp, { read: (_key, load) => proFixture ? Promise.reject(new Error("The synthetic fixture only uses replayed reads")) : load() });
    await browser.cdp.send("Runtime.addBinding", { name: binding });
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: domProbeSource(binding) });
    await browser.cdp.send("Page.navigate", { url: `${origin}${path}` });
  } catch (error) {
    await browser.close();
    throw error;
  }
  return {
    launchedAt,
    timeline: () => timelines,
    requests: () => server.requests(),
    ...(target === "web" && proFixture ? { authResponseAtMs: async () => {
      const responseAt = await evaluate<number | null>(browser.cdp, `(() => {
        const entry = performance.getEntriesByName(location.origin + "/api/auth/get-session")[0];
        return entry ? performance.timeOrigin + entry.responseEnd : null;
      })()`, 3_000);
      return responseAt === null ? undefined : Math.round(responseAt - launchedAt);
    } } : {}),
    async heap(snapshot) {
      await browser.cdp.send("HeapProfiler.collectGarbage", {}, 3_000);
      const { usedSize } = await browser.cdp.send<{ usedSize: number }>("Runtime.getHeapUsage", {}, 3_000);
      let backendHeapBytes: number | undefined;
      if (standIn) {
        const response = await fetch(standIn.endpoint("__warm-heap"), { signal: AbortSignal.timeout(3_000) });
        if (!response.ok) throw new Error(`Desktop heap request failed: ${response.status}`);
        backendHeapBytes = Number(await response.text());
      }
      if (snapshot) {
        const writer = Bun.file(`${snapshot}.heapsnapshot`).writer();
        browser.cdp.on("HeapProfiler.addHeapSnapshotChunk", ({ chunk }) => { writer.write(chunk); });
        try {
          await browser.cdp.send("HeapProfiler.takeHeapSnapshot", {}, 60_000);
        } finally {
          await writer.end();
        }
        if (standIn) {
          const response = await fetch(standIn.endpoint("__warm-heap-snapshot"), { signal: AbortSignal.timeout(45_000) });
          if (!response.ok) throw new Error(`Desktop heap snapshot failed: ${response.status}`);
          await Bun.write(`${snapshot}-backend.heapsnapshot`, response);
        }
      }
      return { heapBytes: usedSize + (backendHeapBytes ?? 0), backendHeapBytes };
    },
    ...(target === "web" ? { cacheFootprint: () => evaluate<CacheFootprint>(browser.cdp, `(async () => {
      const name = "gloomberb-cache";
      const totals = { rows: 0, bytes: 0, byNamespace: {} };
      if (!(await indexedDB.databases()).some(db => db.name === name)) return totals;
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const cursor = db.transaction("meta").objectStore("meta").openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return resolve();
            const namespace = row.key.split("\\u0000")[0];
            totals.rows++;
            totals.bytes += row.value.size;
            totals.byNamespace[namespace] = (totals.byNamespace[namespace] ?? 0) + row.value.size;
            row.continue();
          };
          cursor.onerror = () => reject(cursor.error);
        });
        return totals;
      } finally { db.close(); }
    })()`, 3_000) } : {}),
    async quit() {
      try {
        await picture;
        if (screenshot && network === "fill" && timelines.size) await takePicture(screenshot);
        if (timelines.size === 0) {
          const state = await evaluate(browser.cdp, `({
            ready: document.readyState,
            fatal: !!document.querySelector(".gloom-fatal"),
            panes: document.querySelectorAll("[data-gloom-role=pane-window][data-gloom-pane-id]").length,
          })`, 1_000).catch(() => null);
          console.error("No pane frames recorded", { state, exceptions: Object.fromEntries(exceptions) });
          if (screenshot) await takePicture(screenshot);
        }
        if (standIn) await standIn.stopBackend();
      } finally {
        await browser.close("SIGKILL");
      }
    },
  };
}

// ---------------------------------------------------------------- runs

async function prepareProfile(plan: WarmStartPlan): Promise<{ base: AppConfig; layouts: SavedLayout[] }> {
  const layouts = layoutsOf(plan);
  if (!existsSync(join(profile, "config.json"))) {
    await rm(profile, { recursive: true, force: true });
    await writeFreshInstallConfig(profile);
  }
  const base = JSON.parse(await readFile(join(profile, "base-config.json"), "utf8").catch(() => readFile(join(profile, "config.json"), "utf8"))) as AppConfig;
  await writeFile(join(profile, "base-config.json"), JSON.stringify(base, null, 2));
  return { base, layouts };
}

async function writeLaunchConfig(base: AppConfig, layouts: SavedLayout[], active: number): Promise<void> {
  const config = configFor(base, layouts, active);
  if (target === "tui" || target === "desktop") {
    await writeFile(join(profile, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
    if (proFixture) (await import("./warm-start/pro-fixture")).seedFixtureNativeSession(join(config.dataDir, ".gloomberb-cache.db"));
    return;
  }
  webServer ??= await startWarmStartWebServer({ webRoot, networkDir });
  // The web app reads its config from local storage: written from a page of the same origin that is not the app.
  const browser = await launchBrowser("warm-web-seed", 800, 600, { profileDir: join(profile, "chrome") });
  try {
    await browser.cdp.send("Page.navigate", { url: `${webServer.origin}/health` });
    await sleep(500);
    if (proFixture) {
      const { fixtureCookie, fixtureSession } = await import("./warm-start/pro-fixture");
      await browser.cdp.send("Network.setCookie", { url: webServer.origin, name: fixtureCookie, value: fixtureSession, httpOnly: true, expires: Date.now() / 1000 + 3600 });
    }
    const webConfig = { ...config, dataDir: "browser://local" };
    await evaluate(browser.cdp, `localStorage.setItem("gloomberb.web.config.v1", ${JSON.stringify(JSON.stringify(webConfig))}); true`);
    await sleep(300);
  } finally {
    await browser.close();
  }
}

function summarize(records: RunRecord[], fills: Map<number, RunRecord>, plan: WarmStartPlan) {
  const rows: Array<Record<string, unknown>> = [];
  for (const pane of plan.panes) {
    const id = pane.instance.instanceId;
    const layout = Math.floor(plan.panes.indexOf(pane) / perLayout);
    if (!fills.has(layout)) continue;
    const fill = fills.get(layout)?.panes.find((timeline) => timeline.paneId === id);
    const filledLast = fill?.states.at(-1)?.state ?? "missing";
    const filled = filledLast === "content";
    for (const network of networks) {
      const mine = records.filter((entry) => entry.layout === layout && entry.network === network);
      const firstContent: number[] = [];
      const frames: number[] = [];
      let loadingRuns = 0;
      let missing = 0;
      for (const entry of mine) {
        const timeline = entry.panes.find((candidate) => candidate.paneId === id);
        if (!timeline || timeline.states.length === 0) { missing += 1; continue; }
        const content = timeline.states.find((state) => state.state === "content");
        if (content) {
          firstContent.push(content.at);
          frames.push(content.frame - timeline.states[0]!.frame);
        }
        if (filled && timeline.states.some((state) => state.state === "loading" || state.state === "empty")) loadingRuns += 1;
      }
      rows.push({
        token: pane.token, paneId: pane.paneId, network, filled, filledLast,
        runs: mine.length, missing,
        firstContentP50: firstContent.length ? Math.round(median(firstContent)) : null,
        firstContentWorst: firstContent.length ? Math.round(Math.max(...firstContent)) : null,
        contentRuns: firstContent.length,
        framesToContentWorst: frames.length ? Math.max(...frames) : null,
        loadingRuns,
      });
    }
  }
  return rows;
}

function markdown(rows: Array<Record<string, any>>): string {
  const lines: string[] = [];
  for (const network of networks) {
    const mine = rows.filter((row) => row.network === network);
    const kept = mine.filter((row) => row.filled);
    const showing = kept.filter((row) => row.loadingRuns > 0);
    lines.push(`### ${target}, ${network} network, ${label}`, "");
    lines.push(`${kept.length} of ${mine.length} panes showed content at the end of the fill launch; ${showing.length} of them showed a loading or empty state on a warm restart.`, "");
    lines.push("| pane | first content p50 | worst | frames to content (worst) | runs showing loading | missing mounts |", "|---|---|---|---|---|---|");
    for (const row of mine) {
      const cell = (value: unknown, unit = "") => value == null ? "-" : `${value}${unit}`;
      lines.push(`| ${row.token} (${row.paneId})${row.filled ? "" : ` (fill: ${row.filledLast})`} | ${cell(row.firstContentP50, " ms")} | ${cell(row.firstContentWorst, " ms")} | ${cell(row.framesToContentWorst)} | ${row.filled ? `${row.loadingRuns} of ${row.runs}` : "-"} | ${row.missing} of ${row.runs} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function cacheKiB(): Promise<number> {
  const paths = (target === "web" ? ["chrome/Default/IndexedDB"] : [".gloomberb-cache.db", ".gloomberb-cache.db-wal", ".gloomberb-cache.db-shm"])
    .map((file) => join(profile, file)).filter(existsSync);
  if (paths.length === 0) return 0;
  const child = Bun.spawn(["du", "-sk", ...paths], { stdout: "pipe", stderr: "ignore" });
  const sizes = (await new Response(child.stdout).text()).trim().split("\n").map((line) => Number(line.split(/\s/)[0]));
  if (await child.exited !== 0 || sizes.some((size) => !Number.isFinite(size))) throw new Error("Could not measure the cache files");
  return sizes.reduce((total, size) => total + size, 0);
}

function sqliteFootprint(): CacheFootprint | undefined {
  const file = join(profile, ".gloomberb-cache.db");
  if (!existsSync(file)) return undefined;
  const db = new Database(file, { readonly: true });
  try {
    const entries = db.query<{ namespace: string; rows: number; bytes: number }, []>(
      "SELECT namespace, COUNT(*) AS rows, SUM(size_bytes) AS bytes FROM resource_cache GROUP BY namespace",
    ).all();
    return {
      rows: entries.reduce((total, entry) => total + entry.rows, 0),
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
      byNamespace: Object.fromEntries(entries.map((entry) => [entry.namespace, entry.bytes])),
    };
  } finally { db.close(); }
}

async function main(): Promise<void> {
  await mkdir(root, { recursive: true });
  await mkdir(outDir, { recursive: true });
  if (target === "web" && (build || !existsSync(join(webRoot, "index.html")))) {
    const child = Bun.spawn(["bun", "run", "web:build", "--out", webRoot], { cwd: app, stdout: "ignore", stderr: "inherit" });
    if (await child.exited !== 0) throw new Error("web:build failed");
  }
  const plan = await loadPlan();
  const { base, layouts } = await prepareProfile(plan);
  const only = takeOption(args, "--layouts")?.split(",").map((value) => Number(value) - 1);
  const chosen = layouts.map((_, index) => index).filter((index) => !only || only.includes(index));
  const results = join(outDir, `${target}-${label}.json`);
  const saved = existsSync(results) ? JSON.parse(await readFile(results, "utf8")) as { records: RunRecord[]; fills: RunRecord[] } : { records: [], fills: [] };
  const launch = target === "tui" ? launchTui : launchView;

  try {
    for (const layout of chosen) {
      const expected = layouts[layout]!.layout.instances.length;
      const done = (network: Network | "fill", run: number) => (network === "fill" ? saved.fills : saved.records)
        .some((entry) => entry.layout === layout && entry.network === network && entry.run === run);
      if (interrupted.signal.aborted) break;
      if (networks.every((network) => Array.from({ length: runs }, (_, index) => done(network, index + 1)).every(Boolean))) continue;
      saved.records = saved.records.filter((entry) => entry.layout !== layout);
      let filledPanes: ReadonlySet<string> | undefined;
      const once = async (network: Network | "fill", run: number) => {
        if (interrupted.signal.aborted || (network !== "fill" && done(network, run))) return;
        await rm(profile, { recursive: true, force: true });
        if (network === "fill" || cold) {
          await mkdir(profile, { recursive: true });
          await writeLaunchConfig(base, layouts, layout);
        } else {
          await cp(filledProfile, profile, { recursive: true, verbatimSymlinks: true });
        }
        const screenshot = capture && run === 1
          ? join(outDir, `${target}-${label}-${network}-layout-${layout + 1}.png`) : undefined;
        const started = await launch(network, screenshot);
        let heap: { heapBytes: number; backendHeapBytes?: number } | undefined;
        let cache: CacheFootprint | undefined;
        let requests: Record<string, number> | undefined;
        let authResponseAtMs: number | undefined;
        try {
          await settle(started, expected, network, filledPanes);
          if (metrics && !interrupted.signal.aborted) {
            const snapshot = heapSnapshot && network !== "fill" && run === 1
              ? join(outDir, `${target}-${label}-${network}-layout-${layout + 1}`) : undefined;
            heap = await started.heap(snapshot).catch((error) => {
              console.error(error);
              return undefined;
            });
            cache = await started.cacheFootprint?.().catch(() => undefined);
          }
          requests = await started.requests();
          authResponseAtMs = await started.authResponseAtMs?.().catch(() => undefined);
        } finally {
          await started.quit();
        }
        if (interrupted.signal.aborted) return;
        if (metrics && target !== "web") cache = sqliteFootprint();
        const entry: RunRecord = { layout, network, run, launchedAt: started.launchedAt, panes: [...started.timeline().values()],
          requests, authResponseAtMs, ...heap, cache, cacheKiB: metrics ? await cacheKiB() : undefined };
        if (network === "fill") {
          filledPanes = new Set(entry.panes.filter((pane) => pane.states.at(-1)?.state === "content").map((pane) => pane.paneId));
          await rm(filledProfile, { recursive: true, force: true });
          await rename(profile, filledProfile);
          saved.fills = saved.fills.filter((fill) => fill.layout !== layout);
          saved.fills.push(entry);
        } else {
          saved.records.push(entry);
        }
        await writeFile(`${results}.partial`, JSON.stringify(saved));
        await rename(`${results}.partial`, results);
        const loading = entry.panes.filter((pane) => pane.states.some((state) => state.state === "loading")).length;
        console.error(`${target} ${label} layout ${layout + 1} ${network} ${run}: ${entry.panes.length} panes, ${loading} showed loading, requests ${JSON.stringify(entry.requests ?? {})}`);
      };
      await once("fill", 1);
      for (let run = 1; run <= runs; run += 1) {
        for (const network of networks) await once(network, run);
      }
    }
  } finally {
    webServer?.stop();
    await standIn?.stop();
    await rm(filledProfile, { recursive: true, force: true });
  }

  const fills = new Map(saved.fills.map((entry) => [entry.layout, entry]));
  const rows = summarize(saved.records, fills, plan);
  const text = markdown(rows);
  await writeFile(join(outDir, `${target}-${label}.md`), text);
  await writeFile(join(outDir, `${target}-${label}-rows.json`), JSON.stringify(rows, null, 2));
  console.log(text);
}

await main();
process.exit(process.exitCode ?? 0);
