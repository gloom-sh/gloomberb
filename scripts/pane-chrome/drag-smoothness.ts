import { mkdir } from "fs/promises";
import { join, resolve } from "path";
import { median, positiveInteger, takeOption } from "../tui-benchmark-harness";
import { cacheDir, evaluate, launchBrowser, sleep, type Cdp, type Point } from "./browser";
import { serveFixturePage } from "./page";
import { createReplay, routeDirectReads, seedScript, serveWebApp } from "./web-app";

/**
 * How smooth a pane move is, with real pointer input, in the app's two
 * renderers and the two engines they run in. Each run presses a pane's header
 * and moves the pointer for 2 s at 60 moves a second: a floating pane moved
 * around the screen, over the docked panes, their title bars and the edges it
 * can join at, and a docked pane pulled out of the dock, across the panes
 * beside and under it, and back.
 *
 * - `web`: the real web build of each checkout (the browser renderer),
 *   signed out, over the reads web-app.ts replays: a watchlist, news, a
 *   ticker's research with its chart, movers, indices, a calendar and a
 *   floating trending list.
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
 * frame (Chromium), React commits per pointer move the page received, and how
 * the moving pane kept to the pointer: frames where it stood still while the
 * pointer moved, frames where it moved more than 2 px differently from the
 * pointer (held by a magnet, or jumping off one), and how far its offset from
 * the pointer strayed (95th percentile). Checkouts take turns, `--runs` times;
 * the table shows the median.
 *
 *   bun run benchmark:pane-drag:smoothness --side pre=<checkout> --side main=<checkout> --side fix=. \
 *     [--app web,desktop] [--engine chromium,webkit] [--runs 3] [--drag-ms 2000] [--dpr 1] [--gpu]
 *     [--offline] [--no-build] [--only <text>] [--json <file>] [--shots <dir>] [--trace <dir>] [--verbose]
 *
 * Chromium is the pinned headless shell, which paints without a GPU; `--gpu`
 * runs Chrome (CHROME_PATH, or the installed one) in its new headless mode
 * with its GPU. On a Mac whose display sleeps (a headless Mac mini) headless
 * Chrome paints only 8 to 30 frames a second however little a frame costs, so
 * its frame times say nothing there: take them from Linux (the CI runner) and
 * read WebKit's, which keeps to 60 Hz, on the Mac. `--shots` pictures each drag
 * held at points along its path instead of measuring; `--trace` writes a
 * Chromium performance trace of each drag.
 */

const VIEWPORT = { width: 1440, height: 900 };
const FRAME_MS = 1_000 / 60;
const LONG_FRAME_MS = 50;

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
window.addEventListener("pointermove", (event) => { window.__moves += 1; window.__pointerX = event.clientX; window.__pointerY = event.clientY; }, true);
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

interface Options {
  dragMs: number;
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
  const browser = await webkit.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: options.dpr });
  // Nothing past this machine, as the Chromium side does.
  await context.route("**/*", (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
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
  /** A page expression for where the press lands. */
  grab: string;
  /** What moves with the pointer: the floating pane, or the outline a docked one drags. */
  follower: string;
  path(start: Point, t: number): Point;
}

const pane = (id: string) => `[data-gloom-pane-id='${id}']`;
const titleOf = (id: string) => `(() => { const element = document.querySelector("${pane(id)} [data-gloom-role=pane-title]"); if (!element) return null; const r = element.getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 24), y: r.y + r.height / 2 }; })()`;
const OUTLINE = "[data-gloom-role=drag-outline]";

/**
 * Around the screen and back, over docked panes, their title bars and the
 * edges a floating pane joins at, never so far that the window's edge holds
 * the pane.
 */
const floatingPath = (start: Point, t: number): Point => ({
  x: start.x + Math.sin(t * Math.PI * 2) * 380,
  y: start.y + (1 - Math.cos(t * Math.PI * 2)) * 90,
});
/** Out of the dock at the top left, across the panes beside and under it, and back over where it was. */
const undockPath = (start: Point, t: number): Point => ({
  x: start.x + Math.sin(t * Math.PI) * 480,
  y: start.y + (1 - Math.cos(t * Math.PI * 2)) * 110,
});

const leaf = (instanceId: string) => ({ kind: "pane", instanceId });
const WEB_LAYOUT = {
  dockRoot: {
    kind: "split", axis: "horizontal", ratio: 0.32,
    first: { kind: "split", axis: "vertical", ratio: 0.55, first: leaf("portfolio-list:main"), second: leaf("news-top:main") },
    second: {
      kind: "split", axis: "horizontal", ratio: 0.58,
      first: { kind: "split", axis: "vertical", ratio: 0.62, first: leaf("ticker-research:main"), second: leaf("market-movers:main") },
      second: { kind: "split", axis: "vertical", ratio: 0.5, first: leaf("world-indices:main"), second: leaf("econ-calendar:main") },
    },
  },
  instances: [
    { instanceId: "portfolio-list:main", paneId: "portfolio-list", params: { collectionId: "main" }, binding: { kind: "none" } },
    { instanceId: "news-top:main", paneId: "news-top", binding: { kind: "none" } },
    { instanceId: "ticker-research:main", paneId: "ticker-research", binding: { kind: "fixed", symbol: "AAPL" } },
    { instanceId: "market-movers:main", paneId: "market-movers", binding: { kind: "none" } },
    { instanceId: "world-indices:main", paneId: "world-indices", binding: { kind: "none" } },
    { instanceId: "econ-calendar:main", paneId: "econ-calendar", binding: { kind: "none" } },
    { instanceId: "attention-trending:float", paneId: "attention-trending", binding: { kind: "none" } },
  ],
  floating: [{ instanceId: "attention-trending:float", x: 66, y: 10, width: 64, height: 20, zIndex: 60 }],
  detached: [],
};

const SCENARIOS: Record<App, Scenario[]> = {
  web: [
    { name: "floating move", grab: titleOf("attention-trending:float"), follower: pane("attention-trending:float"), path: floatingPath },
    { name: "undock", grab: titleOf("portfolio-list:main"), follower: OUTLINE, path: undockPath },
  ],
  desktop: [
    { name: "floating move", grab: titleOf("table:float"), follower: pane("table:float"), path: floatingPath },
    { name: "undock", grab: titleOf("table:1"), follower: OUTLINE, path: undockPath },
  ],
};

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

async function setUpApp(app: App, label: string, root: string, options: { offline: boolean; build: boolean }): Promise<AppSetup> {
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
    const built = Bun.spawnSync(["bun", "scripts/build-web.ts", "--out", dist], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (built.exitCode !== 0) throw new Error(`The web build of ${root} failed:\n${built.stderr.toString().slice(-2000)}`);
  }
  const replay = createReplay(cacheDir("drag-smoothness-replay"), { offline: options.offline });
  const server = serveWebApp(dist, replay);
  return {
    async open(driver) {
      if (driver.cdp) await routeDirectReads(driver.cdp, replay);
      await driver.load(server.url, seedScript(WEB_LAYOUT, await replay.clock(), "ticker-research:main"));
      await waitUntil(driver, `!!document.querySelector("${pane("news-top:main")}")`, 30_000);
      await settle(driver, 1_500, 20_000);
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
  /** How far the moving pane's offset from the pointer strayed from its usual one, px, 95th percentile. */
  offPointerPx: number;
  /** Frames where the pointer moved 2 px or more and the pane did not move. */
  stuckFrames: number;
  /** Frames where the pane moved more than 2 px differently from the pointer: held, or jumping. */
  jerkyFrames: number;
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
 * each frame began and where the pane was drawn in it: its offset against
 * the usual one (a magnet holding it, or a frame drawn late, strays from it),
 * the frames it stood still while the pointer moved, and the frames it moved
 * differently from the pointer.
 */
function followStats(samples: Array<[number, number, number, number]>): Pick<Sample, "offPointerPx" | "stuckFrames" | "jerkyFrames"> {
  if (samples.length < 3) return { offPointerPx: 0, stuckFrames: 0, jerkyFrames: 0 };
  const dx = samples.map(([px, , x]) => x - px);
  const dy = samples.map(([, py, , y]) => y - py);
  const mx = median(dx);
  const my = median(dy);
  let stuck = 0;
  let jerky = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const [px, py, x, y] = samples[index]!;
    const [ppx, ppy, prevX, prevY] = samples[index - 1]!;
    if (Math.hypot(px - ppx, py - ppy) >= 2 && Math.hypot(x - prevX, y - prevY) < 0.5) stuck += 1;
    if (Math.hypot((x - prevX) - (px - ppx), (y - prevY) - (py - ppy)) > 2) jerky += 1;
  }
  return {
    offPointerPx: percentile(samples.map((_, index) => Math.hypot(dx[index]! - mx, dy[index]! - my)), 0.95),
    stuckFrames: stuck,
    jerkyFrames: jerky,
  };
}

const TRACE_CATEGORIES = [
  "devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
  "blink", "cc", "gpu", "viz", "benchmark", "toplevel",
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

async function measure(driver: Driver, scenario: Scenario, options: Options, traceFile?: string): Promise<Sample> {
  const start = await driver.evaluate<Point | null>(scenario.grab);
  if (!start) throw new Error(`${scenario.name}: nothing to grab (${scenario.grab})`);
  await driver.mouse("move", start.x, start.y);
  await driver.mouse("down", start.x, start.y);
  // Each frame notes when it began and where the pointer was, and once it has
  // drawn (a task after it), where the moving pane is.
  await driver.evaluate(`(() => {
    window.__frameTimes = []; window.__follow = []; window.__commits = 0; window.__moves = 0; window.__loaf = [];
    if (window.__longTasks) window.__longTasks = [];
    const follower = ${JSON.stringify(scenario.follower)};
    window.__recording = true;
    let last = performance.now();
    const tick = (now) => {
      window.__frameTimes.push(now - last);
      last = now;
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
  const moves = async () => {
    const began = performance.now();
    for (let move = 1; ; move += 1) {
      const t = (performance.now() - began) / options.dragMs;
      if (t >= 1) break;
      const at = scenario.path(start, t);
      await driver.mouse("move", at.x, at.y);
      const wait = began + move * FRAME_MS - performance.now();
      if (wait > 0) await sleep(wait);
    }
  };
  if (traceFile && driver.cdp) await traced(driver.cdp, traceFile, moves);
  else await moves();
  const taskAfter = await driver.taskMs();
  const recorded = await driver.evaluate<{ frameTimes: number[]; follow: Array<[number, number, number, number]>; commits: number; moves: number; longTasks: number[] | null; loaf: unknown[] }>(
    "(() => { window.__recording = false; return { frameTimes: window.__frameTimes.slice(1), follow: window.__follow.slice(1), commits: window.__commits, moves: window.__moves, longTasks: window.__longTasks, loaf: window.__loaf }; })()",
  );
  const end = scenario.path(start, 1);
  await driver.mouse("up", end.x, end.y);
  await sleep(200);
  const { frameTimes } = recorded;
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
    ...followStats(recorded.follow),
    follow: recorded.follow,
    loaf: recorded.loaf,
  };
}

/** Pictures a drag held at each of `stops` (fractions of its path), and after the release; nothing is measured. */
async function picture(driver: Driver, scenario: Scenario, file: (label: string) => string, stops: number[]): Promise<void> {
  const start = await driver.evaluate<Point | null>(scenario.grab);
  if (!start) throw new Error(`${scenario.name}: nothing to grab (${scenario.grab})`);
  await driver.mouse("move", start.x, start.y);
  await driver.mouse("down", start.x, start.y);
  let t = 0;
  for (const stop of stops) {
    for (; t < stop; t = Math.min(stop, t + 1 / 120)) {
      const point = scenario.path(start, t);
      await driver.mouse("move", point.x, point.y);
      await sleep(FRAME_MS);
    }
    const point = scenario.path(start, stop);
    await driver.mouse("move", point.x, point.y);
    // Long enough for the magnets to catch where it rests and a join to arm.
    await sleep(600);
    await driver.screenshot(file(`t${Math.round(stop * 100)}`));
  }
  const end = scenario.path(start, t);
  await driver.mouse("up", end.x, end.y);
  await sleep(300);
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
  ["frames the pane stood still while the pointer moved", (s) => s.stuckFrames, 0],
  ["frames the pane moved off the pointer's motion", (s) => s.jerkyFrames, 0],
  ["pane off its place under the pointer, p95 (px)", (s) => s.offPointerPx, 1],
];

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
  const runs = positiveInteger(takeOption(args, "--runs"), 3, "--runs");
  const only = takeOption(args, "--only");
  const jsonOut = takeOption(args, "--json");
  const shots = takeOption(args, "--shots");
  const traces = takeOption(args, "--trace");
  const options: Options = {
    dragMs: positiveInteger(takeOption(args, "--drag-ms"), 2_000, "--drag-ms"),
    dpr: Number(takeOption(args, "--dpr") ?? 1),
    gpu: args.includes("--gpu"),
  };
  const offline = args.includes("--offline");
  const build = !args.includes("--no-build");
  const verbose = args.includes("--verbose");
  for (const app of apps) if (!(app in SCENARIOS)) throw new Error(`Unknown --app ${app}: web or desktop`);
  for (const engine of engines) if (engine !== "chromium" && engine !== "webkit") throw new Error(`Unknown --engine ${engine}: chromium or webkit`);

  const results: Record<string, Record<string, Sample[]>> = {};
  const launch = (engine: Engine, label: string) => (engine === "chromium" ? chromiumDriver(`smooth-${label}`, options) : webkitDriver(options));
  for (const app of apps) {
    const scenarios = SCENARIOS[app].filter((scenario) => !only || scenario.name.includes(only));
    const setups = new Map<string, AppSetup>();
    try {
      for (const side of sides) setups.set(side.label, await setUpApp(app, side.label, side.root, { offline, build }));
      for (const engine of engines) {
        for (let run = 1; run <= (shots ? 1 : runs); run += 1) {
          for (const side of sides) {
            const setup = setups.get(side.label)!;
            const driver = await launch(engine, side.label);
            try {
              for (const scenario of scenarios) {
                await setup.open(driver);
                const slug = `${app}-${engine}-${scenario.name.replace(/\W+/g, "-")}`;
                if (shots) {
                  await mkdir(resolve(shots), { recursive: true });
                  await picture(driver, scenario, (label) => join(resolve(shots), `${slug}-${side.label}-${label}.png`), [0.12, 0.25, 0.5]);
                  continue;
                }
                const traceFile = traces ? join(resolve(traces), `${slug}-${side.label}-${run}.json`) : undefined;
                if (traceFile) await mkdir(resolve(traces!), { recursive: true });
                const sample = await measure(driver, scenario, options, traceFile);
                if (!verbose) {
                  delete sample.follow;
                  delete sample.loaf;
                }
                const key = `${app} | ${engine} | ${scenario.name}`;
                ((results[key] ??= {})[side.label] ??= []).push(sample);
                console.error(`${key} | ${side.label} #${run}: p50 ${sample.p50FrameMs.toFixed(1)} ms, p95 ${sample.p95FrameMs.toFixed(1)} ms, dropped ${sample.droppedFrames}, long tasks ${sample.longTasks ?? "-"}, frames over 50 ms ${sample.longFrames}, main ${sample.mainMsPerFrame?.toFixed(2) ?? "-"} ms/frame, ${sample.commits} commits / ${sample.moves} moves, stood still ${sample.stuckFrames}, off the pointer's motion ${sample.jerkyFrames}`);
              }
            } finally {
              await driver.close();
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
    `Median of ${runs} runs. ${options.dragMs / 1000} s drags at 60 moves a second, ${VIEWPORT.width} by ${VIEWPORT.height} at ${options.dpr}x. Chromium: ${options.gpu ? "Chrome with its GPU" : "the pinned headless shell"}; WebKit: Playwright's.`,
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
  console.log(lines.join("\n"));
  const out = resolve(jsonOut ?? cacheDir("drag-smoothness", `results-${Date.now()}.json`));
  await mkdir(resolve(out, ".."), { recursive: true });
  await Bun.write(out, JSON.stringify({ sides, runs, options, results }, null, 2));
  console.error(`Samples: ${out}`);
}

await main();
