import { appendFile } from "fs/promises";
import { join, resolve } from "path";
import { median, positiveInteger, takeOption } from "../tui-benchmark-harness";
import { cacheDir, evaluate, frames, launchBrowser, mouse, sleep, waitFor, type Cdp, type Point } from "./browser";
import { serveFixturePage, type FixturePage } from "./page";

/**
 * Frame budget of pane drags and resizes, against a base checkout. Each run
 * drags with real pointer input at 60 moves a second for 1.5 s: a docked and a
 * floating pane across a dense layout (fixture.tsx, `perf`), and, over the
 * `resize` layout, the corner of a floating news table, chart, heat map (an
 * invented one, and the market board of 500 names with ticks) and Fear &
 * Greed pane and of the charts that sit inside a pane's own layout (G
 * layout, chart over a table, chart beside a table, chart under a toolbar), a
 * dock divider between a news table and a chart and one between the G layout
 * and the chart beside a table (`nested`, each measured on both sides), the
 * divider of a table in a pane's sidebar, a chart composer's plot panned
 * back and forth (`cmp`), the divider beside a chat whose messages wrap
 * to its width, with the first page of messages and with 500 loaded, and the
 * divider beside DES's overview, with three accounts and with nine and a
 * description three times as long (`des`). It
 * reads what the page's main thread spent (Performance.getMetrics, in thread
 * time), the React commits and the animation frames the page ran, and for a
 * resize how far the frame's edge and the content's edge fell behind the
 * pointer. Base and this checkout take turns, so a runner that slows down
 * mid-job slows both, and the gate is a ratio of the medians: absolute
 * numbers mean little on a shared runner with no GPU.
 *
 * Frames are requestAnimationFrame callbacks in headless Chrome, not frames a
 * GPU presented. Missed frames are estimated against a fixed 60 Hz display:
 * an interval that rounds to n frame slots missed n - 1 of them.
 *
 *   bun run benchmark:pane-drag:compare --base <checkout> [--runs 5] [--head <checkout>] [--only <text>]
 *
 * `--head` measures another checkout in place of this one; `--only` keeps the
 * scenarios whose name contains the text.
 */

const VIEWPORT = { width: 1400, height: 900 };
const DRAG_MS = 1_500;
/** One frame slot of the 60 Hz display the drag is paced and judged against. */
const FRAME_MS = 1_000 / 60;
// Calibrated on main (ac27f2d6a) with identical code on both sides: the
// medians of five runs differed by at most 1.06x quiet and 1.17x on a 12-core
// host at load 35, and React commits by at most 3. The drag that re-rendered
// on every move (v0.16.1) costs 5 to 7 times as much per frame with 10 times
// the commits, and a slide written to the inline style instead of an animation
// (a whole-page relayering every frame) twice as much.
const MAX_FRAME_RATIO = 1.5;
const MIN_FRAME_DELTA_MS = 0.4;
const MAX_COMMIT_RATIO = 1.5;
const MIN_COMMIT_DELTA = 10;
/**
 * A resized frame, and what it holds, stays this close to the pointer (px,
 * 95th percentile), three cells: one that waits for React to catch up is up
 * to 100 ms of pointer travel behind (a chart drawn on the cell grid was 90
 * px), and a divider that only moves its line while the panes wait for the
 * release a whole drag. Under that, a frame or two drawn late on a busy
 * runner stays inside the budget.
 */
const MAX_FRAME_LAG_PX = 24;
/** The release lays a resize out where the pointer left it: within a cell (at the default size) of the frame, and the content, it drew. */
const MAX_RELEASE_JUMP_PX = 8;
/** At rest a chart's bitmap is drawn at the pixels its plot has; under this, the scale is the whole-pixel rounding of a fractional plot. */
const MAX_REST_STRETCH_PCT = 0.25;

/** Counts React commits through the DevTools hook React looks for when it loads, and keeps where the pointer is. */
const PAGE_PROBES = `
window.__commits = 0;
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, isDisabled: false, renderers: new Map(),
  inject() { return 1; },
  onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  onCommitFiberRoot() { window.__commits += 1; },
};
window.__pointerX = 0;
document.addEventListener("pointermove", (event) => { window.__pointerX = event.clientX; }, true);
`;

interface DragSample {
  /** Main-thread time (script, style, layout, paint and the rest) per animation frame, ms. */
  mainMsPerFrame: number;
  scriptMsPerFrame: number;
  styleLayoutMsPerFrame: number;
  commits: number;
  /** Animation frames the page ran during the drag. */
  frames: number;
  /** Animation frames per second. */
  fps: number;
  /** 95th percentile of the time between animation frames, ms. */
  p95FrameMs: number;
  /** Estimated 60 Hz frame slots with no animation frame. */
  missedFrames: number;
  /** Intervals between animation frames longer than 1.5 slots, however long. */
  longIntervals: number;
  /** Resizes: how far the frame's edge was from the pointer, px, 95th percentile. */
  frameLagPx?: number;
  /** Resizes: how far the content's edge was from the pointer, px, 95th percentile. */
  contentLagPx?: number;
  /** Resizes: how far the frame's edge moved when the pointer let go where it stood, px. */
  releaseJumpPx?: number;
  /** Resizes: how far the content's edge moved when the pointer let go, px. */
  contentReleaseJumpPx?: number;
  /** Charts: how far CSS scaled the canvas's bitmap from 1:1 during the drag, %, 95th percentile. */
  bitmapStretchPct?: number;
  /** Charts: the same once the pane is at rest after the release, %: 0 is drawn sharp. */
  restStretchPct?: number;
}

interface Scenario {
  name: string;
  /** The fixture layout (fixture.tsx), as its query string. */
  fixture: string;
  /** Where the press lands, and where the pointer is `t` (0 to 1) into the drag. */
  grab(cdp: Cdp): Promise<Point>;
  path(start: Point, t: number): Point;
  /**
   * Resizes: page expressions for the x, in px, of the edge of the frame the
   * pointer drags and of the content inside it. Each is judged by how far it
   * drifts from the pointer after the press; the content, from `anchor`
   * instead when given (the far edge of a pane whose near edge the pointer
   * moves).
   */
  track?: { frame: string; content: string; anchor?: string };
  /** Charts: the canvas whose bitmap scale (its CSS width against its pixels) says whether it is drawn 1:1. */
  canvas?: string;
  /** A page expression that holds once the scenario's content has loaded, for panes that load data. */
  ready?: string;
  /** Puts the page in the state the drag starts from, once it is ready. */
  prepare?(cdp: Cdp): Promise<void>;
}

const partCenter = (selector: string) => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + Math.min(r.width / 2, 16), y: r.y + r.height / 2 }; })()`;
const middleOf = (selector: string, dy = 0) => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 + ${dy} }; })()`;
const rightOf = (selector: string) => `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().right`;
const lastRightOf = (selector: string) => `(() => { const all = document.querySelectorAll(${JSON.stringify(selector)}); return all[all.length - 1].getBoundingClientRect().right; })()`;
const pane = (id: string) => `[data-gloom-pane-id='${id}']`;
/** The divider between the news table and the chart, above the floating pane. */
/** The vertical divider at the right edge of a docked pane, 60 px down it. */
const dividerRightOf = (paneId: string) => `(() => {
  const edge = document.querySelector("${pane(paneId)}").getBoundingClientRect();
  const y = edge.top + 60;
  const divider = [...document.querySelectorAll("[data-gloom-role=dock-divider][data-axis=horizontal]")]
    .map((element) => element.getBoundingClientRect())
    .find((r) => Math.abs(r.x + r.width / 2 - edge.right) <= 6 && r.top <= y && r.bottom >= y);
  return { x: divider.x + divider.width / 2, y };
})()`;
const TOP_DIVIDER = dividerRightOf("news:dock");
const CHAT_DIVIDER = dividerRightOf("chat:a");
const CHAT_ROWS = "document.querySelectorAll('[data-gloom-role=chat-message]').length";
const CHAT_LIST = "document.querySelector('[data-gloom-role=chat-message]').parentElement";

/** Scrolls the chat to its top until the channel has nothing older, as a reader who paged far back did, then to its newest message. */
async function loadWholeChat(cdp: Cdp): Promise<void> {
  for (let page = 0; page < 30; page += 1) {
    const rows = await evaluate<number>(cdp, CHAT_ROWS);
    await evaluate(cdp, `${CHAT_LIST}.scrollTop = 0`);
    if (!await waitFor(cdp, `${CHAT_ROWS} > ${rows}`, 3_000)) break;
    await frames(cdp, 2);
  }
  await evaluate(cdp, `(() => { const list = ${CHAT_LIST}; list.scrollTop = list.scrollHeight; })()`);
  await frames(cdp, 10);
}

/** The chat beside a plain pane: its messages wrap their text to the width the divider gives it. */
const chatDividerDrag = (name: string, fixture: string, prepare?: (cdp: Cdp) => Promise<void>): Scenario => ({
  name,
  fixture,
  ready: `${CHAT_ROWS} > 0`,
  prepare,
  grab: (cdp) => evaluate(cdp, CHAT_DIVIDER),
  path: (start, t) => ({ x: start.x - Math.sin(t * Math.PI * 2) * 200, y: start.y }),
  // The newest message, at the bottom of the list the pane opens on.
  track: { frame: rightOf(pane("chat:a")), content: lastRightOf(`${pane("chat:a")} [data-gloom-role=chat-message]`) },
});
const NESTED_DIVIDER = dividerRightOf("chart-bar:dock");
/** The positions table's last header, by its text, so a branch with padded columns finds it too. */
const DES_LAST_COLUMN = `(() => { const span = [...document.querySelectorAll("[data-gloom-pane-id='des:a'] span")].find((e) => e.childElementCount === 0 && e.textContent.trim() === "Ret"); return span.getBoundingClientRect().right; })()`;
/** DES beside a plain pane: its quote book, fundamentals, positions and description fill the width the divider gives it. */
const desDividerDrag = (name: string, fixture: string): Scenario => ({
  name,
  fixture,
  ready: `!!document.querySelector("[data-gloom-pane-id='des:a'] canvas")`,
  grab: (cdp) => evaluate(cdp, dividerRightOf("des:a")),
  path: (start, t) => ({ x: start.x - Math.sin(t * Math.PI * 2) * 200, y: start.y }),
  track: { frame: rightOf(pane("des:a")), content: DES_LAST_COLUMN },
});

/** A floating pane's corner, dragged out, in past where it started and out again, as the chart and table resizes do. */
const cornerResize = (name: string, float: string, paneId: string, content: string, canvas?: string): Scenario => ({
  name,
  fixture: `resize&float=${float}`,
  grab: (cdp) => evaluate(cdp, middleOf(`${pane(paneId)} [data-gloom-role=resize-handle]`)),
  path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 220, y: start.y + Math.sin(t * Math.PI * 2) * 90 }),
  track: { frame: rightOf(pane(paneId)), content: rightOf(`${pane(paneId)} ${content}`) },
  canvas,
});

/** How far, in %, CSS scales the canvas's bitmap from 1:1: its laid-out width against its pixels. */
const stretchOf = (selector: string) => `(() => { const canvas = document.querySelector(${JSON.stringify(selector)}); if (!canvas || !canvas.width) return 0; return Math.abs(canvas.getBoundingClientRect().width * devicePixelRatio / canvas.width - 1) * 100; })()`;

const SCENARIOS: Scenario[] = [
  {
    name: "docked pane drag",
    fixture: "perf",
    grab: (cdp) => evaluate(cdp, partCenter(`${pane("table:5")} [data-gloom-role=pane-grip]`)),
    // Over the other docked panes and their drop grids, and back.
    path: (start, t) => ({ x: start.x - Math.sin(t * Math.PI) * 420, y: start.y + Math.sin(t * Math.PI * 2) * 220 }),
  },
  {
    name: "floating pane drag",
    fixture: "perf",
    grab: (cdp) => evaluate(cdp, partCenter(`${pane("table:float")} [data-gloom-role=pane-title]`)),
    path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 360, y: start.y + (1 - Math.cos(t * Math.PI * 2)) * 140 }),
  },
  {
    name: "news table resize",
    fixture: "resize",
    grab: (cdp) => evaluate(cdp, middleOf(`${pane("news:float")} [data-gloom-role=resize-handle]`)),
    // Grows, shrinks past where it started, and grows back.
    path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 220, y: start.y + Math.sin(t * Math.PI * 2) * 90 }),
    track: {
      frame: rightOf(pane("news:float")),
      content: lastRightOf(`${pane("news:float")} [data-gloom-role=data-table-header-cell]`),
    },
  },
  // The canvas a chart draws on the cell grid, which catches up with a
  // resize a few times a second and is stretched with the frame in between.
  cornerResize("chart resize", "chart", "chart:float", "canvas", `${pane("chart:float")} canvas`),
  // Tiles placed in percentages of a map laid out on the cell grid.
  cornerResize("heat map resize", "heat", "heat:float", "[data-gloom-role=heat-treemap]"),
  // The market heat map's board: 500 names in sectors and industries, recoloured by ticks as the drag goes.
  cornerResize("market heat map resize", "heat&heat=market&ticks=1", "heat:float", "[data-gloom-role=heat-treemap]"),
  // A chart of a fixed height in a column of text: it follows the width only.
  cornerResize("fear and greed resize", "fear", "fear-greed:float", "[data-gloom-role=composite-chart]", `${pane("fear-greed:float")} [data-gloom-role=composite-chart] canvas`),
  {
    name: "dock divider drag",
    fixture: "resize",
    grab: (cdp) => evaluate(cdp, TOP_DIVIDER),
    path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 240, y: start.y }),
    track: {
      frame: rightOf(pane("news:dock")),
      content: lastRightOf(`${pane("news:dock")} [data-gloom-role=data-table-header-cell]`),
    },
  },
  {
    // The same divider, from the chart's side: the pointer moves the chart
    // pane's left edge, and its canvas keeps to the pane's right edge.
    name: "dock divider beside a chart",
    fixture: "resize",
    grab: (cdp) => evaluate(cdp, TOP_DIVIDER),
    path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 240, y: start.y }),
    track: {
      frame: `document.querySelector("${pane("chart:dock")}").getBoundingClientRect().left`,
      content: rightOf(`${pane("chart:dock")} canvas`),
      anchor: rightOf(pane("chart:dock")),
    },
    canvas: `${pane("chart:dock")} canvas`,
  },
  // Charts inside a pane's own layout: under a query bar (the G pane), in the
  // chart-table kit's band over a table with the pane's tabs, beside a table,
  // and under a toolbar laid over them.
  cornerResize("G layout resize", "g", "chart-bar:float", "canvas", `${pane("chart-bar:float")} canvas`),
  cornerResize("chart over a table resize", "board", "board:float", "canvas", `${pane("board:float")} canvas`),
  cornerResize("chart beside a table resize", "beside", "beside:float", "canvas", `${pane("beside:float")} canvas`),
  cornerResize("chart under a toolbar resize", "overlay", "overlay:float", "canvas", `${pane("overlay:float")} canvas`),
  // A static chart under a table that grows into what the chart leaves, as the volatility board draws its index history.
  cornerResize("chart under a table resize", "under", "under:float", "canvas", `${pane("under:float")} canvas`),
  {
    // The divider between the docked G layout and the chart beside a table:
    // the G chart's canvas keeps to its pane's moving right edge.
    name: "dock divider beside a G layout",
    fixture: "nested",
    grab: (cdp) => evaluate(cdp, NESTED_DIVIDER),
    path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 240, y: start.y }),
    track: { frame: rightOf(pane("chart-bar:dock")), content: rightOf(`${pane("chart-bar:dock")} canvas`) },
    canvas: `${pane("chart-bar:dock")} canvas`,
  },
  {
    // The same divider from the other side: the chart beside a table keeps to its pane's right edge.
    name: "dock divider beside a chart beside a table",
    fixture: "nested",
    grab: (cdp) => evaluate(cdp, NESTED_DIVIDER),
    path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 240, y: start.y }),
    track: {
      frame: `document.querySelector("${pane("beside:dock")}").getBoundingClientRect().left`,
      content: rightOf(`${pane("beside:dock")} canvas`),
      anchor: rightOf(pane("beside:dock")),
    },
    canvas: `${pane("beside:dock")} canvas`,
  },
  {
    // A chart composer's plot dragged back and forth over its loaded bars:
    // each move pans the view, which re-projects and redraws every series in
    // it, with the crosshair reading out all six of them.
    name: "chart composer pan",
    fixture: "cmp&chart=readout",
    ready: `document.querySelectorAll("${pane("chart-composer:a")} [data-gloom-role=composite-chart-legend-series]").length === 6 && !!document.querySelector("${pane("chart-composer:a")} canvas")`,
    grab: (cdp) => evaluate(cdp, middleOf(`${pane("chart-composer:a")} [data-gloom-role=composite-chart-panel]`)),
    path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 300, y: start.y }),
  },
  chatDividerDrag("chat divider drag", "chat"),
  // A reader who paged far back: every page stays in the list.
  chatDividerDrag("chat divider drag, 500 messages", "chat&count=500&latency=0", loadWholeChat),
  desDividerDrag("DES divider drag", "des"),
  // Three times the accounts and the description.
  desDividerDrag("DES divider drag, 3x", "des&positions=9&scale=3"),
  {
    name: "table column drag",
    fixture: "resize",
    // The divider of the table in the sidebar pane: its grab strip straddles
    // the sidebar's right edge. Pressed just inside it, where a base branch
    // whose strip lies under the table beside it takes the press too.
    grab: (cdp) => evaluate(cdp, `(() => { const r = document.querySelector("${pane("sidebar:dock")} [data-gloom-role=pane-sidebar]").getBoundingClientRect(); return { x: r.right - 1, y: r.top + r.height / 2 }; })()`),
    path: (start, t) => ({ x: start.x + Math.sin(t * Math.PI * 2) * 110, y: start.y }),
    track: {
      frame: rightOf(`${pane("sidebar:dock")} [data-gloom-role=pane-sidebar]`),
      content: rightOf(`${pane("sidebar:dock")} [data-gloom-role=pane-sidebar] [data-gloom-role=data-table]`),
    },
  },
];

async function metrics(cdp: Cdp): Promise<Record<string, number>> {
  const { metrics: list } = await cdp.send<{ metrics: Array<{ name: string; value: number }> }>("Performance.getMetrics");
  return Object.fromEntries(list.map((metric) => [metric.name, metric.value]));
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

async function measureDrag(cdp: Cdp, page: FixturePage, scenario: Scenario): Promise<DragSample> {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: new URL(`?scenario=${scenario.fixture}`, page.url).href });
  await loaded;
  if (!await waitFor(cdp, "window.__paneChrome?.ready === true", 15_000)) throw new Error(`the ${scenario.fixture} fixture did not render`);
  if (scenario.ready && !await waitFor(cdp, scenario.ready, 15_000)) throw new Error(`the ${scenario.name} content did not load`);
  await frames(cdp, 10);
  await scenario.prepare?.(cdp);
  const start = await scenario.grab(cdp);
  await mouse(cdp, "mouseMoved", start.x, start.y, false);
  await mouse(cdp, "mousePressed", start.x, start.y, true);
  // Each frame notes where the pointer was when it began, and once the frame
  // has drawn (a task after it), where the tracked edges ended up.
  await evaluate(cdp, `(() => {
    window.__frameTimes = [];
    window.__lag = [];
    window.__stretch = [];
    window.__commits = 0;
    const stretch = ${scenario.canvas ? `() => ${stretchOf(scenario.canvas)}` : "null"};
    const track = ${scenario.track ? `{ frame: () => ${scenario.track.frame}, content: () => ${scenario.track.content}, anchor: ${scenario.track.anchor ? `() => ${scenario.track.anchor}` : "null"} }` : "null"};
    const origin = track && { frame: track.frame() - ${start.x}, content: track.content() - (track.anchor ? track.anchor() : ${start.x}) };
    let last = performance.now();
    window.__recording = true;
    const tick = (now) => {
      window.__frameTimes.push(now - last);
      last = now;
      if (track) {
        const pointer = window.__pointerX;
        setTimeout(() => {
          if (!window.__recording) return;
          const anchor = track.anchor ? track.anchor() : pointer;
          window.__lag.push([Math.abs(track.frame() - pointer - origin.frame), Math.abs(track.content() - anchor - origin.content)]);
          if (stretch) window.__stretch.push(stretch());
        }, 0);
      }
      if (window.__recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  const before = await metrics(cdp);
  const began = performance.now();
  for (let move = 1; ; move += 1) {
    const t = (performance.now() - began) / DRAG_MS;
    if (t >= 1) break;
    const at = scenario.path(start, t);
    await mouse(cdp, "mouseMoved", at.x, at.y, true);
    const wait = began + move * FRAME_MS - performance.now();
    if (wait > 0) await sleep(wait);
  }
  const after = await metrics(cdp);
  const elapsed = performance.now() - began;
  const recorded = await evaluate<{ frameTimes: number[]; commits: number; lag: Array<[number, number]>; stretch: number[] }>(cdp, "(() => { window.__recording = false; return { frameTimes: window.__frameTimes.slice(1), commits: window.__commits, lag: window.__lag.slice(1), stretch: window.__stretch.slice(1) }; })()");
  // The pointer comes to rest where the drag ends, and lets go there.
  const end = scenario.path(start, 1);
  await mouse(cdp, "mouseMoved", end.x, end.y, true);
  await frames(cdp, 2);
  const edges = scenario.track ? `[${scenario.track.frame}, ${scenario.track.content}]` : "[0, 0]";
  const held = await evaluate<[number, number]>(cdp, edges);
  await mouse(cdp, "mouseReleased", end.x, end.y, false);
  await frames(cdp, 3);
  const released = await evaluate<[number, number]>(cdp, edges);
  // At rest: what renders a frame or two after the release has.
  const restStretch = scenario.canvas ? (await frames(cdp, 6), await evaluate<number>(cdp, stretchOf(scenario.canvas))) : 0;
  const drawn = Math.max(1, recorded.frameTimes.length);
  const ms = (name: string) => (after[name]! - before[name]!) * 1000;
  return {
    mainMsPerFrame: ms("TaskDuration") / drawn,
    scriptMsPerFrame: ms("ScriptDuration") / drawn,
    styleLayoutMsPerFrame: (ms("RecalcStyleDuration") + ms("LayoutDuration")) / drawn,
    commits: recorded.commits,
    frames: recorded.frameTimes.length,
    fps: recorded.frameTimes.length / (elapsed / 1000),
    p95FrameMs: percentile(recorded.frameTimes, 0.95),
    missedFrames: recorded.frameTimes.reduce((missed, time) => missed + Math.max(0, Math.round(time / FRAME_MS) - 1), 0),
    longIntervals: recorded.frameTimes.filter((time) => time > 1.5 * FRAME_MS).length,
    ...(scenario.track ? {
      frameLagPx: percentile(recorded.lag.map(([frame]) => frame), 0.95),
      contentLagPx: percentile(recorded.lag.map(([, content]) => content), 0.95),
      releaseJumpPx: Math.abs(released[0] - held[0]),
      contentReleaseJumpPx: Math.abs(released[1] - held[1]),
    } : {}),
    ...(scenario.canvas ? {
      bitmapStretchPct: percentile(recorded.stretch, 0.95),
      restStretchPct: restStretch,
    } : {}),
  };
}

async function runSide(page: FixturePage, label: string, scenarios: Scenario[]): Promise<Record<string, DragSample>> {
  const browser = await launchBrowser(`budget-${label}`, VIEWPORT.width, VIEWPORT.height);
  try {
    await browser.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_PROBES });
    await browser.cdp.send("Performance.enable", { timeDomain: "threadTicks" });
    const samples: Record<string, DragSample> = {};
    for (const scenario of scenarios) {
      try {
        samples[scenario.name] = await measureDrag(browser.cdp, page, scenario);
      } catch (error) {
        // Say which side: a base measured with its own fixture may lack a layout this one has.
        throw new Error(`${label}, ${scenario.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return samples;
  } finally {
    await browser.close();
  }
}

const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const baseRoot = takeOption(args, "--base");
  if (!baseRoot) throw new Error("Usage: frame-budget.ts --base <checkout> [--runs 5] [--head <checkout>] [--only <text>]");
  const runs = positiveInteger(takeOption(args, "--runs"), 5, "--runs");
  const only = takeOption(args, "--only");
  const scenarios = SCENARIOS.filter((scenario) => !only || scenario.name.includes(only));
  if (scenarios.length === 0) throw new Error(`No scenario matches "${only}"`);
  const sides = {
    // A base without the source this PR's fixture imports is measured with its own fixture.
    base: await serveFixturePage(resolve(baseRoot), cacheDir("build", `budget-base-${process.pid}`), { ownFixtureFallback: true }),
    head: await serveFixturePage(resolve(takeOption(args, "--head") ?? join(import.meta.dir, "../..")), cacheDir("build", `budget-head-${process.pid}`)),
  };
  const samples: Record<keyof typeof sides, Array<Record<string, DragSample>>> = { base: [], head: [] };
  let verdict: { lines: string[]; problems: string[] };
  try {
    // A result over budget is measured again, on twice the runs, before it
    // fails: one slow stretch of a shared runner should not fail a PR.
    for (let attempt = 1; ; attempt += 1) {
      for (let run = 1; run <= runs; run += 1) {
        for (const side of ["base", "head"] as const) {
          const result = await runSide(sides[side], side, scenarios);
          samples[side].push(result);
          console.error(`${side} ${samples[side].length}: ${Object.entries(result).map(([name, sample]) => `${name} ${round(sample.mainMsPerFrame)} ms/frame, ${sample.commits} commits${sample.frameLagPx !== undefined ? `, ${round(sample.frameLagPx, 1)} px behind` : ""}`).join("; ")}`);
        }
      }
      verdict = judge(scenarios, samples, sides.base.ownFixture);
      if (verdict.problems.length === 0 || attempt === 2) break;
      console.error("Over budget; measuring again.");
    }
  } finally {
    await sides.base.close();
    await sides.head.close();
  }

  const markdown = `${verdict.lines.join("\n")}\n`;
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  if (verdict.problems.length > 0) process.exitCode = 1;
}

function judge(scenarios: Scenario[], samples: Record<"base" | "head", Array<Record<string, DragSample>>>, baseOwnFixture: boolean): { lines: string[]; problems: string[] } {
  const runs = samples.head.length;
  const lines = [
    "### Pane drag and resize frame budget",
    "",
    `Middle value of ${runs} alternating runs per side, ${DRAG_MS / 1000} s drags at 60 moves a second, headless Chrome without a GPU. Frames are animation frames, not GPU-presented frames; missed frames are estimated against a 60 Hz display. Behind the pointer: how far the dragged edge of the frame, and of the content in it, was from where the pointer had it, in px (95th percentile). Jump on release: how far the frame's and the content's edge moved when the pointer let go where it rested.`,
    "",
    ...(baseOwnFixture ? ["Main was measured with its own fixture: this PR changed the fixture, and the new one needs source main does not have. The stand-in panes may differ between the two columns.", ""] : []),
    `| | main${baseOwnFixture ? " (own fixture)" : ""} | this PR |`,
    "|---|---|---|",
  ];
  const problems: string[] = [];
  const notes: string[] = [];
  for (const { name, track, canvas } of scenarios) {
    const pick = (side: "base" | "head", key: keyof DragSample) => median(samples[side].map((sample) => sample[name]![key] ?? 0));
    const row = (label: string, key: keyof DragSample, unit = "") => {
      lines.push(`| ${name}: ${label} | ${round(pick("base", key))}${unit} | ${round(pick("head", key))}${unit} |`);
    };
    row("main thread per frame", "mainMsPerFrame", " ms");
    row("script per frame", "scriptMsPerFrame", " ms");
    row("style and layout per frame", "styleLayoutMsPerFrame", " ms");
    row("React commits", "commits");
    row("frames per second", "fps");
    row("frame time p95", "p95FrameMs", " ms");
    row("missed frames (est., 60 Hz)", "missedFrames");
    row("intervals over 1.5 frames", "longIntervals");
    if (track) {
      row("frame behind the pointer", "frameLagPx", " px");
      row("content behind the pointer", "contentLagPx", " px");
      row("frame jump on release", "releaseJumpPx", " px");
      row("content jump on release", "contentReleaseJumpPx", " px");
    }
    if (canvas) {
      row("chart bitmap scaled by CSS (p95)", "bitmapStretchPct", "%");
      row("chart bitmap scaled at rest", "restStretchPct", "%");
      const restStretch = pick("head", "restStretchPct");
      if (restStretch > MAX_REST_STRETCH_PCT) {
        problems.push(`${name}: at rest the chart's bitmap is scaled ${round(restStretch, 2)}% by CSS, so it is not drawn sharp (limit: ${MAX_REST_STRETCH_PCT}%).`);
      }
    }
    const frameLag = { base: pick("base", "frameLagPx"), head: pick("head", "frameLagPx") };
    if (track && frameLag.head > MAX_FRAME_LAG_PX) {
      problems.push(`${name}: the frame fell ${round(frameLag.head, 1)} px behind the pointer (limit: ${MAX_FRAME_LAG_PX} px).`);
    }
    const contentLag = pick("head", "contentLagPx");
    if (track && contentLag > MAX_FRAME_LAG_PX) {
      problems.push(`${name}: the content fell ${round(contentLag, 1)} px behind the pointer (limit: ${MAX_FRAME_LAG_PX} px).`);
    }
    for (const [what, key] of [["frame", "releaseJumpPx"], ["content", "contentReleaseJumpPx"]] as const) {
      const releaseJump = pick("head", key);
      if (track && releaseJump > MAX_RELEASE_JUMP_PX) {
        problems.push(`${name}: the ${what} jumped ${round(releaseJump, 1)} px when the pointer let go (limit: ${MAX_RELEASE_JUMP_PX} px).`);
      }
    }
    // A main branch whose frame did not follow the pointer did less work by
    // not resizing anything as it went, so its time and commits are no
    // budget for one that does.
    if (track && frameLag.base > MAX_FRAME_LAG_PX) {
      notes.push(`${name}: main does not follow the pointer (${round(frameLag.base, 1)} px behind), so its main thread time and commits set no budget.`);
      continue;
    }
    const frame = { base: pick("base", "mainMsPerFrame"), head: pick("head", "mainMsPerFrame") };
    if (frame.head > frame.base * MAX_FRAME_RATIO && frame.head - frame.base >= MIN_FRAME_DELTA_MS) {
      problems.push(`${name}: main thread per frame went from ${round(frame.base)} to ${round(frame.head)} ms (limit: +${Math.round((MAX_FRAME_RATIO - 1) * 100)}% and +${MIN_FRAME_DELTA_MS} ms).`);
    }
    const commits = { base: pick("base", "commits"), head: pick("head", "commits") };
    if (commits.head > commits.base * MAX_COMMIT_RATIO && commits.head - commits.base >= MIN_COMMIT_DELTA) {
      problems.push(`${name}: React commits went from ${commits.base} to ${commits.head} (limit: +${Math.round((MAX_COMMIT_RATIO - 1) * 100)}% and +${MIN_COMMIT_DELTA}).`);
    }
  }
  if (notes.length > 0) lines.push("", ...notes.map((note) => `- ${note}`));
  lines.push("", problems.length > 0 ? `**Over budget:**\n\n${problems.map((problem) => `- ${problem}`).join("\n")}` : "Every drag and resize is within the budget.");
  return { lines, problems };
}

await main();
