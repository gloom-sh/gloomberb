import { mkdir } from "fs/promises";
import { basename, join, resolve } from "path";
import { testAppEnv, TEST_BROWSER_PRIVACY_SCRIPT } from "../test-app-env";
import { median, positiveInteger, takeOption } from "../tui-benchmark-harness";
import { cacheDir, evaluate, launchBrowser, sleep, type Cdp, type Point } from "./browser";
import { serveFixturePage } from "./page";
import { createReplay, liveSocket, replaySocket, routeDirectReads, seedScript, serveWebApp, type SocketStandIn } from "./web-app";

/**
 * How smooth a pane move is, with real pointer input, in the app's two
 * renderers and the two engines they run in: a floating pane moved about the
 * screen, and a docked pane pulled out of the dock.
 *
 * Each drag moves the pointer as a hand does, at a speed (`--speed`): from
 * stop to stop, speeding up and slowing down on the way (a minimum-jerk
 * path), and resting at each stop. Most stops put an edge of the moving pane
 * a few px from another pane's edge or the screen's, where the magnets catch
 * it; on the way it crosses others. `slow` averages 150 px/s, `medium` 450 and
 * `fast` 1,300 between stops; `sweep` is one 2 s loop at 60 moves a second
 * with no stop.
 *
 * - `web`: the real web build of each checkout (the browser renderer),
 *   signed out, with the workspace a first visit gets (a heat map, the
 *   watchlist, a chart, news, the Fear & Greed gauge and trending as tabs) and
 *   the watchlist's ticker floating over it, on the reads web-app.ts replays. `--stream live`
 *   streams quotes from Gloom Cloud as the web app does; `--stream replay`
 *   plays the quotes `--record-stream <s>` kept from it, at the pace they
 *   came, the same for every checkout. Without `--stream` no quote streams.
 * - `desktop`: the desktop view's renderer (the page the desktop app loads,
 *   with its own UI host) on the pane chrome fixture's dense layout of nine
 *   docked tables and a floating one (`perf`), which needs no network.
 *
 * Engines: Chromium (the web app in Chrome; the desktop app on Windows) and
 * WebKit through Playwright (Safari; the desktop app on macOS).
 *
 * Per drag: the time between animation frames (50th and 95th percentile), the
 * 60 Hz slots with no frame, long tasks (Chromium's longtask entries; WebKit
 * reports none, so frames over 50 ms apart stand in), main-thread time per
 * frame (Chromium), React commits per pointer move, and how the moving pane
 * kept to the pointer: frames where it stood still while the pointer moved,
 * frames where it moved more than 2 px differently from the pointer, the
 * largest such difference in one frame (a jump), and how far its offset from
 * the pointer strayed (95th percentile). For the frames drawn late (over one
 * and a half 60 Hz slots apart): the React commits and quote frames that came
 * in them, and in Chromium the scripts of its long animation frames. Checkouts
 * take turns, `--runs` times; the table shows the median.
 *
 *   bun run benchmark:pane-drag:smoothness --side v0.19.5=<checkout> --side main=<checkout> --side fix=. \
 *     [--app web,desktop] [--engine chromium,webkit] [--speed slow,medium,fast] [--runs 3] [--dpr 1] [--gpu]
 *     [--stream live|replay] [--record-stream <s>] [--replay-dir <dir>] [--offline] [--no-build]
 *     [--only <text>] [--json <file>] [--shots <dir>] [--trace <dir>] [--profile <dir>] [--verbose]
 *
 * Chromium is the pinned headless shell, which paints without a GPU; `--gpu`
 * runs Chrome (CHROME_PATH, or the installed one) in its new headless mode
 * with its GPU. On a Mac whose display sleeps (a headless Mac mini) headless
 * Chrome paints only 8 to 30 frames a second however little a frame costs, so
 * its frame times say nothing there: take them from Linux (the CI runner) and
 * read WebKit's, which keeps to 60 Hz, on the Mac. `--shots` pictures each
 * drag at rest at each stop and after the release instead of measuring;
 * `--trace` writes a Chromium performance trace of each drag and `--profile`
 * a CPU profile, with the functions that took the most time printed.
 */

const VIEWPORT = { width: 1440, height: 900 };
const FRAME_MS = 1_000 / 60;
const LATE_FRAME_MS = 1.5 * FRAME_MS;
const LONG_FRAME_MS = 50;
const SWEEP_MS = 2_000;

const PAGE_PROBES = `
window.__commits = 0;
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, isDisabled: false, renderers: new Map(),
  inject() { return 1; },
  onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  onCommitFiberRoot() { window.__commits += 1; },
};
window.__moves = 0;
window.__pointerX = 0;
window.__pointerY = 0;
window.__predicted = [];
window.addEventListener("pointermove", (event) => {
  window.__moves += 1; window.__pointerX = event.clientX; window.__pointerY = event.clientY;
  // Chrome predicts where the mouse goes next (getPredictedEvents); the host draws a drag there.
  if (window.__recording && event.getPredictedEvents) {
    const next = event.getPredictedEvents()[0];
    window.__predicted.push(next ? [event.clientX, event.clientY, next.clientX, next.clientY] : [event.clientX, event.clientY, null, null]);
  }
}, true);
window.__quotes = 0;
const PageSocket = window.WebSocket;
window.WebSocket = class extends PageSocket {
  constructor(...args) {
    super(...args);
    this.addEventListener("message", (event) => { if (typeof event.data === "string" && event.data.includes('"type":"market.quote')) window.__quotes += 1; });
  }
};
window.__longTasks = null;
window.__loaf = [];
try {
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    window.__longTasks = [];
    new PerformanceObserver((list) => { if (window.__recording) for (const entry of list.getEntries()) window.__longTasks.push(entry.duration); }).observe({ type: "longtask" });
  }
  if (PerformanceObserver.supportedEntryTypes.includes("long-animation-frame")) {
    new PerformanceObserver((list) => {
      if (!window.__recording) return;
      for (const entry of list.getEntries()) window.__loaf.push({
        duration: entry.duration, blocking: entry.blockingDuration,
        scripts: entry.scripts.map((script) => ({ duration: script.duration, invoker: script.invoker, source: script.sourceFunctionName || script.sourceURL?.split("/").pop() || "" })),
      });
    }).observe({ type: "long-animation-frame" });
  }
} catch {}
`;

type Engine = "chromium" | "webkit";
type App = "web" | "desktop";
type Speed = "slow" | "medium" | "fast" | "sweep";
type Stream = "off" | "live" | "replay";

/** A hand's pace between stops, px/s on average, and how long it rests at each. */
const HAND: Record<Exclude<Speed, "sweep">, { pxPerS: number; restMs: number }> = {
  slow: { pxPerS: 150, restMs: 350 },
  medium: { pxPerS: 450, restMs: 250 },
  fast: { pxPerS: 1_300, restMs: 150 },
};

interface Options {
  dpr: number;
  gpu: boolean;
}

/** What a run needs of a page: Chromium's DevTools protocol, or Playwright for WebKit. */
interface Driver {
  cdp: Cdp | null;
  evaluate<T>(expression: string): Promise<T>;
  /** Real input: the browser's own mouse events, not events made in the page. */
  mouse(type: "move" | "down" | "up", x: number, y: number): Promise<void>;
  /** Chromium: the main thread's task time so far, ms. */
  taskMs(): Promise<number | null>;
  screenshot(file: string): Promise<void>;
  /** Loads `url` in a fresh page, with `init` run before the page's own scripts. */
  load(url: string, init?: string): Promise<void>;
  close(): Promise<void>;
}

async function chromiumDriver(name: string, options: Options): Promise<Driver> {
  const browser = await launchBrowser(name, VIEWPORT.width, VIEWPORT.height, { gpu: options.gpu });
  const { cdp } = browser;
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_PROBES });
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: options.dpr, mobile: false });
  return {
    cdp,
    evaluate: (expression) => evaluate(cdp, expression),
    async mouse(type, x, y) {
      await cdp.send("Input.dispatchMouseEvent", {
        type: type === "move" ? "mouseMoved" : type === "down" ? "mousePressed" : "mouseReleased",
        x, y, button: "left", buttons: type === "up" ? 0 : 1, clickCount: type === "move" ? 0 : 1,
      });
    },
    async taskMs() {
      const { metrics } = await cdp.send<{ metrics: Array<{ name: string; value: number }> }>("Performance.getMetrics");
      return (metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0) * 1000;
    },
    async screenshot(file) {
      const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      await Bun.write(file, Buffer.from(data, "base64"));
    },
    async load(url, init) {
      const id = init ? (await cdp.send<{ identifier: string }>("Page.addScriptToEvaluateOnNewDocument", { source: init })).identifier : null;
      const loaded = cdp.once("Page.loadEventFired", 60_000);
      await cdp.send("Page.navigate", { url });
      await loaded;
      if (id) await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: id });
    },
    close: () => browser.close(),
  };
}

async function webkitDriver(options: Options): Promise<Driver> {
  const { webkit } = await import("playwright-core");
  const browser = await webkit.launch({ headless: true, env: testAppEnv() });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: options.dpr });
  await context.addInitScript({ content: TEST_BROWSER_PRIVACY_SCRIPT });
  // Nothing past this machine, as the Chromium side does. Only those requests
  // are intercepted: WebKit stops answering now and then when every request,
  // the page's socket among them, goes through Playwright.
  await context.route((url) => url.hostname !== "127.0.0.1", (route) => route.abort());
  await context.addInitScript({ content: PAGE_PROBES });
  let page = await context.newPage();
  let pressed = false;
  return {
    cdp: null,
    evaluate: (expression) => page.evaluate(expression),
    async mouse(type, x, y) {
      await page.mouse.move(x, y);
      if (type === "down" && !pressed) { pressed = true; await page.mouse.down(); }
      if (type === "up" && pressed) { pressed = false; await page.mouse.up(); }
    },
    taskMs: async () => null,
    async screenshot(file) {
      await Bun.write(file, await page.screenshot());
    },
    async load(url, init) {
      await page.close();
      page = await context.newPage();
      page.setDefaultTimeout(60_000);
      if (init) await page.addInitScript({ content: init });
      await page.goto(url, { waitUntil: "load" });
    },
    close: () => browser.close(),
  };
}

interface Scenario {
  name: string;
  /** The pane pressed, by its grip. */
  paneId: string;
  /** What moves with the pointer: the floating pane, or the outline a docked one drags. */
  follower: string;
  /** `sweep`: where the pointer is `t` of the way through the loop. */
  sweep(start: Point, t: number): Point;
}

const pane = (id: string) => `[data-gloom-pane-id='${id}']`;
/** The pane's grip: its title can be a control (a ticker picker), the grip always moves it. */
const gripOf = (id: string) => `(() => { const element = document.querySelector("${pane(id)} [data-gloom-role=pane-grip]"); if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`;
const OUTLINE = "[data-gloom-role=drag-outline]";

/** Around the screen and back, over docked panes, their title bars and the edges a floating pane joins at. */
const floatingSweep = (start: Point, t: number): Point => ({
  x: start.x + Math.sin(t * Math.PI * 2) * 380,
  y: start.y + (1 - Math.cos(t * Math.PI * 2)) * 90,
});
/** Out of the dock at the top left, across the panes beside it and under it, and back over where it was. */
const undockSweep = (start: Point, t: number): Point => ({
  x: start.x + Math.sin(t * Math.PI) * 480,
  y: start.y + (1 - Math.cos(t * Math.PI * 2)) * 110,
});

const leaf = (instanceId: string) => ({ kind: "pane", instanceId });
/**
 * The workspace a first visit gets from onboarding (first-run-workspace.ts):
 * the portfolio's heat map and the watchlist (its twelve starter names, two of
 * them crypto that trade all day), a chart, top news, and the Fear & Greed
 * gauge in front of trending as tabs beside it; with the watchlist's ticker
 * opened over it, floating, as a new pane opens.
 */
const WEB_LAYOUT = {
  dockRoot: {
    kind: "split", axis: "horizontal", ratio: 0.36,
    first: { kind: "split", axis: "vertical", ratio: 0.5, first: leaf("portfolio-list:home-heatmap"), second: leaf("portfolio-list:home-watchlist") },
    second: {
      kind: "split", axis: "vertical", ratio: 0.62,
      first: leaf("chart-composer:home"),
      second: {
        kind: "split", axis: "horizontal", ratio: 0.6, first: leaf("news-top:home"),
        second: { kind: "split", axis: "horizontal", ratio: 0.5, first: leaf("fear-greed:home"), second: leaf("attention-trending:home"), tabs: { active: "fear-greed:home" } },
      },
    },
  },
  instances: [
    { instanceId: "portfolio-list:home-heatmap", paneId: "portfolio-list", params: { collectionId: "main" }, settings: { collectionScope: "portfolios", visibleCollectionIds: [], viewMode: "grid" }, binding: { kind: "none" } },
    { instanceId: "portfolio-list:home-watchlist", paneId: "portfolio-list", params: { collectionId: "watchlist" }, settings: { collectionScope: "watchlists", visibleCollectionIds: [], viewMode: "table" }, binding: { kind: "none" } },
    { instanceId: "chart-composer:home", paneId: "chart-composer", binding: { kind: "fixed", symbol: "SPY" } },
    { instanceId: "news-top:home", paneId: "news-top", binding: { kind: "none" } },
    { instanceId: "attention-trending:home", paneId: "attention-trending", binding: { kind: "none" } },
    { instanceId: "fear-greed:home", paneId: "fear-greed", binding: { kind: "none" } },
    { instanceId: "ticker-research:float", paneId: "ticker-research", binding: { kind: "follow", sourceInstanceId: "portfolio-list:home-watchlist" } },
  ],
  floating: [
    { instanceId: "ticker-research:float", x: 62, y: 6, width: 72, height: 26, zIndex: 61 },
  ],
  detached: [],
};

const SCENARIOS: Record<App, Scenario[]> = {
  web: [
    { name: "floating move", paneId: "ticker-research:float", follower: pane("ticker-research:float"), sweep: floatingSweep },
    { name: "undock", paneId: "portfolio-list:home-heatmap", follower: OUTLINE, sweep: undockSweep },
  ],
  desktop: [
    { name: "floating move", paneId: "table:float", follower: pane("table:float"), sweep: floatingSweep },
    { name: "undock", paneId: "table:1", follower: OUTLINE, sweep: undockSweep },
  ],
};

interface Rect { x: number; y: number; width: number; height: number }

/** What a hand's path is planned from, once the drag has begun: where the moving pane is, and the edges about it. */
interface Surroundings {
  pointer: Point;
  follower: Rect;
  xs: number[];
  ys: number[];
  area: { width: number; height: number };
}

const surroundings = (scenario: Scenario) => `(() => {
  const follower = document.querySelector(${JSON.stringify(scenario.follower)})?.getBoundingClientRect();
  if (!follower) return null;
  const xs = [0, innerWidth], ys = [0, innerHeight];
  const seen = new Set([${JSON.stringify(scenario.paneId)}]);
  for (const element of document.querySelectorAll("[data-gloom-pane-id]")) {
    const id = element.getAttribute("data-gloom-pane-id");
    if (seen.has(id)) continue;
    seen.add(id);
    const r = element.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    xs.push(r.left, r.right);
    ys.push(r.top, r.bottom);
  }
  return { pointer: { x: window.__pointerX, y: window.__pointerY }, follower: { x: follower.x, y: follower.y, width: follower.width, height: follower.height }, xs, ys, area: { width: innerWidth, height: innerHeight } };
})()`;

/**
 * The stops of a hand's path, as moves of the pane's top left, and which of
 * its edges each puts `off` px from the nearest edge about it: right and in to
 * a line, down to one, back left across the screen to one, up into the open,
 * and into a corner.
 */
const STOPS: Array<{ dx: number; dy: number; snap: "x" | "y" | "xy" | null; off: number }> = [
  { dx: 320, dy: 0, snap: "x", off: 5 },
  { dx: 0, dy: 170, snap: "y", off: -4 },
  { dx: -460, dy: 0, snap: "x", off: 3 },
  { dx: 90, dy: -130, snap: null, off: 0 },
  { dx: 60, dy: -40, snap: "xy", off: 6 },
];

interface Leg { to: Point; ms: number; restMs: number }

function handLegs(around: Surroundings, speed: Exclude<Speed, "sweep">): Leg[] {
  const { pxPerS, restMs } = HAND[speed];
  const margin = 12;
  const clamp = (rect: Rect): Rect => ({
    ...rect,
    x: Math.max(margin, Math.min(around.area.width - rect.width - margin, rect.x)),
    y: Math.max(margin, Math.min(around.area.height - rect.height - margin, rect.y)),
  });
  const nearest = (lines: number[], start: number, end: number) => {
    let best = 0;
    for (const line of lines) for (const edge of [start, end]) if (best === 0 || Math.abs(line - edge) < Math.abs(best)) best = line - edge;
    return best;
  };
  const grab = { x: around.pointer.x - around.follower.x, y: around.pointer.y - around.follower.y };
  let rect = around.follower;
  let at = around.pointer;
  return STOPS.map((stop, index) => {
    let next = clamp({ ...rect, x: rect.x + stop.dx, y: rect.y + stop.dy });
    if (stop.snap?.includes("x")) next = { ...next, x: next.x + nearest(around.xs, next.x, next.x + next.width) + stop.off };
    if (stop.snap?.includes("y")) next = { ...next, y: next.y + nearest(around.ys, next.y, next.y + next.height) + stop.off };
    next = clamp(next);
    const to = { x: Math.round((next.x + grab.x) * 2) / 2, y: Math.round((next.y + grab.y) * 2) / 2 };
    const ms = Math.max(200, (Math.hypot(to.x - at.x, to.y - at.y) / pxPerS) * 1000);
    rect = next;
    at = to;
    return { to, ms, restMs: index === STOPS.length - 1 ? 400 : restMs };
  });
}

/** A step that has not finished in `ms` fails the run instead of holding it. */
async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** A minimum-jerk move: how far along it is `t` of the way through, from rest to rest. */
const minimumJerk = (t: number) => t * t * t * (10 - 15 * t + 6 * t * t);

interface AppSetup {
  /** Opens the layout and waits until it has drawn and its data settled. */
  open(driver: Driver): Promise<void>;
  close(): Promise<void>;
}

/** Until nothing in the page has changed for `quietMs`, at most `maxMs`. */
async function settle(driver: Driver, quietMs: number, maxMs: number): Promise<void> {
  await driver.evaluate(`(() => { window.__changed = performance.now(); new MutationObserver(() => { window.__changed = performance.now(); }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); })()`);
  const until = Date.now() + maxMs;
  while (Date.now() < until) {
    await sleep(200);
    if (await driver.evaluate<number>("performance.now() - window.__changed") >= quietMs) return;
  }
}

async function waitUntil(driver: Driver, predicate: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await driver.evaluate<boolean>(`(() => { try { return !!(${predicate}); } catch { return false; } })()`)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${predicate}`);
}

interface WebOptions {
  offline: boolean;
  build: boolean;
  stream: Stream;
  replayDir: string;
  /** Live: where Gloom Cloud's frames are kept. */
  record?: string;
}

async function setUpApp(app: App, label: string, root: string, options: WebOptions): Promise<AppSetup> {
  if (app === "desktop") {
    // This checkout's fixture, built against `root` (or `root`'s own when it lacks what the fixture imports).
    const page = await serveFixturePage(root, cacheDir("build", `smooth-${label}-${process.pid}`), { ownFixtureFallback: true });
    const url = new URL("?scenario=perf", page.url).href;
    return {
      async open(driver) {
        await driver.load(url);
        await waitUntil(driver, "window.__paneChrome?.ready === true", 15_000);
        await sleep(300);
      },
      close: () => page.close(),
    };
  }
  const dist = cacheDir("drag-smoothness", label, "web");
  if (options.build || !await Bun.file(join(dist, "index.html")).exists()) {
    const built = Bun.spawnSync(["bun", "scripts/build-web.ts", "--out", dist, "--keep-names"], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`The web build of ${root} failed:\n${built.stderr.toString().slice(-2000)}`);
  }
  const replay = createReplay(options.replayDir, { offline: options.offline });
  let socket: SocketStandIn | undefined;
  if (options.stream === "live") socket = liveSocket(options.record);
  if (options.stream === "replay") socket = await replaySocket(join(options.replayDir, "socket.jsonl"));
  const server = serveWebApp(dist, replay, { socket });
  return {
    async open(driver) {
      if (driver.cdp) await routeDirectReads(driver.cdp, replay);
      // Live quotes carry today's times: the page keeps the real clock.
      const clock = options.stream === "live" ? Date.now() : await replay.clock();
      await driver.load(server.url, seedScript(WEB_LAYOUT, clock, "portfolio-list:home-watchlist"));
      await waitUntil(driver, `!!document.querySelector("${pane("chart-composer:home")} canvas")`, 30_000).catch(async (error) => {
        await driver.screenshot(cacheDir("drag-smoothness", "open-failed.png"));
        throw error;
      });
      // Streaming, the page never stops changing: a fixed while for its reads to land.
      if (options.stream === "off") await settle(driver, 1_500, 20_000);
      else await sleep(8_000);
    },
    async close() { server.stop(); },
  };
}

interface Sample {
  p50FrameMs: number;
  p95FrameMs: number;
  /** 60 Hz slots with no animation frame. */
  droppedFrames: number;
  /** Chromium: longtask entries during the drag; WebKit: null. */
  longTasks: number | null;
  /** Frames over 50 ms apart. */
  longFrames: number;
  /** Chromium: main-thread task time per frame, ms. */
  mainMsPerFrame: number | null;
  commits: number;
  moves: number;
  commitsPerMove: number;
  /** Quote frames the page received during the drag. */
  quotes: number;
  /** Frames over one and a half 60 Hz slots apart, and the React commits and quote frames that came in them. */
  lateFrames: number;
  lateFrameCommits: number;
  lateFrameQuotes: number;
  /** How far the moving pane's offset from the pointer strayed from its usual one, px, 95th percentile. */
  offPointerPx: number;
  /** Frames where the pointer moved 2 px or more and the pane did not move. */
  stuckFrames: number;
  /** Frames where the pane moved more than 2 px differently from the pointer: held, or jumping. */
  jerkyFrames: number;
  /** The most the pane moved differently from the pointer in one frame, px. */
  largestJumpPx: number;
  /**
   * Chromium: the moves with no predicted point (the host draws those at the
   * pointer, the others up to 48 px ahead of it), and how much the predicted
   * point's lead changed from one move to the next, px, 95th percentile and
   * most: what it adds to the drawn pane's own motion. WebKit predicts nothing.
   */
  unpredictedMoves: number | null;
  predictionWobblePx: number | null;
  predictionWobbleMaxPx: number | null;
  /** Chromium: long animation frames, and their scripts' time by what ran them. */
  loafCount: number | null;
  loafScripts?: Record<string, number>;
  /** Where the pane landed, its top left, px. */
  landing?: Point | null;
  /** `--verbose`: [pointer x, pointer y, pane x, pane y] each frame, and Chromium's long animation frames. */
  follow?: Array<[number, number, number, number]>;
  loaf?: unknown[];
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

/**
 * How the moving pane kept to the pointer, from where the pointer was when
 * each frame began and where the pane was drawn in it: its offset against the usual one (a
 * magnet holding it, or a frame drawn late, strays from it), the frames it
 * stood still while the pointer moved, the frames it moved differently from
 * the pointer, and the most it did in one frame.
 */
function followStats(samples: Array<[number, number, number, number]>): Pick<Sample, "offPointerPx" | "stuckFrames" | "jerkyFrames" | "largestJumpPx"> {
  if (samples.length < 3) return { offPointerPx: 0, stuckFrames: 0, jerkyFrames: 0, largestJumpPx: 0 };
  const dx = samples.map(([px, , x]) => x - px);
  const dy = samples.map(([, py, , y]) => y - py);
  const mx = median(dx);
  const my = median(dy);
  let stuck = 0;
  let jerky = 0;
  let largest = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const [px, py, x, y] = samples[index]!;
    const [ppx, ppy, prevX, prevY] = samples[index - 1]!;
    if (Math.hypot(px - ppx, py - ppy) >= 2 && Math.hypot(x - prevX, y - prevY) < 0.5) stuck += 1;
    const off = Math.hypot((x - prevX) - (px - ppx), (y - prevY) - (py - ppy));
    if (off > 2) jerky += 1;
    largest = Math.max(largest, off);
  }
  return {
    offPointerPx: percentile(samples.map((_, index) => Math.hypot(dx[index]! - mx, dy[index]! - my)), 0.95),
    stuckFrames: stuck,
    jerkyFrames: jerky,
    largestJumpPx: largest,
  };
}

/** Where the host draws a drag for each move (the predicted point, or the pointer), against the pointer. */
function predictionStats(moves: Array<[number, number, number | null, number | null]>, predicts: boolean): Pick<Sample, "unpredictedMoves" | "predictionWobblePx" | "predictionWobbleMaxPx"> {
  if (!predicts || moves.length === 0) return { unpredictedMoves: null, predictionWobblePx: null, predictionWobbleMaxPx: null };
  const lead = moves.map(([x, y, px, py]) => {
    if (px === null || py === null || Math.hypot(px - x, py - y) > 48) return null;
    return [px - x, py - y] as const;
  });
  const wobble: number[] = [];
  for (let index = 1; index < lead.length; index += 1) {
    const [ax, ay] = lead[index - 1] ?? [0, 0];
    const [bx, by] = lead[index] ?? [0, 0];
    wobble.push(Math.hypot(bx - ax, by - ay));
  }
  return {
    unpredictedMoves: lead.filter((entry) => entry === null).length,
    predictionWobblePx: percentile(wobble, 0.95),
    predictionWobbleMaxPx: Math.max(0, ...wobble),
  };
}

const TRACE_CATEGORIES = [
  "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
  "blink", "cc", "gpu", "viz", "benchmark", "toplevel", "v8", "disabled-by-default-v8.gc",
];

/** Chromium: a performance trace of `run`, written to `file`. */
async function traced(cdp: Cdp, file: string, run: () => Promise<void>): Promise<void> {
  const events: unknown[] = [];
  cdp.on("Tracing.dataCollected", (event: { value: unknown[] }) => { events.push(...event.value); });
  await cdp.send("Tracing.start", { traceConfig: { includedCategories: TRACE_CATEGORIES }, transferMode: "ReportEvents" });
  await run();
  const done = cdp.once("Tracing.tracingComplete", 60_000);
  await cdp.send("Tracing.end");
  await done;
  await Bun.write(file, JSON.stringify({ traceEvents: events }));
}

interface CpuProfile {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>;
  samples: number[];
  timeDeltas: number[];
}

/** Chromium: a CPU profile of `run`, written to `file`; the functions that took the most time themselves, ms. */
async function profiled(cdp: Cdp, file: string, run: () => Promise<void>): Promise<Array<[string, number]>> {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await run();
  const { profile } = await cdp.send<{ profile: CpuProfile }>("Profiler.stop");
  await Bun.write(file, JSON.stringify(profile));
  const byNode = new Map(profile.nodes.map((node) => [node.id, node.callFrame]));
  const self = new Map<string, number>();
  profile.samples.forEach((id, index) => {
    const frame = byNode.get(id);
    if (!frame || frame.functionName === "(idle)" || frame.functionName === "(program)") return;
    const name = `${frame.functionName || "(anonymous)"} ${frame.url ? `${basename(frame.url)}:${frame.lineNumber + 1}` : ""}`.trim();
    self.set(name, (self.get(name) ?? 0) + (profile.timeDeltas[index] ?? 0) / 1000);
  });
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

/** Presses the pane's grip and moves the pointer a few px, so the drag has begun and what moves with it is drawn. */
async function pickUp(driver: Driver, scenario: Scenario): Promise<Point> {
  const start = await driver.evaluate<Point | null>(gripOf(scenario.paneId));
  if (!start) throw new Error(`${scenario.name}: no grip to grab on ${scenario.paneId}`);
  await driver.mouse("move", start.x, start.y);
  await driver.mouse("down", start.x, start.y);
  for (let step = 1; step <= 4; step += 1) {
    await driver.mouse("move", start.x + step * 3, start.y + step * 2);
    await sleep(FRAME_MS);
  }
  await sleep(200);
  return { x: start.x + 12, y: start.y + 8 };
}

/** Moves the pointer along `legs` at 60 moves a second, resting at each stop. */
async function walk(driver: Driver, from: Point, legs: Leg[], onRest?: (index: number) => Promise<void>): Promise<void> {
  let at = from;
  for (const [index, leg] of legs.entries()) {
    const began = performance.now();
    for (let move = 1; ; move += 1) {
      const t = Math.min(1, (move * FRAME_MS) / leg.ms);
      const k = minimumJerk(t);
      const x = Math.round((at.x + (leg.to.x - at.x) * k) * 2) / 2;
      const y = Math.round((at.y + (leg.to.y - at.y) * k) * 2) / 2;
      await driver.mouse("move", x, y);
      if (t >= 1) break;
      const wait = began + move * FRAME_MS - performance.now();
      if (wait > 0) await sleep(wait);
    }
    at = leg.to;
    await sleep(leg.restMs);
    await onRest?.(index);
  }
}

async function measure(driver: Driver, scenario: Scenario, speed: Speed, traceFile?: string, profileFile?: string): Promise<Sample & { profile?: Array<[string, number]> }> {
  const start = await pickUp(driver, scenario);
  const around = await driver.evaluate<Surroundings | null>(surroundings(scenario));
  if (!around) throw new Error(`${scenario.name}: ${scenario.follower} is not drawn once the drag began`);
  // Each frame notes how long since the last, what came in it and where the
  // pointer is (the host applies the moves that came before the frame in it,
  // and any later one in the next), and once it has drawn (a task after it),
  // where the moving pane is.
  await driver.evaluate(`(() => {
    window.__frames = []; window.__follow = []; window.__commits = 0; window.__moves = 0; window.__quotes = 0; window.__loaf = []; window.__predicted = [];
    if (window.__longTasks) window.__longTasks = [];
    const follower = ${JSON.stringify(scenario.follower)};
    window.__recording = true;
    let last = performance.now(), commits = 0, quotes = 0;
    const tick = (now) => {
      window.__frames.push([now - last, window.__commits - commits, window.__quotes - quotes]);
      last = now; commits = window.__commits; quotes = window.__quotes;
      const pointer = [window.__pointerX, window.__pointerY];
      setTimeout(() => {
        const box = document.querySelector(follower)?.getBoundingClientRect();
        if (box && window.__recording) window.__follow.push([pointer[0], pointer[1], box.x, box.y]);
      }, 0);
      if (window.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  const taskBefore = await driver.taskMs();
  let end = start;
  const moves = async () => {
    if (speed === "sweep") {
      const began = performance.now();
      for (let move = 1; ; move += 1) {
        const t = (performance.now() - began) / SWEEP_MS;
        if (t >= 1) break;
        end = scenario.sweep(start, t);
        await driver.mouse("move", end.x, end.y);
        const wait = began + move * FRAME_MS - performance.now();
        if (wait > 0) await sleep(wait);
      }
      return;
    }
    const legs = handLegs(around, speed);
    await walk(driver, around.pointer, legs);
    end = legs[legs.length - 1]!.to;
  };
  let profile: Array<[string, number]> | undefined;
  if (profileFile && driver.cdp) profile = await profiled(driver.cdp, profileFile, moves);
  else if (traceFile && driver.cdp) await traced(driver.cdp, traceFile, moves);
  else await moves();
  const taskAfter = await driver.taskMs();
  const recorded = await driver.evaluate<{ frames: Array<[number, number, number]>; follow: Array<[number, number, number, number]>; commits: number; moves: number; quotes: number; longTasks: number[] | null; loaf: Array<{ duration: number; scripts: Array<{ duration: number; invoker: string; source: string }> }>; predicted: Array<[number, number, number | null, number | null]> }>(
    "(() => { window.__recording = false; return { frames: window.__frames.slice(1), follow: window.__follow.slice(1), commits: window.__commits, moves: window.__moves, quotes: window.__quotes, longTasks: window.__longTasks, loaf: window.__loaf, predicted: window.__predicted }; })()",
  );
  await driver.mouse("up", end.x, end.y);
  await sleep(300);
  const landing = scenario.follower === OUTLINE ? null : await driver.evaluate<Point | null>(`(() => { const r = document.querySelector(${JSON.stringify(scenario.follower)})?.getBoundingClientRect(); return r ? { x: r.x, y: r.y } : null; })()`);
  const frameTimes = recorded.frames.map(([interval]) => interval);
  const late = recorded.frames.filter(([interval]) => interval > LATE_FRAME_MS);
  const loafScripts: Record<string, number> = {};
  for (const frame of recorded.loaf) {
    for (const script of frame.scripts) {
      const name = `${script.invoker}${script.source ? ` (${script.source})` : ""}`;
      loafScripts[name] = (loafScripts[name] ?? 0) + script.duration;
    }
  }
  return {
    p50FrameMs: percentile(frameTimes, 0.5),
    p95FrameMs: percentile(frameTimes, 0.95),
    droppedFrames: frameTimes.reduce((dropped, time) => dropped + Math.max(0, Math.round(time / FRAME_MS) - 1), 0),
    longTasks: recorded.longTasks ? recorded.longTasks.length : null,
    longFrames: frameTimes.filter((time) => time > LONG_FRAME_MS).length,
    mainMsPerFrame: taskBefore !== null && taskAfter !== null ? (taskAfter - taskBefore) / Math.max(1, frameTimes.length) : null,
    commits: recorded.commits,
    moves: recorded.moves,
    commitsPerMove: recorded.moves > 0 ? recorded.commits / recorded.moves : 0,
    quotes: recorded.quotes,
    lateFrames: late.length,
    lateFrameCommits: late.reduce((sum, [, commits]) => sum + commits, 0),
    lateFrameQuotes: late.reduce((sum, [, , quotes]) => sum + quotes, 0),
    ...followStats(recorded.follow),
    ...predictionStats(recorded.predicted, driver.cdp !== null),
    loafCount: driver.cdp ? recorded.loaf.length : null,
    loafScripts,
    landing,
    follow: recorded.follow,
    loaf: recorded.loaf,
    profile,
  };
}

/** Pictures a hand's drag at rest at each stop (held long enough for the magnets and a join), and after the release; nothing is measured. */
async function picture(driver: Driver, scenario: Scenario, file: (label: string) => string): Promise<void> {
  await pickUp(driver, scenario);
  const around = await driver.evaluate<Surroundings | null>(surroundings(scenario));
  if (!around) throw new Error(`${scenario.name}: ${scenario.follower} is not drawn once the drag began`);
  const legs = handLegs(around, "medium").map((leg) => ({ ...leg, restMs: 700 }));
  await walk(driver, around.pointer, legs, (index) => driver.screenshot(file(`stop${index + 1}`)));
  const end = legs[legs.length - 1]!.to;
  await driver.mouse("up", end.x, end.y);
  await sleep(400);
  await driver.screenshot(file("released"));
}

const ROWS: Array<[string, (sample: Sample) => number | null, number]> = [
  ["frame time p50 (ms)", (s) => s.p50FrameMs, 1],
  ["frame time p95 (ms)", (s) => s.p95FrameMs, 1],
  ["dropped frames (60 Hz)", (s) => s.droppedFrames, 0],
  ["long tasks", (s) => s.longTasks, 0],
  ["frames over 50 ms", (s) => s.longFrames, 0],
  ["main thread per frame (ms)", (s) => s.mainMsPerFrame, 2],
  ["React commits per pointer move", (s) => s.commitsPerMove, 3],
  ["quote frames during the drag", (s) => s.quotes, 0],
  ["frames drawn late (over 1.5 slots)", (s) => s.lateFrames, 0],
  ["React commits in late frames", (s) => s.lateFrameCommits, 0],
  ["quote frames in late frames", (s) => s.lateFrameQuotes, 0],
  ["frames the pane stood still while the pointer moved", (s) => s.stuckFrames, 0],
  ["frames the pane moved off the pointer's motion", (s) => s.jerkyFrames, 0],
  ["largest jump off the pointer's motion (px)", (s) => s.largestJumpPx, 1],
  ["pane off its place under the pointer, p95 (px)", (s) => s.offPointerPx, 1],
  ["moves with no predicted point", (s) => s.unpredictedMoves, 0],
  ["predicted point's lead, change per move p95 (px)", (s) => s.predictionWobblePx, 1],
  ["predicted point's lead, largest change (px)", (s) => s.predictionWobbleMaxPx, 1],
];

async function recordStream(root: string, label: string, seconds: number, options: WebOptions & Options): Promise<void> {
  await mkdir(options.replayDir, { recursive: true });
  const record = join(options.replayDir, "socket.jsonl");
  await Bun.write(record, "");
  const setup = await setUpApp("web", label, root, { ...options, stream: "live", record });
  const driver = await chromiumDriver(`record-${label}`, options);
  try {
    // The replay's clock, so the reads the page makes now are the ones a replay asks for.
    await setup.open(driver);
    console.error(`Recording Gloom Cloud's frames for ${seconds} s into ${record}`);
    await sleep(seconds * 1000);
  } finally {
    await driver.close();
    await setup.close();
  }
  const lines = (await Bun.file(record).text()).trim().split("\n").filter(Boolean);
  const quotes = lines.filter((line) => line.includes("market.quote")).length;
  console.log(`Kept ${lines.length} frames (${quotes} of quotes, ${(quotes / seconds).toFixed(1)} a second) in ${record}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sides: Array<{ label: string; root: string }> = [];
  for (let index = args.indexOf("--side"); index !== -1; index = args.indexOf("--side")) {
    const value = args[index + 1] ?? "";
    const [label, root] = value.includes("=") ? value.split("=") as [string, string] : [value, value];
    sides.push({ label, root: resolve(root) });
    args.splice(index, 2);
  }
  if (sides.length === 0) sides.push({ label: "this checkout", root: resolve(join(import.meta.dir, "../..")) });
  const apps = (takeOption(args, "--app") ?? "web,desktop").split(",") as App[];
  const engines = (takeOption(args, "--engine") ?? "chromium,webkit").split(",") as Engine[];
  const speeds = (takeOption(args, "--speed") ?? "slow,medium,fast").split(",") as Speed[];
  const runs = positiveInteger(takeOption(args, "--runs"), 3, "--runs");
  const only = takeOption(args, "--only");
  const jsonOut = takeOption(args, "--json");
  const shots = takeOption(args, "--shots");
  const traces = takeOption(args, "--trace");
  const profiles = takeOption(args, "--profile");
  const recordSeconds = takeOption(args, "--record-stream");
  const options: Options & WebOptions = {
    dpr: Number(takeOption(args, "--dpr") ?? 1),
    gpu: args.includes("--gpu"),
    offline: args.includes("--offline"),
    build: !args.includes("--no-build"),
    stream: (takeOption(args, "--stream") ?? "off") as Stream,
    replayDir: resolve(takeOption(args, "--replay-dir") ?? cacheDir("drag-smoothness-replay")),
  };
  const verbose = args.includes("--verbose");
  for (const app of apps) if (!(app in SCENARIOS)) throw new Error(`Unknown --app ${app}: web or desktop`);
  for (const engine of engines) if (engine !== "chromium" && engine !== "webkit") throw new Error(`Unknown --engine ${engine}: chromium or webkit`);
  for (const speed of speeds) if (speed !== "sweep" && !(speed in HAND)) throw new Error(`Unknown --speed ${speed}: slow, medium, fast or sweep`);
  if (!["off", "live", "replay"].includes(options.stream)) throw new Error(`Unknown --stream ${options.stream}: live or replay`);
  if (recordSeconds) {
    await recordStream(sides[0]!.root, sides[0]!.label, positiveInteger(recordSeconds, 180, "--record-stream"), options);
    return;
  }

  const results: Record<string, Record<string, Array<Sample & { profile?: Array<[string, number]> }>>> = {};
  const launch = (engine: Engine, label: string) => (engine === "chromium" ? chromiumDriver(`smooth-${label}`, options) : webkitDriver(options));
  for (const app of apps) {
    const scenarios = SCENARIOS[app].filter((scenario) => !only || scenario.name.includes(only));
    const setups = new Map<string, AppSetup>();
    try {
      for (const side of sides) setups.set(side.label, await setUpApp(app, side.label, side.root, { ...options, stream: app === "web" ? options.stream : "off" }));
      for (const engine of engines) {
        for (let run = 1; run <= (shots ? 1 : runs); run += 1) {
          for (const side of sides) {
            const setup = setups.get(side.label)!;
            let driver = await launch(engine, side.label);
            const close = () => withTimeout(driver.close(), 10_000, `closing ${engine} for ${side.label}`).catch((error) => console.error(String(error)));
            try {
              for (const scenario of scenarios) {
                const slug = `${app}-${engine}-${scenario.name.replace(/\W+/g, "-")}`;
                if (shots) {
                  await setup.open(driver);
                  await mkdir(resolve(shots), { recursive: true });
                  await picture(driver, scenario, (label) => join(resolve(shots), `${slug}-${side.label}-${label}.png`));
                  continue;
                }
                for (const speed of speeds) {
                  const name = `${slug}-${speed}-${side.label}-${run}`;
                  const traceFile = traces ? join(resolve(traces), `${name}.json`) : undefined;
                  const profileFile = profiles ? join(resolve(profiles), `${name}.cpuprofile`) : undefined;
                  for (const dir of [traces, profiles]) if (dir) await mkdir(resolve(dir), { recursive: true });
                  // A fresh page each drag: the last one's landing moved the pane.
                  // Playwright's WebKit now and then stops answering a page
                  // with a socket open: that drag runs again in a new browser.
                  let sample: Awaited<ReturnType<typeof measure>> | null = null;
                  for (let attempt = 1; !sample; attempt += 1) {
                    try {
                      await withTimeout(setup.open(driver), 60_000, `${name}: opening the page`);
                      sample = await withTimeout(measure(driver, scenario, speed, traceFile, profileFile), 60_000, `${name}: the drag`);
                    } catch (error) {
                      if (attempt === 2) throw error;
                      console.error(`${String(error)}; again in a new browser`);
                      await close();
                      driver = await launch(engine, side.label);
                    }
                  }
                  if (!verbose) {
                    delete sample.follow;
                    delete sample.loaf;
                  }
                  const key = `${app} | ${engine} | ${scenario.name} | ${speed}`;
                  ((results[key] ??= {})[side.label] ??= []).push(sample);
                  console.error(`${key} | ${side.label} #${run}: p95 ${sample.p95FrameMs.toFixed(1)} ms, dropped ${sample.droppedFrames}, long tasks ${sample.longTasks ?? "-"}, ${sample.quotes} quote frames, late frames ${sample.lateFrames} (${sample.lateFrameCommits} commits, ${sample.lateFrameQuotes} quote frames in them), stood still ${sample.stuckFrames}, off the pointer's motion ${sample.jerkyFrames}, largest jump ${sample.largestJumpPx.toFixed(1)} px`);
                  if (sample.profile) console.error(`  most time: ${sample.profile.map(([fn, ms]) => `${fn} ${ms.toFixed(1)} ms`).join("; ")}`);
                }
              }
            } finally {
              await close();
            }
          }
        }
      }
    } finally {
      for (const setup of setups.values()) await setup.close();
    }
  }
  if (shots) {
    console.log(`Pictures: ${resolve(shots)}`);
    return;
  }

  const lines = [
    `Median of ${runs} runs, 60 moves a second, ${VIEWPORT.width} by ${VIEWPORT.height} at ${options.dpr}x, quotes ${options.stream === "off" ? "not streaming" : options.stream === "live" ? "streaming live" : "streaming as kept"}. Chromium: ${options.gpu ? "Chrome with its GPU" : "the pinned headless shell"}; WebKit: Playwright's.`,
    "",
    `| drag | metric | ${sides.map((side) => side.label).join(" | ")} |`,
    `|---|---|${sides.map(() => "---|").join("")}`,
  ];
  for (const [key, bySide] of Object.entries(results)) {
    for (const [label, pick, places] of ROWS) {
      const cells = sides.map((side) => {
        const values = (bySide[side.label] ?? []).map(pick);
        if (values.length === 0 || values.some((value) => value === null)) return "n/a";
        return median(values as number[]).toFixed(places);
      });
      lines.push(`| ${key} | ${label} | ${cells.join(" | ")} |`);
    }
  }
  const loafLines: string[] = [];
  for (const [key, bySide] of Object.entries(results)) {
    for (const side of sides) {
      const totals: Record<string, number> = {};
      const samples = bySide[side.label] ?? [];
      for (const sample of samples) for (const [name, ms] of Object.entries(sample.loafScripts ?? {})) totals[name] = (totals[name] ?? 0) + ms / samples.length;
      const top = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 4);
      if (top.length > 0) loafLines.push(`- ${key} | ${side.label}: ${top.map(([name, ms]) => `${name} ${ms.toFixed(0)} ms`).join("; ")}`);
    }
  }
  if (loafLines.length > 0) lines.push("", "Scripts in Chromium's long animation frames (a run's mean):", "", ...loafLines);
  console.log(lines.join("\n"));
  const out = resolve(jsonOut ?? cacheDir("drag-smoothness", `results-${Date.now()}.json`));
  await mkdir(resolve(out, ".."), { recursive: true });
  await Bun.write(out, JSON.stringify({ sides, runs, speeds, options, results }, null, 2));
  console.error(`Samples: ${out}`);
}

await main();
// A browser that stopped answering keeps the process alive: the run is over.
process.exit(process.exitCode ?? 0);
