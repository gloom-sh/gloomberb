import { appendFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { positiveInteger, takeOption } from "../tui-benchmark-harness";
import { cacheDir, click, drag, evaluate, frames, holdKey, launchBrowser, mouse, pressKey, sleep, waitFor, type Cdp, type Chord, type Point } from "./browser";
import { serveFixturePage, type FixturePage } from "./page";
import { chatSteps } from "./chat-checks";
import { axisSteps } from "./axis-checks";
import { desSteps } from "./des-checks";
import { heatSteps } from "./heat-checks";
import { headerSteps } from "./header-checks";
import { layoutSteps } from "./layout-checks";
import { selectionSteps } from "./selection-checks";
import { checkFirstPaint, checkThemePreview } from "./paint";

/**
 * Moves panes the way a person does: real pointer input (DevTools
 * Input.dispatchMouseEvent) on the desktop pane chrome in headless Chrome,
 * checking where each pane ends up rather than which handler ran. The pane
 * header has broken this way before: v0.16.1 shipped panes that only moved
 * from the grip and the title (#1478). Held keys are real too: the key goes
 * down and then repeats with `autoRepeat`, as a keyboard sends it (GLO-591).
 *
 *   bun run check:pane-chrome [--only <text>] [--repeat <n>] [--root <checkout>]
 *
 * `--root` builds the fixture from another checkout's sources, to show a check
 * fails on a known-broken commit. A failure saves a screenshot under the cache
 * folder (`PANE_CHROME_CACHE`, default ~/.cache/gloomberb-pane-chrome).
 */

const VIEWPORT = { width: 1400, height: 900 };

interface Rect { x: number; y: number; width: number; height: number }

interface Step {
  name: string;
  /** The fixture layout the step starts from (fixture.tsx). */
  scenario: string;
  run(cdp: Cdp): Promise<void>;
}

/**
 * `PANE_CHROME_NOW=2026-07-08T14:30:00Z` runs every page with its clock set to
 * that instant (still ticking), to rerun a check as it would run at another
 * time of day. Only the page's `Date` moves: timers and frames keep real time.
 */
function pageClock(now: string | undefined): string {
  if (!now) return "";
  const instant = Date.parse(now);
  if (Number.isNaN(instant)) throw new Error(`PANE_CHROME_NOW is not a date: ${now}`);
  return `
(() => {
  const offset = ${instant} - Date.now();
  window.Date = new Proxy(Date, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [target.now() + offset], newTarget),
    get: (target, key) => (key === "now" ? () => target.now() + offset : Reflect.get(target, key)),
  });
})();`;
}

/** Page helpers, installed in every document before the app runs. */
const PAGE_HELPERS = `
// React commits, through the DevTools hook React looks for when it loads.
window.__commits = 0;
window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true, isDisabled: false, renderers: new Map(),
  inject() { return 1; },
  onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
  onCommitFiberRoot() { window.__commits += 1; },
};
window.__check = {
  pane(id) {
    return document.querySelector('[data-gloom-role=pane-window][data-gloom-pane-id="' + id + '"], [data-gloom-role=detached-pane-window][data-gloom-pane-id="' + id + '"]');
  },
  rect(element) {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  },
  paneRect(id) { return this.rect(this.pane(id)); },
  part(id, role) { return this.pane(id)?.querySelector('[data-gloom-role=' + role + ']') ?? null; },
  tab(id, label) {
    return [...(this.pane(id)?.querySelectorAll('[role=tab]') ?? [])].find((tab) => tab.textContent.trim() === label) ?? null;
  },
  tabs(id) { return [...(this.pane(id)?.querySelectorAll('[role=tab]') ?? [])].map((tab) => tab.textContent.trim()); },
  /** Where a press lands on a pane's header; null when that part is missing. */
  point(id, part) {
    if (part === "empty") return this.emptyBarPoint(id);
    const element = part === "resize" ? this.part(id, "resize-handle")
      : part === "action" || part === "help" || part === "ask" ? this.part(id, "pane-" + part)?.querySelector("button")
      : this.part(id, "pane-" + part);
    const r = this.rect(element);
    return r && { x: r.x + Math.min(r.width / 2, 16), y: r.y + r.height / 2 };
  },
  /**
   * Bare header bar: just left of the header's buttons (Ask Gloom, the docs ?,
   * then the pane menu), where no title, tab or button is. Throws when
   * something else is under that point, so a layout change fails loudly
   * instead of testing the wrong spot.
   */
  emptyBarPoint(id) {
    const header = this.part(id, "pane-header");
    const action = this.part(id, "pane-ask") ?? this.part(id, "pane-help") ?? this.part(id, "pane-action");
    if (!header || !action) return null;
    const h = header.getBoundingClientRect();
    const point = { x: action.getBoundingClientRect().left - 10, y: h.top + h.height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    const taken = hit?.closest('button, [role=tab], [data-gloom-role=pane-header-tabs], [data-gloom-role=pane-title], [data-gloom-role=pane-grip], [data-gloom-interactive=true]');
    if (!hit || !header.contains(hit) || taken) {
      throw new Error("no bare header bar left of the pane menu: " + (taken ?? hit)?.outerHTML?.slice(0, 120));
    }
    return point;
  },
  /**
   * The header's parts left to right, in px: the title, then Ask Gloom, the ?,
   * the menu and the close button when drawn. Null for a part it has none of.
   */
  headerParts(id) {
    const header = this.rect(this.part(id, "pane-header"));
    const title = this.rect(this.part(id, "pane-title"));
    const button = (role) => this.rect(this.part(id, role)?.querySelector("button") ?? null);
    return { header, title, ask: button("pane-ask"), help: button("pane-help"), action: button("pane-action"), close: button("pane-close") };
  },
  windowMoves() { return window.__paneChromeBridge.filter((message) => message.id === "startWindowMove" && message.payload?.id === 7).length; },
};
`;

function fail(message: string, detail?: unknown): never {
  throw new Error(detail === undefined ? message : `${message}: ${JSON.stringify(detail)}`);
}

const rectOf = (cdp: Cdp, paneId: string) => evaluate<Rect | null>(cdp, `__check.paneRect(${JSON.stringify(paneId)})`);

async function pointOf(cdp: Cdp, paneId: string, part: string): Promise<Point> {
  const point = await evaluate<Point | null>(cdp, `__check.point(${JSON.stringify(paneId)}, ${JSON.stringify(part)})`);
  return point ?? fail(`${paneId} has no ${part}`);
}

const center = (rect: Rect): Point => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const near = (a: Rect | null, b: Rect | null, tolerance = 2) => !!a && !!b
  && Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
  && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
const round = (rect: Rect | null) => rect && Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value)]));

/**
 * Drags `paneId` by `part` onto the middle of `targetId`, which swaps two
 * docked panes, and checks they really traded places.
 */
async function dockSwap(cdp: Cdp, paneId: string, part: string, targetId: string): Promise<void> {
  const before = { pane: await rectOf(cdp, paneId), target: await rectOf(cdp, targetId) };
  if (!before.pane || !before.target) fail("pane missing", before);
  await drag(cdp, await pointOf(cdp, paneId, part), [center(before.target)]);
  const swapped = `(() => { const pane = __check.paneRect(${JSON.stringify(paneId)}); const target = __check.paneRect(${JSON.stringify(targetId)}); return pane && target && Math.abs(pane.x - ${before.target.x}) <= 2 && Math.abs(pane.y - ${before.target.y}) <= 2 && Math.abs(target.x - ${before.pane.x}) <= 2 && Math.abs(target.y - ${before.pane.y}) <= 2; })()`;
  if (await waitFor(cdp, swapped)) return;
  const after = { pane: await rectOf(cdp, paneId), target: await rectOf(cdp, targetId) };
  fail(`dropping ${paneId} on ${targetId} did not swap them`, { before: { pane: round(before.pane), target: round(before.target) }, after: { pane: round(after.pane), target: round(after.target) } });
}

/** Drags a floating pane by `part` and checks it moved by the pointer's offset and still floats. */
async function floatMove(cdp: Cdp, part: string, label: string): Promise<void> {
  const paneId = "plain:float";
  const before = await rectOf(cdp, paneId) ?? fail("no floating pane");
  const from = await pointOf(cdp, paneId, part);
  const offset = { x: -240, y: -150 };
  await drag(cdp, from, [{ x: from.x + offset.x, y: from.y + offset.y }]);
  // Floating panes sit on whole cells, so the move rounds to one.
  const cell = await evaluate<{ width: number; height: number }>(cdp, "window.__paneChrome.cell");
  const moved = `(() => { const r = __check.paneRect("${paneId}"); return r && __check.pane("${paneId}").getAttribute("data-floating") === "true" && Math.abs(r.x - ${before.x + offset.x}) <= ${cell.width + 1} && Math.abs(r.y - ${before.y + offset.y}) <= ${cell.height + 1} && Math.abs(r.width - ${before.width}) <= 2; })()`;
  if (await waitFor(cdp, moved)) return;
  fail(`dragging by the ${label} did not move the floating pane by (${offset.x}, ${offset.y})`, { before: round(before), after: round(await rectOf(cdp, paneId)) });
}

/** Presses the fullscreen pane's bar at `part` and drags: the desktop window moves, the pane stays. */
async function fullscreenBar(cdp: Cdp, part: string, label: string): Promise<void> {
  const paneId = "plain:a";
  await evaluate(cdp, `window.__paneChrome.registry.togglePaneFullscreen("${paneId}")`);
  const full = await waitFor<Rect | null>(cdp, `(() => { const r = __check.paneRect("${paneId}"); return r && r.width > ${VIEWPORT.width - 40} ? r : null; })()`)
    ?? fail("pane did not go fullscreen", round(await rectOf(cdp, paneId)));
  const from = await pointOf(cdp, paneId, part);
  await drag(cdp, from, [{ x: from.x + 160, y: from.y + 120 }], 6);
  const moves = await evaluate<number>(cdp, "__check.windowMoves()");
  const after = await rectOf(cdp, paneId);
  if (moves < 1) fail(`pressing the fullscreen bar's ${label} did not ask the window to move`);
  if (!near(full, after)) fail("the fullscreen pane moved", { full: round(full), after: round(after) });
}

/** In a popped-out window, pressing the title bar at `part` and dragging moves the window. */
async function titleBarMovesWindow(cdp: Cdp, part: string, label: string): Promise<void> {
  const from = await pointOf(cdp, "tabs:a", part);
  await drag(cdp, from, [{ x: from.x + 120, y: from.y + 60 }], 6);
  if (await evaluate<number>(cdp, "__check.windowMoves()") < 1) fail(`pressing the title bar's ${label} did not ask the window to move`);
}

/**
 * Presses at `from` and moves to `to` in `steps` moves with a frame after
 * each, then runs `check` with the pointer still held, and releases at `to`:
 * what a resize shows while it is under way, not only where it lands.
 */
async function dragHolding(cdp: Cdp, from: Point, to: Point, check: () => Promise<void>, steps = 12): Promise<void> {
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  await frames(cdp);
  try {
    for (let step = 1; step <= steps; step += 1) {
      await mouse(cdp, "mouseMoved", from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps, true);
      await frames(cdp);
    }
    await frames(cdp, 2);
    await check();
  } finally {
    await mouse(cdp, "mouseReleased", to.x, to.y, false);
    await frames(cdp, 2);
  }
}

/**
 * Moves the pointer from `from` to `to` within a frame or two, well inside
 * the interval at which a resize's content catches up, and checks, with the
 * pointer still down, that what `content` selects in `paneId` keeps its gaps
 * to the pane's right and bottom edges within a cell: drawn on the cell grid
 * or not, it follows the frame between catch-ups, with no blank strip or
 * cut-off edge.
 */
async function contentFollowsFrame(cdp: Cdp, paneId: string, content: string, from: Point, to: Point): Promise<void> {
  const gaps = `(() => {
    const pane = __check.paneRect(${JSON.stringify(paneId)});
    const inner = __check.rect(__check.pane(${JSON.stringify(paneId)})?.querySelector(${JSON.stringify(content)}));
    return pane && inner && { right: pane.x + pane.width - inner.x - inner.width, bottom: pane.y + pane.height - inner.y - inner.height };
  })()`;
  const before = await evaluate<{ right: number; bottom: number } | null>(cdp, gaps) ?? fail(`${paneId} has no ${content}`);
  const cell = await evaluate<{ width: number; height: number }>(cdp, "window.__paneChrome.cell");
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  await frames(cdp);
  try {
    // Past the drag threshold, then the rest of the way; the page applies both in one frame.
    await mouse(cdp, "mouseMoved", from.x + Math.sign(to.x - from.x) * 6, from.y + Math.sign(to.y - from.y) * 6, true);
    await mouse(cdp, "mouseMoved", to.x, to.y, true);
    await frames(cdp, 2);
    const during = await evaluate<{ right: number; bottom: number } | null>(cdp, gaps);
    if (!during || Math.abs(during.right - before.right) > cell.width || Math.abs(during.bottom - before.bottom) > cell.height) {
      fail(`mid-drag, ${content} did not follow ${paneId}'s frame`, { before, during });
    }
  } finally {
    await mouse(cdp, "mouseReleased", to.x, to.y, false);
    await frames(cdp, 2);
  }
}

/** The x of the vertical divider between the first two panes of the top row, half way down `leftId`. */
async function topDivider(cdp: Cdp, leftId: string, atY?: number): Promise<Point> {
  const left = await rectOf(cdp, leftId) ?? fail(`${leftId} missing`);
  const y = atY ?? left.y + left.height / 2;
  return await evaluate<Point | null>(cdp, `(() => {
    const edge = ${left.x + left.width};
    const divider = [...document.querySelectorAll("[data-gloom-role=dock-divider]")].map((element) => element.getBoundingClientRect())
      .find((r) => r.height > r.width && Math.abs(r.x + r.width / 2 - edge) <= 6 && r.top < ${y} && r.bottom > ${y});
    return divider ? { x: divider.x + divider.width / 2, y: ${y} } : null;
  })()`) ?? fail(`no divider right of ${leftId}`);
}

interface HeaderParts { header: Rect | null; title: Rect | null; ask: Rect | null; help: Rect | null; action: Rect | null; close: Rect | null }

const headerParts = (cdp: Cdp, paneId: string) => evaluate<HeaderParts>(cdp, `__check.headerParts(${JSON.stringify(paneId)})`);

/**
 * The header's buttons sit in a row inside it, none over another or over the
 * title: Ask Gloom left of the ?, the ? left of the menu, the menu left of the
 * close button. A shift here is what pushes a neighbour out of place.
 */
function checkHeaderRow(paneId: string, parts: HeaderParts): void {
  const { header, title } = parts;
  if (!header || !title) fail(`${paneId} has no header or title`, parts);
  const row = [parts.ask, parts.help, parts.action, parts.close].filter((rect): rect is Rect => !!rect);
  let left = title.x + title.width;
  for (const rect of row) {
    if (rect.x < left - 0.5) fail(`${paneId}: a header button overlaps the part before it`, parts);
    if (rect.y < header.y - 0.5 || rect.y + rect.height > header.y + header.height + 0.5) fail(`${paneId}: a header button leaves the header`, parts);
    left = rect.x + rect.width;
  }
  if (left > header.x + header.width + 0.5) fail(`${paneId}: the header's buttons run past its edge`, parts);
}

/** Where a chart's view and its loaded bars start and end (epoch ms), from the chart's own attributes. */
interface ChartWindow { viewStart: number; viewEnd: number; dataStart: number; dataEnd: number }

async function chartWindow(cdp: Cdp): Promise<ChartWindow> {
  const window = await evaluate<ChartWindow | null>(cdp, `(() => {
    const chart = document.querySelector("[data-gloom-role=composite-chart]");
    const view = chart?.dataset.gloomView?.split(":").map(Number);
    const data = chart?.dataset.gloomData?.split(":").map(Number);
    return view && data ? { viewStart: view[0], viewEnd: view[1], dataStart: data[0], dataEnd: data[1] } : null;
  })()`);
  return window ?? fail("the chart reports no view");
}

const day = (time: number) => new Date(time).toISOString().slice(0, 16);

/** Waits for the chart composer to draw its bars (they arrive after a short delay) and returns its plot. */
async function loadedChartPlot(cdp: Cdp): Promise<Rect> {
  if (!await waitFor(cdp, `!!document.querySelector("[data-gloom-role=composite-chart]")?.dataset.gloomView && !!document.querySelector("[data-gloom-role=composite-chart-panel] canvas")`, 10_000)) {
    fail("the chart did not load its bars");
  }
  return await evaluate<Rect | null>(cdp, `__check.rect(document.querySelector("[data-gloom-role=composite-chart-panel]"))`) ?? fail("no chart plot");
}

/**
 * Drags a chart composer's plot from left to right, which pans back in time,
 * `drags` times with a pause between for its loads, and checks every frame
 * that the view only moves back and keeps its span: a pan that ran into the
 * end of the loaded bars, or whose bars arrived mid-gesture, used to jump the
 * view forward or squeeze it shut. The one move forward allowed is a view
 * past the oldest bar settling onto it. Returns the view after each drag.
 */
async function panChartBack(cdp: Cdp, drags: number): Promise<ChartWindow[]> {
  const plot = await loadedChartPlot(cdp);
  const first = await chartWindow(cdp);
  const span = first.viewEnd - first.viewStart;
  const after: ChartWindow[] = [];
  let previous = first;
  for (let drag = 0; drag < drags; drag += 1) {
    const from = { x: plot.x + plot.width * 0.1, y: plot.y + plot.height * 0.5 };
    await mouse(cdp, "mouseMoved", from.x, from.y, false);
    await mouse(cdp, "mousePressed", from.x, from.y, true);
    try {
      for (let step = 1; step <= 24; step += 1) {
        await mouse(cdp, "mouseMoved", from.x + (plot.width * 0.75 * step) / 24, from.y, true);
        await frames(cdp);
        const now = await chartWindow(cdp);
        const settling = previous.viewStart < now.dataStart && now.viewStart <= now.dataStart;
        if (now.viewEnd > previous.viewEnd + 60_000 && !settling) {
          fail(`drag ${drag + 1}: the view jumped forward`, { from: day(previous.viewEnd), to: day(now.viewEnd) });
        }
        // Calendar days per view drift with weekends and holidays, never by much.
        const ratio = (now.viewEnd - now.viewStart) / span;
        if (ratio < 0.8 || ratio > 1.25) fail(`drag ${drag + 1}: the view's span changed by ${Math.round((ratio - 1) * 100)}%`, { start: day(now.viewStart), end: day(now.viewEnd) });
        previous = now;
      }
    } finally {
      await mouse(cdp, "mouseReleased", from.x + plot.width * 0.75, from.y, false);
    }
    await evaluate(cdp, "new Promise((done) => setTimeout(done, 900))");
    after.push(await chartWindow(cdp));
  }
  return after;
}

/** Where a button of the chart composer's range strip sits, by its label. */
async function rangeButton(cdp: Cdp, label: string): Promise<Point> {
  const rect = await evaluate<Rect | null>(cdp, `__check.rect([...document.querySelectorAll(".gloom-qb-inline[data-item-id=range] button[role=radio]")]
    .find((button) => button.textContent.trim() === ${JSON.stringify(label)}))`);
  return center(rect ?? fail(`the range strip has no ${label}`));
}

/** The range the strip marks as selected. */
const selectedRange = (cdp: Cdp) => evaluate<string | null>(cdp, `document.querySelector(".gloom-qb-inline[data-item-id=range] button[data-active=true]")?.textContent.trim() ?? null`);

const sameWindow = (a: ChartWindow, b: ChartWindow, tolerance = 60_000) => Math.abs(a.viewStart - b.viewStart) <= tolerance
  && Math.abs(a.viewEnd - b.viewEnd) <= tolerance && a.dataStart === b.dataStart && a.dataEnd === b.dataEnd;

const PRESS_POINTS = [["grip", "grip"], ["title", "title"], ["empty bar", "empty"]] as const;
const EDGES = [
  { edge: "left", by: { x: -64, y: 0 }, moves: { x: 1, y: 0 }, grows: { x: -1, y: 0 } },
  { edge: "right", by: { x: 64, y: 0 }, moves: { x: 0, y: 0 }, grows: { x: 1, y: 0 } },
  { edge: "bottom", by: { x: 0, y: 36 }, moves: { x: 0, y: 0 }, grows: { x: 0, y: 1 } },
  { edge: "top-left", by: { x: -64, y: -36 }, moves: { x: 1, y: 1 }, grows: { x: -1, y: -1 } },
] as const;
const CAPTION_BUTTONS = [["minimize", "minimize"], ["maximize", "toggle-maximize"], ["close", "close"]] as const;

const PANE_COUNT = `document.querySelectorAll("[data-gloom-role=pane-window]").length`;
// Modifiers as DevTools numbers them: Meta 4, Shift 8.
const COPY_SCREENSHOT: Chord = { key: "C", code: "KeyC", keyCode: 67, modifiers: 4 | 8 };
const ASK_GLOOM: Chord = { key: "A", code: "KeyA", keyCode: 65, modifiers: 4 | 8 };
const CLOSE_PANE: Chord = { key: "w", code: "KeyW", keyCode: 87, modifiers: 4 };
const ARROW_DOWN: Chord = { key: "ArrowDown", code: "ArrowDown", keyCode: 40, modifiers: 0 };
const HELD_MS = 1_500;
/** Longer than the action's cooldown, so the next press is a separate one. */
const KEY_UP_FOR_MS = 800;

/**
 * Moves the pointer over a pane's chart plot and waits for the crosshair to
 * sit under it: the horizontal line at the pointer, the vertical one on the
 * nearest observation.
 */
async function crosshairUnder(cdp: Cdp, paneId: string, at: Point): Promise<void> {
  await mouse(cdp, "mouseMoved", at.x, at.y, false);
  const crosshair = `(() => {
    const pane = __check.pane(${JSON.stringify(paneId)});
    const x = pane?.querySelector("[data-gloom-role=chart-crosshair-x]")?.getBoundingClientRect();
    const y = pane?.querySelector("[data-gloom-role=chart-crosshair-y]")?.getBoundingClientRect();
    return x && y ? { x: Math.round(x.x + x.width / 2), y: Math.round(y.y + y.height / 2) } : null;
  })()`;
  const under = `(() => { const lines = ${crosshair}; return lines && Math.abs(lines.x - ${at.x}) <= 4 && Math.abs(lines.y - ${at.y}) <= 2; })()`;
  if (!await waitFor(cdp, under)) {
    fail(`the crosshair in ${paneId} is not under the pointer`, { pointer: { x: Math.round(at.x), y: Math.round(at.y) }, crosshair: await evaluate(cdp, crosshair) });
  }
}

/**
 * Text drawn over a chart's plot other than its drawing toolbar and the
 * screenshot watermark: a floating readout, by whatever role it comes back
 * under. The crosshair reads out in the legend and on the axes, never in a box.
 */
const FLOATING_PLOT_TEXT = (scope: string) => `(() => {
  const plots = [...(${scope})?.querySelectorAll("[data-gloom-role=composite-chart-panel]") ?? []].map((plot) => plot.getBoundingClientRect());
  const inside = (r) => plots.some((p) => r.x + r.width / 2 > p.left && r.x + r.width / 2 < p.right && r.y + r.height / 2 > p.top && r.y + r.height / 2 < p.bottom);
  const skip = "[data-gloom-role=composite-chart-toolbar], [data-gloom-role=chart-watermark], [data-gloom-role=composite-chart-measure]";
  return [...(${scope})?.querySelectorAll("[data-gloom-role=composite-chart] *") ?? []].flatMap((element) => {
    if (element.closest(skip)) return [];
    const own = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent.trim()).join("");
    if (!own) return [];
    const r = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (!r.width || !r.height || style.visibility === "hidden" || Number(style.opacity) === 0 || !inside(r)) return [];
    return [own.slice(0, 40)];
  });
})()`;

const plotRect = async (cdp: Cdp, paneId: string) => await evaluate<Rect | null>(
  cdp,
  `__check.rect(__check.pane(${JSON.stringify(paneId)})?.querySelector("[data-gloom-role=composite-chart-panel]"))`,
) ?? fail(`${paneId} has no chart plot`);

/**
 * The day of the observation the chart reads out under the pointer, as days
 * since 1970: the legend's entry, which follows the crosshair.
 */
async function cursorDay(cdp: Cdp, paneId: string, at: Point): Promise<number> {
  // A move off and back, so the chart reads the pointer here even when it already was.
  await mouse(cdp, "mouseMoved", at.x + 2, at.y, false);
  await frames(cdp, 2);
  await mouse(cdp, "mouseMoved", at.x, at.y, false);
  await frames(cdp, 4);
  const day = await evaluate<number | null>(cdp, `(() => {
    const pane = __check.pane(${JSON.stringify(paneId)});
    const label = pane?.querySelector("[data-gloom-role=composite-chart-legend-series]")?.getAttribute("data-gloom-label") ?? "";
    const date = /Observed (\\d{4}-\\d{2}-\\d{2})/.exec(label)?.[1];
    return date ? Date.parse(date) / 86400000 : null;
  })()`);
  return day ?? fail(`${paneId} reads out no observation under the pointer`, at);
}

/** Presses a tool in the chart's toolbar by the start of its label. */
async function armTool(cdp: Cdp, paneId: string, label: string): Promise<void> {
  const at = await evaluate<Point | null>(cdp, `(() => {
    const tool = [...(__check.pane(${JSON.stringify(paneId)})?.querySelectorAll("[data-gloom-role=composite-chart-tool]") ?? [])]
      .find((element) => (element.getAttribute("data-gloom-label") ?? "").startsWith(${JSON.stringify(label)}));
    const r = tool?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  })()`) ?? fail(`${paneId} has no ${label} tool`);
  await click(cdp, at);
}

/** The chart's vector shapes (drawings, the ruler's box) in page px, from their 0..1 overlay space. */
async function chartShapes(cdp: Cdp, paneId: string): Promise<Array<{ kind: string; points: Point[] }>> {
  return evaluate(cdp, `(() => {
    const svg = __check.pane(${JSON.stringify(paneId)})?.querySelector("[data-gloom-role=composite-chart-panel] svg");
    if (!svg) return [];
    const r = svg.getBoundingClientRect();
    const toPage = (x, y) => ({ x: r.x + Number(x) * r.width, y: r.y + Number(y) * r.height });
    return [...svg.querySelectorAll("polyline, rect")].map((shape) => shape.tagName === "rect"
      ? { kind: "box", points: [toPage(shape.getAttribute("x"), shape.getAttribute("y")), toPage(Number(shape.getAttribute("x")) + Number(shape.getAttribute("width")), Number(shape.getAttribute("y")) + Number(shape.getAttribute("height")))] }
      : { kind: "line", points: shape.getAttribute("points").trim().split(/\\s+/).map((pair) => toPage(...pair.split(","))) });
  })()`);
}

/** Three notches of Ctrl+wheel up over the plot: a zoom in anchored on the pointer. */
async function zoomIn(cdp: Cdp, at: Point): Promise<void> {
  await mouse(cdp, "mouseMoved", at.x, at.y, false);
  for (let notch = 0; notch < 3; notch += 1) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -120, modifiers: 2 });
    await frames(cdp, 2);
  }
  await frames(cdp, 2);
}

const near2 = (a: Point, b: Point, tolerance: number) => Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance;

/** Drags from `from` to `to` in steps, a frame after each, without letting go. */
async function dragHeld(cdp: Cdp, from: Point, to: Point, steps = 12): Promise<void> {
  await mouse(cdp, "mouseMoved", from.x, from.y, false);
  await mouse(cdp, "mousePressed", from.x, from.y, true);
  await frames(cdp);
  for (let step = 1; step <= steps; step += 1) {
    await mouse(cdp, "mouseMoved", from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps, true);
    await frames(cdp);
  }
}

/**
 * The charts that sit inside a pane's own layout (`nested`) take the pointer
 * as they did before they filled their box: the crosshair under it, a pan
 * that keeps the observation under it, a wheel zoom anchored on it, and the
 * trend line and the ruler drawn from where it pressed to where it let go.
 */
const NESTED_CHARTS = ["chart-bar:dock", "beside:dock", "overlay:dock"];
const nestedChartSteps: Step[] = NESTED_CHARTS.flatMap((paneId) => [
  {
    name: `${paneId} chart: the crosshair sits under the pointer across the plot`,
    scenario: "nested",
    async run(cdp: Cdp) {
      const plot = await plotRect(cdp, paneId);
      await crosshairUnder(cdp, paneId, { x: plot.x + plot.width * 0.85, y: plot.y + plot.height - 3 });
      // Clear of the chart's drawing toolbar at the plot's top left.
      await crosshairUnder(cdp, paneId, { x: plot.x + plot.width * 0.5, y: plot.y + 3 });
    },
  },
  {
    name: `${paneId} chart: a pan keeps the observation under the pointer`,
    scenario: "nested",
    async run(cdp: Cdp) {
      const plot = await plotRect(cdp, paneId);
      // Zoomed in first: the whole history has nowhere to pan to.
      await zoomIn(cdp, { x: plot.x + plot.width * 0.5, y: plot.y + plot.height * 0.5 });
      const from = { x: plot.x + plot.width * 0.3, y: plot.y + plot.height * 0.5 };
      const to = { x: from.x + Math.round(plot.width * 0.25), y: from.y };
      const before = await cursorDay(cdp, paneId, from);
      await drag(cdp, from, [to]);
      const after = await cursorDay(cdp, paneId, to);
      if (Math.abs(after - before) > 2) fail(`panning moved the observation under the pointer by ${after - before} days`);
    },
  },
  {
    // The line markers are placed by CSS in the plot's own width and height, a
    // fraction of a cell off its cells: they must still sit on the crosshair.
    // The values are in the legend and on the axes: nothing floats over the plot.
    name: `${paneId} chart: the line markers follow the crosshair and no readout floats over the plot`,
    scenario: "nested",
    async run(cdp: Cdp) {
      const plot = await plotRect(cdp, paneId);
      const pane = `__check.pane(${JSON.stringify(paneId)})`;
      const legend = `[...(${pane}?.querySelectorAll("[data-gloom-role=composite-chart-legend-series]") ?? [])].map((entry) => entry.textContent).join(" | ")`;
      await mouse(cdp, "mouseMoved", plot.x + plot.width / 2, plot.y - 40, false);
      await frames(cdp, 4);
      const latest = await evaluate<string>(cdp, legend);
      const seen = new Set<string>();
      for (const share of [0.12, 0.5, 0.92]) {
        const at = { x: plot.x + plot.width * share, y: plot.y + plot.height * 0.6 };
        await crosshairUnder(cdp, paneId, at);
        const geometry = `(() => {
          const pane = ${pane};
          const rect = (selector) => pane?.querySelector(selector)?.getBoundingClientRect();
          const line = rect("[data-gloom-role=chart-crosshair-x]");
          const marker = rect("[data-gloom-role=chart-crosshair-marker]");
          const area = rect("[data-gloom-role=composite-chart-panel]");
          return line && marker && area ? {
            line: line.x + line.width / 2, marker: marker.x + marker.width / 2, markerY: marker.y + marker.height / 2,
            areaTop: area.top, areaBottom: area.bottom,
          } : null;
        })()`;
        const g = await waitFor<Record<string, number> | null>(cdp, geometry) ?? fail(`${paneId}: no line marker at ${Math.round(share * 100)}% of the plot`);
        if (Math.abs(g.marker! - g.line!) > 1.5 || g.markerY! < g.areaTop! - 1 || g.markerY! > g.areaBottom! + 1) {
          fail(`${paneId}: the line marker is not on the crosshair at ${Math.round(share * 100)}% of the plot`, g);
        }
        const floating = await evaluate<string[]>(cdp, FLOATING_PLOT_TEXT(pane));
        if (floating.length) fail(`${paneId}: text floats over the plot at ${Math.round(share * 100)}% of it`, floating);
        seen.add(await evaluate<string>(cdp, legend));
      }
      // The legend reads the crosshair out, and goes back to the latest values when the pointer leaves.
      if (seen.size < 2) fail(`${paneId}: the legend did not follow the crosshair`, [...seen]);
      await mouse(cdp, "mouseMoved", plot.x + plot.width / 2, plot.y - 40, false);
      if (!await waitFor(cdp, `${legend} === ${JSON.stringify(latest)}`)) fail(`${paneId}: the legend kept the crosshair's values after the pointer left`, { latest, now: await evaluate(cdp, legend) });
    },
  },
  {
    name: `${paneId} chart: a wheel zoom keeps the observation under the pointer`,
    scenario: "nested",
    async run(cdp: Cdp) {
      const plot = await plotRect(cdp, paneId);
      const at = { x: plot.x + plot.width * 0.6, y: plot.y + plot.height * 0.5 };
      const before = await cursorDay(cdp, paneId, at);
      const axis = `__check.pane(${JSON.stringify(paneId)})?.querySelector("[data-gloom-role=chart-time-axis]")?.getAttribute("data-gloom-label")`;
      const labels = await evaluate<string>(cdp, axis);
      await zoomIn(cdp, at);
      if (!await waitFor(cdp, `${axis} !== ${JSON.stringify(labels)}`)) fail("the wheel did not zoom the chart");
      const after = await cursorDay(cdp, paneId, at);
      if (Math.abs(after - before) > 2) fail(`zooming moved the observation under the pointer by ${after - before} days`);
    },
  },
  {
    name: `${paneId} chart: a trend line runs from the press to the release`,
    scenario: "nested",
    async run(cdp: Cdp) {
      const plot = await plotRect(cdp, paneId);
      await armTool(cdp, paneId, "Trend line");
      const from = { x: plot.x + plot.width * 0.25, y: plot.y + plot.height * 0.3 };
      const to = { x: plot.x + plot.width * 0.7, y: plot.y + plot.height * 0.75 };
      await drag(cdp, from, [to]);
      await frames(cdp, 3);
      const line = (await chartShapes(cdp, paneId)).find((shape) => shape.kind === "line" && shape.points.length === 2);
      if (!line) fail("no trend line was drawn");
      // Its ends sit on observations: within a few px of the pointer, as before.
      if (!near2(line.points[0]!, from, 4) || !near2(line.points[1]!, to, 4)) {
        fail("the trend line does not run from the press to the release", { from, to, line: line.points });
      }
    },
  },
  {
    name: `${paneId} chart: the ruler spans from the press to the pointer`,
    scenario: "nested",
    async run(cdp: Cdp) {
      const plot = await plotRect(cdp, paneId);
      await armTool(cdp, paneId, "Ruler");
      const from = { x: plot.x + plot.width * 0.2, y: plot.y + plot.height * 0.7 };
      const to = { x: plot.x + plot.width * 0.65, y: plot.y + plot.height * 0.35 };
      await dragHeld(cdp, from, to);
      const box = (await chartShapes(cdp, paneId)).find((shape) => shape.kind === "box");
      const readout = await evaluate<boolean>(cdp, `!!__check.pane(${JSON.stringify(paneId)})?.querySelector("[data-gloom-role=composite-chart-measure]")`);
      await mouse(cdp, "mouseReleased", to.x, to.y, false);
      if (!box || !readout) fail("the ruler drew no box or readout", { box, readout });
      const [a, b] = box.points as [Point, Point];
      const corners = { left: Math.min(a.x, b.x), right: Math.max(a.x, b.x), top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) };
      if (Math.abs(corners.left - from.x) > 4 || Math.abs(corners.right - to.x) > 4 || Math.abs(corners.top - to.y) > 4 || Math.abs(corners.bottom - from.y) > 4) {
        fail("the ruler does not span from the press to the pointer", { from, to, corners });
      }
    },
  },
]);

nestedChartSteps.push({
  name: "board:dock chart: the crosshair sits under the pointer across the kit's chart band",
  scenario: "nested",
  async run(cdp: Cdp) {
    const plot = await plotRect(cdp, "board:dock");
    await crosshairUnder(cdp, "board:dock", { x: plot.x + plot.width * 0.85, y: plot.y + plot.height - 3 });
    await crosshairUnder(cdp, "board:dock", { x: plot.x + plot.width * 0.5, y: plot.y + 3 });
  },
});

/** A floating pane's resize grip and the text of every label on its charts' time axes, in page px. */
const GRIP_AND_AXIS_LABELS = (paneId: string) => `(() => {
  const pane = __check.pane(${JSON.stringify(paneId)});
  const grip = __check.rect(pane?.querySelector(":scope > [data-gloom-role=resize-handle]"));
  const labels = [...(pane?.querySelectorAll("[data-gloom-role=chart-time-axis] *") ?? [])]
    .filter((element) => element.children.length === 0 && (element.textContent ?? "").trim().length > 0)
    .map((label) => {
      // The text, not its box: a segment's box reaches the edge, its text may not.
      const range = document.createRange();
      range.selectNodeContents(label);
      const r = range.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, text: label.textContent.trim() };
    });
  return { grip, labels };
})()`;

async function endLabelsClearOfGrip(cdp: Cdp, paneId: string, when: string): Promise<void> {
  const { grip, labels } = await evaluate<{ grip: Rect | null; labels: Array<Rect & { text: string }> }>(cdp, GRIP_AND_AXIS_LABELS(paneId));
  if (!grip) fail(`${paneId} has no resize grip`);
  if (labels.length === 0) fail(`${paneId} has no time axis labels`);
  for (const label of labels) {
    const overlaps = label.x < grip.x + grip.width && label.x + label.width > grip.x && label.y < grip.y + grip.height && label.y + label.height > grip.y;
    const { text: _text, ...box } = label;
    if (overlaps) fail(`${when}, the time axis label "${label.text}" in ${paneId} runs under the resize grip`, { label: round(box), grip: round(grip) });
  }
}

/**
 * A chart that reaches the bottom of a floating pane keeps the last label of
 * its time axis clear of the resize grip in the corner, at rest and while the
 * corner is dragged.
 */
const gripSteps: Step[] = [
  ["chart", "chart:float"],
  ["g", "chart-bar:float"],
  ["beside", "beside:float"],
  ["overlay", "overlay:float"],
].map(([float, paneId]) => ({
  name: `floating ${paneId}: its time axis stays clear of the resize grip`,
  scenario: `resize&float=${float}`,
  async run(cdp: Cdp) {
    await endLabelsClearOfGrip(cdp, paneId!, "at rest");
    const from = await pointOf(cdp, paneId!, "resize");
    await dragHeld(cdp, from, { x: from.x + 120, y: from.y + 40 });
    await endLabelsClearOfGrip(cdp, paneId!, "while resizing");
    await mouse(cdp, "mouseReleased", from.x + 120, from.y + 40, false);
    await frames(cdp, 4);
    await endLabelsClearOfGrip(cdp, paneId!, "after the release");
  },
}));

/**
 * Every box outside the charts and the boxes that fill with them, with the
 * fills taken off and put back: where they are must not change. A fill only
 * takes the fraction of a cell left empty below or beside a chart.
 */
const FILLS_MOVE = `(() => {
  const filled = [...document.querySelectorAll("[data-gloom-fill-x],[data-gloom-fill-y]")];
  const others = [...document.querySelectorAll("[data-gloom-role=pane-window] *")]
    .filter((element) => !filled.some((fill) => fill === element || fill.contains(element)));
  const box = (element) => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 100) / 100); };
  const before = others.map(box);
  const saved = filled.map((fill) => [fill, fill.getAttribute("data-gloom-fill-x"), fill.getAttribute("data-gloom-fill-y")]);
  for (const fill of filled) { fill.removeAttribute("data-gloom-fill-x"); fill.removeAttribute("data-gloom-fill-y"); }
  const after = others.map(box);
  for (const [fill, x, y] of saved) { if (x) fill.setAttribute("data-gloom-fill-x", x); if (y) fill.setAttribute("data-gloom-fill-y", y); }
  const moved = others.map((element, i) => ({ element, filled: before[i], cells: after[i] }))
    .filter(({ filled, cells }) => filled.some((value, j) => Math.abs(value - cells[j]) > 0.5))
    .slice(0, 6)
    .map(({ element, filled, cells }) => ({ box: element.getAttribute("data-gloom-role") ?? element.tagName.toLowerCase(), pane: element.closest("[data-gloom-pane-id]")?.getAttribute("data-gloom-pane-id"), filled, cells }));
  return { filled: filled.length, moved };
})()`;

const fillSteps: Step[] = ([
  ["nested", true],
  ["stacked", true],
  ["resize", true],
  ["resize&float=under", false],
  ["resize&float=board", false],
] as const).map(([scenario, fills]) => ({
  name: `${scenario}: at rest, a chart's fill moves nothing outside it`,
  scenario,
  async run(cdp: Cdp) {
    await frames(cdp, 6);
    const { filled, moved } = await evaluate<{ filled: number; moved: unknown[] }>(cdp, FILLS_MOVE);
    if (fills && filled === 0) fail("no chart fills its box here, so this check checks nothing");
    if (moved.length > 0) fail("taking the fills off moves boxes outside the charts", moved);
  },
}));

const steps: Step[] = [
  { name: "theme preview paints every surface, cancel and commit agree", scenario: "theme&theme=high-contrast", run: checkThemePreview },
  { name: "theme preview paints a popped-out chart, cancel and commit agree", scenario: "theme-detached&theme=high-contrast", run: checkThemePreview },
  ...["white", "colorblind-light"].map((theme) => ({
    name: `first paint has no blank or provisional chart and no blank overview frame (${theme})`, scenario: `paint&theme=${theme}`, run: checkFirstPaint,
  })),
  ...PRESS_POINTS.map(([label, part]): Step => ({
    name: `docked pane: drag by the ${label} docks it elsewhere`,
    scenario: "docked",
    run: (cdp) => dockSwap(cdp, "plain:a", part, "plain:c"),
  })),
  ...PRESS_POINTS.map(([label, part]): Step => ({
    name: `tabbed pane: drag by the ${label} docks it elsewhere`,
    scenario: "docked",
    run: (cdp) => dockSwap(cdp, "tabs:a", part, "plain:c"),
  })),
  ...PRESS_POINTS.map(([label, part]): Step => ({
    name: `error card pane: drag by the ${label} docks it elsewhere`,
    scenario: "docked",
    async run(cdp) {
      if (!await waitFor(cdp, `__check.pane("broken:a")?.textContent.includes("stopped working")`)) fail("broken:a shows no failure card");
      await dockSwap(cdp, "broken:a", part, "plain:b");
    },
  })),
  ...PRESS_POINTS.map(([label, part]): Step => ({
    name: `floating pane: drag by the ${label} moves it`,
    scenario: "floating",
    run: (cdp) => floatMove(cdp, part, label),
  })),
  ...PRESS_POINTS.map(([label, part]): Step => ({
    name: `fullscreen pane: the ${label} moves the window, not the pane`,
    scenario: "docked",
    run: (cdp) => fullscreenBar(cdp, part, label),
  })),
  {
    name: "docked pane: the ? asks for its docs and leaves the pane in place",
    scenario: "docked",
    async run(cdp) {
      const before = await rectOf(cdp, "tabs:a");
      // The ? shows with the menu, on the focused or hovered pane.
      await click(cdp, await pointOf(cdp, "tabs:a", "title"));
      await click(cdp, await pointOf(cdp, "tabs:a", "help"));
      const asked = await waitFor<string[] | null>(cdp, `window.__paneChrome.docs.length ? window.__paneChrome.docs : null`);
      if (asked?.join() !== "tabs:a") fail("the ? did not ask for this pane's docs once", asked);
      if (!near(before, await rectOf(cdp, "tabs:a"))) fail("pressing the ? moved the pane");
    },
  },
  {
    name: "floating pane: the ? asks for its docs and leaves the pane in place",
    scenario: "floating",
    async run(cdp) {
      const before = await rectOf(cdp, "plain:float");
      await click(cdp, await pointOf(cdp, "plain:float", "title"));
      // A press that leaves the button is not a click: nothing opens and nothing moves.
      const help = await pointOf(cdp, "plain:float", "help");
      await drag(cdp, help, [{ x: help.x - 200, y: help.y + 150 }], 4);
      const asked = await evaluate<string[]>(cdp, "window.__paneChrome.docs");
      if (asked.length > 0) fail("a press dragged off the ? still asked for docs", asked);
      if (!near(before, await rectOf(cdp, "plain:float"))) fail("dragging from the ? moved the pane");
      await click(cdp, await pointOf(cdp, "plain:float", "help"));
      if ((await waitFor<string[] | null>(cdp, `window.__paneChrome.docs.length ? window.__paneChrome.docs : null`))?.join() !== "plain:float") {
        fail("the ? did not ask for this pane's docs");
      }
    },
  },
  {
    name: "docked pane: Ask Gloom asks about the pane and leaves it and its header's buttons in place",
    scenario: "docked",
    async run(cdp) {
      const before = await rectOf(cdp, "tabs:a");
      // Ask Gloom shows with the ? and the menu, on the focused or hovered pane.
      await click(cdp, await pointOf(cdp, "tabs:a", "title"));
      const shown = await headerParts(cdp, "tabs:a");
      if (!shown.ask || !shown.help) fail("the focused pane shows no Ask Gloom beside its ?", shown);
      checkHeaderRow("tabs:a", shown);
      await click(cdp, await pointOf(cdp, "tabs:a", "ask"));
      const asked = await waitFor<string[] | null>(cdp, `window.__paneChrome.asks.length ? window.__paneChrome.asks : null`);
      if (asked?.join() !== "tabs:a") fail("Ask Gloom did not ask about this pane once", asked);
      if (!near(before, await rectOf(cdp, "tabs:a"))) fail("pressing Ask Gloom moved the pane");
      const after = await headerParts(cdp, "tabs:a");
      for (const part of ["ask", "help", "action"] as const) {
        if (!near(shown[part], after[part], 0.5)) fail(`pressing Ask Gloom moved the header's ${part} button`, { shown: shown[part], after: after[part] });
      }
      if (await evaluate<string[]>(cdp, "window.__paneChrome.docs").then((docs) => docs.length > 0)) fail("Ask Gloom also asked for the pane's docs");
    },
  },
  {
    name: "floating pane: a press dragged off Ask Gloom asks nothing and moves nothing; a click asks",
    scenario: "floating",
    async run(cdp) {
      const before = await rectOf(cdp, "plain:float");
      await click(cdp, await pointOf(cdp, "plain:float", "title"));
      const ask = await pointOf(cdp, "plain:float", "ask");
      await drag(cdp, ask, [{ x: ask.x - 200, y: ask.y + 150 }], 4);
      const asked = await evaluate<string[]>(cdp, "window.__paneChrome.asks");
      if (asked.length > 0) fail("a press dragged off Ask Gloom still asked", asked);
      if (!near(before, await rectOf(cdp, "plain:float"))) fail("dragging from Ask Gloom moved the pane");
      await click(cdp, await pointOf(cdp, "plain:float", "ask"));
      if ((await waitFor<string[] | null>(cdp, `window.__paneChrome.asks.length ? window.__paneChrome.asks : null`))?.join() !== "plain:float") {
        fail("Ask Gloom did not ask about this pane");
      }
      if (!near(before, await rectOf(cdp, "plain:float"))) fail("clicking Ask Gloom moved the pane");
    },
  },
  {
    name: "keyboard: the Ask Gloom key asks about the focused pane, and not twice",
    scenario: "docked",
    async run(cdp) {
      const before = await rectOf(cdp, "plain:b");
      await click(cdp, await pointOf(cdp, "plain:b", "title"));
      await pressKey(cdp, "a", ["meta", "shift"]);
      const asked = await waitFor<string[] | null>(cdp, `window.__paneChrome.asks.length ? window.__paneChrome.asks : null`);
      if (asked?.join() !== "plain:b") fail("Cmd+Shift+A did not ask about the focused pane once", asked);
      // Control is the primary modifier on Windows and Linux. A second press
      // inside the cooldown would be a held key's, so the key goes up first.
      await sleep(KEY_UP_FOR_MS);
      await click(cdp, await pointOf(cdp, "plain:a", "title"));
      await pressKey(cdp, "a", ["ctrl", "shift"]);
      const again = await waitFor<string[] | null>(cdp, `window.__paneChrome.asks.length > 1 ? window.__paneChrome.asks : null`);
      if (again?.join() !== "plain:b,plain:a") fail("Ctrl+Shift+A did not ask about the newly focused pane", again);
      if (!near(before, await rectOf(cdp, "plain:b"))) fail("the key moved a pane");
    },
  },
  {
    name: "Ask Gloom: a pane hands over the text it shows, not rows scrolled out of view",
    scenario: "resize",
    async run(cdp) {
      // The floating news table: 160 stories, room for a couple of dozen.
      await click(cdp, await pointOf(cdp, "news:float", "title"));
      await pressKey(cdp, "a", ["meta", "shift"]);
      type Attachment = { paneId: string; visibleText: string | null };
      const [news] = await waitFor<Attachment[] | null>(cdp, `window.__paneChrome.attachments.length ? window.__paneChrome.attachments : null`) ?? [];
      if (news?.paneId !== "news:float") fail("the key did not hand over the focused table", news);
      const lines = news.visibleText?.split("\n") ?? [];
      if (!/TIME\s+HEADLINE/.test(lines[0] ?? "") || !lines.some((line) => /^1\s/.test(line))) fail("the table's own text did not go", lines.slice(0, 4));
      if (lines.some((line) => /^(100|159)\s/.test(line))) fail("a row scrolled out of view went with it", lines.length);
    },
  },
  {
    name: "Ask Gloom: a tabbed pane hands over the tab it has open",
    scenario: "docked",
    async run(cdp) {
      const second = await evaluate<Rect | null>(cdp, `__check.rect(__check.tab("tabs:a", "Second"))`) ?? fail("no Second tab");
      await click(cdp, center(second));
      await pressKey(cdp, "a", ["meta", "shift"]);
      type Attachment = { paneId: string; visibleText: string | null; args: Record<string, string> };
      const [tabs] = await waitFor<Attachment[] | null>(cdp, `window.__paneChrome.attachments.length ? window.__paneChrome.attachments : null`) ?? [];
      if (tabs?.paneId !== "tabs:a" || tabs.args.tab !== "Second") fail("the open tab did not go with the pane", tabs);
      if (!tabs.visibleText?.includes("Showing Second")) fail("the pane's text did not go", tabs);
    },
  },
  {
    name: "narrow panes: Ask Gloom leaves a header too narrow for it and keeps to its own place at the width that fits",
    scenario: "narrow",
    async run(cdp) {
      for (const paneId of ["plain:under", "plain:at", "tabs:wide"]) {
        await click(cdp, await pointOf(cdp, paneId, "title"));
        const parts = await headerParts(cdp, paneId);
        if (!parts.help || !parts.action || !parts.close) fail(`${paneId} lost a header button`, parts);
        if (paneId === "plain:under" ? !!parts.ask : !parts.ask) {
          fail(paneId === "plain:under" ? "a pane narrower than Ask Gloom's width still draws it" : `${paneId} draws no Ask Gloom`, parts);
        }
        checkHeaderRow(paneId, parts);
        if (parts.title!.width < 16) fail(`${paneId}: the title has no room left`, parts);
      }
      // Both docked panes keep theirs, hovered as well as focused.
      const hovered = await pointOf(cdp, "plain:a", "title");
      await mouse(cdp, "mouseMoved", hovered.x, hovered.y, false);
      await frames(cdp, 2);
      const docked = await headerParts(cdp, "plain:a");
      if (!docked.ask) fail("a hovered docked pane shows no Ask Gloom", docked);
      checkHeaderRow("plain:a", docked);
    },
  },
  {
    name: "tabs: a click selects the tab and leaves the pane in place",
    scenario: "docked",
    async run(cdp) {
      const before = await rectOf(cdp, "tabs:a");
      const tab = await evaluate<Rect | null>(cdp, `__check.rect(__check.tab("tabs:a", "Second"))`) ?? fail("no Second tab");
      await click(cdp, center(tab));
      const selected = `__check.tab("tabs:a", "Second")?.getAttribute("aria-selected") === "true" && __check.pane("tabs:a").textContent.includes("Showing Second")`;
      if (!await waitFor(cdp, selected)) fail("clicking Second did not select it", await evaluate(cdp, `__check.tabs("tabs:a")`));
      if (!near(before, await rectOf(cdp, "tabs:a"))) fail("clicking a tab moved the pane");
    },
  },
  {
    name: "tabs: dragging a tab reorders the strip and leaves the pane in place",
    scenario: "docked",
    async run(cdp) {
      const before = await rectOf(cdp, "tabs:a");
      const first = await evaluate<Rect | null>(cdp, `__check.rect(__check.tab("tabs:a", "First"))`) ?? fail("no First tab");
      const third = await evaluate<Rect | null>(cdp, `__check.rect(__check.tab("tabs:a", "Third"))`) ?? fail("no Third tab");
      await drag(cdp, center(first), [{ x: third.x + third.width * 0.75, y: third.y + third.height / 2 }]);
      const order = await waitFor<string[] | null>(cdp, `(() => { const tabs = __check.tabs("tabs:a"); return tabs.join() === "Second,Third,First" ? tabs : null; })()`);
      if (!order) fail("dragging First past Third did not reorder the tabs", await evaluate(cdp, `__check.tabs("tabs:a")`));
      if (!near(before, await rectOf(cdp, "tabs:a"))) fail("dragging a tab moved the pane", { before: round(before), after: round(await rectOf(cdp, "tabs:a")) });
    },
  },
  {
    name: "tabs: a tab dragged onto another pane never moves its pane",
    scenario: "docked",
    async run(cdp) {
      const before = { pane: await rectOf(cdp, "tabs:a"), target: await rectOf(cdp, "plain:c") };
      const tab = await evaluate<Rect | null>(cdp, `__check.rect(__check.tab("tabs:a", "Second"))`) ?? fail("no Second tab");
      await drag(cdp, center(tab), [center(before.target!)]);
      await frames(cdp, 3);
      const after = { pane: await rectOf(cdp, "tabs:a"), target: await rectOf(cdp, "plain:c") };
      if (!near(before.pane, after.pane) || !near(before.target, after.target)) {
        fail("a tab drag moved a pane", { before: { pane: round(before.pane), target: round(before.target) }, after: { pane: round(after.pane), target: round(after.target) } });
      }
    },
  },
  {
    name: "floating pane: the corner handle resizes it",
    scenario: "floating",
    async run(cdp) {
      const before = await rectOf(cdp, "plain:float") ?? fail("no floating pane");
      const from = await pointOf(cdp, "plain:float", "resize");
      const by = { x: -80, y: -36 };
      await drag(cdp, from, [{ x: from.x + by.x, y: from.y + by.y }]);
      const cell = await evaluate<{ width: number; height: number }>(cdp, "window.__paneChrome.cell");
      const resized = `(() => { const r = __check.paneRect("plain:float"); return r && Math.abs(r.width - ${before.width + by.x}) <= ${cell.width + 1} && Math.abs(r.height - ${before.height + by.y}) <= ${cell.height + 1} && Math.abs(r.x - ${before.x}) <= 2 && Math.abs(r.y - ${before.y}) <= 2; })()`;
      if (!await waitFor(cdp, resized)) fail(`dragging the corner by (${by.x}, ${by.y}) did not resize the pane`, { before: round(before), after: round(await rectOf(cdp, "plain:float")) });
    },
  },
  ...EDGES.map(({ edge, by, moves, grows }): Step => ({
    name: `floating pane: the ${edge} edge resizes it, following the pointer`,
    scenario: "floating",
    async run(cdp) {
      const before = await rectOf(cdp, "plain:float") ?? fail("no floating pane");
      const handle = await evaluate<Rect | null>(cdp, `__check.rect(document.querySelector("[data-gloom-role=resize-edge][data-edge=${edge}]"))`) ?? fail(`no ${edge} resize edge`);
      const from = center(handle);
      const expected = {
        x: before.x + by.x * moves.x,
        y: before.y + by.y * moves.y,
        width: before.width + by.x * grows.x,
        height: before.height + by.y * grows.y,
      };
      const cell = await evaluate<{ width: number; height: number }>(cdp, "window.__paneChrome.cell");
      const close = (r: Rect | null) => !!r && Math.abs(r.x - expected.x) <= 2 && Math.abs(r.y - expected.y) <= 2
        && Math.abs(r.width - expected.width) <= 2 && Math.abs(r.height - expected.height) <= 2;
      // To the pixel while the pointer is down, whole cells or not.
      await dragHolding(cdp, from, { x: from.x + by.x, y: from.y + by.y }, async () => {
        const during = await rectOf(cdp, "plain:float");
        if (!close(during)) fail(`mid-drag, the ${edge} edge did not follow the pointer by (${by.x}, ${by.y})`, { before: round(before), during: round(during), expected: round(expected) });
      });
      const settled = `(() => { const r = __check.paneRect("plain:float"); return r && Math.abs(r.x - ${expected.x}) <= ${cell.width / 2 + 1} && Math.abs(r.y - ${expected.y}) <= ${cell.height / 2 + 1} && Math.abs(r.width - ${expected.width}) <= ${cell.width / 2 + 1} && Math.abs(r.height - ${expected.height}) <= ${cell.height / 2 + 1}; })()`;
      if (!await waitFor(cdp, settled)) fail(`releasing the ${edge} edge did not keep the size`, { before: round(before), after: round(await rectOf(cdp, "plain:float")), expected: round(expected) });
    },
  })),
  {
    name: "dock divider: the panes on both sides follow the pointer during the drag",
    scenario: "docked",
    async run(cdp) {
      const before = { left: await rectOf(cdp, "plain:a"), right: await rectOf(cdp, "tabs:a"), last: await rectOf(cdp, "plain:b") };
      if (!before.left || !before.right || !before.last) fail("panes missing");
      const divider = await topDivider(cdp, "plain:a");
      const by = 88;
      // The row's right edge stays put; the panes right of the divider share what is left.
      await dragHolding(cdp, divider, { x: divider.x + by, y: divider.y }, async () => {
        const during = { left: await rectOf(cdp, "plain:a"), right: await rectOf(cdp, "tabs:a"), last: await rectOf(cdp, "plain:b") };
        const followed = during.left && during.right && during.last
          && Math.abs(during.left.width - (before.left!.width + by)) <= 2
          && Math.abs(during.right.x - (before.right!.x + by)) <= 2
          && Math.abs(during.last.x + during.last.width - (before.last!.x + before.last!.width)) <= 2;
        if (!followed) fail(`mid-drag, the panes did not follow the divider ${by}px`, { before: { left: round(before.left), right: round(before.right), last: round(before.last) }, during: { left: round(during.left), right: round(during.right), last: round(during.last) } });
      });
      const settled = `(() => { const left = __check.paneRect("plain:a"); return left && Math.abs(left.width - ${before.left.width + by}) <= 2; })()`;
      if (!await waitFor(cdp, settled)) fail("the release did not keep the panes where the drag had them", round(await rectOf(cdp, "plain:a")));
    },
  },
  {
    name: "table column: the sidebar beside a table follows the pointer during the drag",
    scenario: "resize",
    async run(cdp) {
      const sidebar = `__check.rect(__check.pane("sidebar:dock").querySelector("[data-gloom-role=pane-sidebar]"))`;
      const before = await evaluate<Rect | null>(cdp, sidebar) ?? fail("no sidebar");
      const from = { x: before.x + before.width, y: before.y + before.height / 2 };
      const by = 52;
      await dragHolding(cdp, from, { x: from.x + by, y: from.y }, async () => {
        const during = await evaluate<Rect | null>(cdp, sidebar);
        if (!during || Math.abs(during.width - (before.width + by)) > 2) fail(`mid-drag, the sidebar did not follow the pointer ${by}px`, { before: round(before), during: round(during) });
      });
      const cell = await evaluate<{ width: number }>(cdp, "window.__paneChrome.cell");
      if (!await waitFor(cdp, `(() => { const r = ${sidebar}; return r && Math.abs(r.width - ${before.width + by}) <= ${cell.width / 2 + 1}; })()`)) {
        fail("the release did not keep the sidebar's width", round(await evaluate<Rect | null>(cdp, sidebar)));
      }
    },
  },
  ...([
    ["chart", "chart", "chart:float", "canvas"],
    ["heat map", "heat", "heat:float", "[data-gloom-role=heat-treemap]"],
  ] as const).map(([label, float, paneId, content]): Step => ({
    name: `floating ${label}: what it draws follows the corner between catch-ups`,
    scenario: `resize&float=${float}`,
    async run(cdp) {
      const from = await pointOf(cdp, paneId, "resize");
      await contentFollowsFrame(cdp, paneId, content, from, { x: from.x + 140, y: from.y + 54 });
    },
  })),
  {
    // A chart over a data table stays on its cells and the prediction during a
    // resize: following the frame would lay the table's rows out on every
    // frame. The table keeps the size the pane last rendered it at.
    name: "floating board: the table under the chart band keeps its size between catch-ups",
    scenario: "resize&float=board",
    async run(cdp) {
      const width = `__check.rect(__check.pane("board:float")?.querySelector("[data-gloom-role=data-table]"))?.width ?? null`;
      const before = await evaluate<number | null>(cdp, width) ?? fail("board:float has no table");
      const from = await pointOf(cdp, "board:float", "resize");
      await mouse(cdp, "mouseMoved", from.x, from.y, false);
      await mouse(cdp, "mousePressed", from.x, from.y, true);
      await frames(cdp);
      let during: number | null = null;
      try {
        await mouse(cdp, "mouseMoved", from.x + 6, from.y + 6, true);
        await mouse(cdp, "mouseMoved", from.x + 140, from.y + 54, true);
        await frames(cdp, 2);
        during = await evaluate<number | null>(cdp, width);
      } finally {
        await mouse(cdp, "mouseReleased", from.x + 140, from.y + 54, false);
        await frames(cdp, 2);
      }
      if (during === null || Math.abs(during - before) > 0.5) fail("mid-drag, the table under the chart band was laid out at the frame's size", { before, during });
    },
  },
  {
    name: "dock divider: the chart beside it keeps to its pane's edge between catch-ups",
    scenario: "resize",
    async run(cdp) {
      const news = await rectOf(cdp, "news:dock") ?? fail("news:dock missing");
      const divider = await topDivider(cdp, "news:dock", news.y + 60);
      await contentFollowsFrame(cdp, "chart:dock", "canvas", divider, { x: divider.x - 160, y: divider.y });
    },
  },
  {
    // A chart that is its pane's root fills the pane, a fraction of a cell past
    // its columns and rows: the pointer is read back into them, so the
    // crosshair stays under it down to the plot's bottom edge.
    name: "chart: the crosshair sits under the pointer across the plot",
    scenario: "resize",
    async run(cdp) {
      const plot = await evaluate<Rect | null>(cdp, `__check.rect(__check.pane("chart:dock")?.querySelector("[data-gloom-role=composite-chart-panel]"))`)
        ?? fail("chart:dock has no plot");
      // Short of the empty offset after the last observation, where the line stays on it.
      for (const at of [
        { x: plot.x + plot.width * 0.85, y: plot.y + plot.height - 3 },
        { x: plot.x + plot.width * 0.5, y: plot.y + plot.height * 0.5 },
      ]) {
        await mouse(cdp, "mouseMoved", at.x, at.y, false);
        const crosshair = `(() => {
          const pane = __check.pane("chart:dock");
          const x = pane?.querySelector("[data-gloom-role=chart-crosshair-x]")?.getBoundingClientRect();
          const y = pane?.querySelector("[data-gloom-role=chart-crosshair-y]")?.getBoundingClientRect();
          return x && y ? { x: Math.round(x.x + x.width / 2), y: Math.round(y.y + y.height / 2) } : null;
        })()`;
        // The vertical line snaps to the nearest observation; the horizontal one is the pointer's.
        const under = `(() => { const lines = ${crosshair}; return lines && Math.abs(lines.x - ${at.x}) <= 4 && Math.abs(lines.y - ${at.y}) <= 2; })()`;
        if (!await waitFor(cdp, under)) {
          fail("the crosshair is not under the pointer", { pointer: { x: Math.round(at.x), y: Math.round(at.y) }, crosshair: await evaluate(cdp, crosshair) });
        }
      }
    },
  },
  ...nestedChartSteps,
  ...gripSteps,
  ...fillSteps,
  {
    name: "chart composer: a long pan back keeps its span, loads older bars as it goes and never jumps forward",
    scenario: "cmp&chart=pan",
    async run(cdp) {
      await loadedChartPlot(cdp);
      const start = await chartWindow(cdp);
      const views = await panChartBack(cdp, 6);
      const last = views.at(-1)!;
      // Six drags of three quarters of a view each go well past the bars the chart opened with.
      if (last.viewStart >= start.dataStart) fail("the view never left the bars the chart opened with", { opened: day(start.dataStart), view: day(last.viewStart) });
      if (last.dataStart >= last.viewStart) fail("no older bars loaded ahead of the view", { data: day(last.dataStart), view: day(last.viewStart) });
    },
  },
  {
    name: "chart composer: a pan past the oldest bar stops at it",
    scenario: "cmp&chart=edge",
    async run(cdp) {
      const views = await panChartBack(cdp, 4);
      const last = views.at(-1)!;
      const span = last.viewEnd - last.viewStart;
      // The source has nothing older: the view rests on the first bar, not half a screen of nothing before it.
      if (last.dataStart - last.viewStart > span * 0.05) fail("the view kept going past the oldest bar", { oldest: day(last.dataStart), view: day(last.viewStart) });
      if (views.at(-2)!.viewStart !== last.viewStart) fail("the view did not come to rest at the oldest bar", views.slice(-2).map((view) => day(view.viewStart)));
    },
  },
  {
    name: "chart composer: choosing the selected range again returns a panned or zoomed view to it, and leaves one that was not moved alone",
    scenario: "cmp&chart=pan",
    async run(cdp) {
      const plot = await loadedChartPlot(cdp);
      const opened = await chartWindow(cdp);
      const selected = await selectedRange(cdp);
      if (!selected) fail("the range strip marks no range");

      // Not moved: nothing to go back to, so nothing reloads or redraws.
      await click(cdp, await rangeButton(cdp, selected));
      await evaluate(cdp, "new Promise((done) => setTimeout(done, 700))");
      const still = await chartWindow(cdp);
      if (!sameWindow(opened, still)) fail("the selected range moved a view that was never moved", { opened, still });

      // Panned back: the same press returns the view, and the bars it loaded stay.
      await drag(cdp, { x: plot.x + plot.width * 0.2, y: plot.y + plot.height * 0.5 }, [{ x: plot.x + plot.width * 0.8, y: plot.y + plot.height * 0.5 }], 16);
      await evaluate(cdp, "new Promise((done) => setTimeout(done, 700))");
      const panned = await chartWindow(cdp);
      if (panned.viewStart >= opened.viewStart - 60_000) fail("the drag did not pan the view back", { opened, panned });
      await click(cdp, await rangeButton(cdp, selected));
      if (!await waitFor(cdp, `(() => { const view = document.querySelector("[data-gloom-role=composite-chart]")?.dataset.gloomView?.split(":").map(Number); return !!view && Math.abs(view[0] - ${opened.viewStart}) <= 60000 && Math.abs(view[1] - ${opened.viewEnd}) <= 60000; })()`, 5_000)) {
        fail("the selected range did not return a panned view", { opened, now: await chartWindow(cdp) });
      }

      // Zoomed in with the wheel: the same.
      await zoomIn(cdp, center(plot));
      const zoomed = await chartWindow(cdp);
      if (zoomed.viewEnd - zoomed.viewStart >= (opened.viewEnd - opened.viewStart) * 0.9) fail("the wheel did not zoom the view in", { opened, zoomed });
      await click(cdp, await rangeButton(cdp, selected));
      if (!await waitFor(cdp, `(() => { const view = document.querySelector("[data-gloom-role=composite-chart]")?.dataset.gloomView?.split(":").map(Number); return !!view && Math.abs(view[0] - ${opened.viewStart}) <= 60000 && Math.abs(view[1] - ${opened.viewEnd}) <= 60000; })()`, 5_000)) {
        fail("the selected range did not return a zoomed view", { opened, now: await chartWindow(cdp) });
      }

      // A different range still changes the range, and its own press goes back to that one.
      const other = selected === "1M" ? "1W" : "1M";
      await click(cdp, await rangeButton(cdp, other));
      if (!await waitFor(cdp, `document.querySelector(".gloom-qb-inline[data-item-id=range] button[data-active=true]")?.textContent.trim() === ${JSON.stringify(other)}`)) {
        fail("a different range was not selected", { selected: await selectedRange(cdp) });
      }
      await evaluate(cdp, "new Promise((done) => setTimeout(done, 900))");
      const shorter = await chartWindow(cdp);
      await zoomIn(cdp, center(plot));
      await click(cdp, await rangeButton(cdp, other));
      if (!await waitFor(cdp, `(() => { const view = document.querySelector("[data-gloom-role=composite-chart]")?.dataset.gloomView?.split(":").map(Number); return !!view && Math.abs(view[0] - ${shorter.viewStart}) <= 60000 && Math.abs(view[1] - ${shorter.viewEnd}) <= 60000; })()`, 5_000)) {
        fail("the newly selected range did not return a zoomed view", { shorter, now: await chartWindow(cdp) });
      }
    },
  },
  {
    name: "chart composer: the legend reads out every series at the crosshair, by key and by pointer, and nothing floats over the plot",
    scenario: "cmp&chart=readout",
    async run(cdp) {
      const plot = await loadedChartPlot(cdp);
      if (!await waitFor(cdp, `document.querySelectorAll("[data-gloom-role=composite-chart-legend-series]").length === 6`, 10_000)) fail("the chart did not load its six series");
      const legendText = `[...document.querySelectorAll("[data-gloom-role=composite-chart-legend-series]")].map((entry) => entry.textContent).join(" | ")`;
      const latest = await evaluate<string>(cdp, legendText);
      // The newest bar is a US close, after the German listing's: its value is carried.
      await click(cdp, { x: plot.x + plot.width * 0.5, y: plot.y + plot.height * 0.5 });
      await mouse(cdp, "mouseMoved", plot.x + plot.width * 0.5, plot.y - 60, false);
      await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 });
      const readout = `(() => {
        const entries = [...document.querySelectorAll("[data-gloom-role=composite-chart-legend-series]")];
        return { entries: entries.length, carried: entries.filter((entry) => entry.dataset.carried === "true").length,
          text: ${legendText},
          markers: document.querySelectorAll("[data-gloom-role=chart-crosshair-marker]").length,
          hollow: document.querySelectorAll("[data-gloom-role=chart-crosshair-marker][data-hollow=true]").length,
          timeTag: document.querySelector("[data-gloom-role=chart-time-axis]")?.getAttribute("data-gloom-cursor") ?? null,
          floating: ${FLOATING_PLOT_TEXT("document")} };
      })()`;
      type Readout = { entries: number; carried: number; text: string; markers: number; hollow: number; timeTag: string | null; floating: string[] };
      const byKey = await waitFor<Readout | null>(cdp, `(() => { const r = ${readout}; return r.entries === 6 && r.carried >= 1 && r.text !== ${JSON.stringify(latest)} ? r : null; })()`);
      if (!byKey) fail("the arrow key's crosshair did not read out all six series in the legend with the German close carried", await evaluate(cdp, readout));
      // Price, two closes, the average and the RSI each get a marker; volume is read off its bars.
      if (byKey.markers !== 5 || byKey.hollow < 1) fail("the crosshair did not mark every line, the carried one hollow", byKey);
      if (byKey.floating.length) fail("text floats over the plot", byKey.floating);
      if (!byKey.timeTag) fail("the time axis has no tag under the crosshair", byKey);
      // Pointer in the price panel, then in the RSI panel: each gets its own horizontal line and price tag.
      const panels = await evaluate<Rect[]>(cdp, `[...document.querySelectorAll("[data-gloom-role=composite-chart-panel]")].map(__check.rect)`);
      for (const [index, panel] of [[0, panels[0]!], [panels.length - 1, panels.at(-1)!]] as const) {
        const at = { x: panel.x + panel.width * 0.3, y: panel.y + panel.height * 0.4 };
        await mouse(cdp, "mouseMoved", at.x, at.y, false);
        const lines = `(() => {
          const ys = [...document.querySelectorAll("[data-gloom-role=composite-chart-panel]")].map((plot) => !!plot.querySelector("[data-gloom-role=chart-crosshair-y]"));
          const tag = [...document.querySelectorAll("[data-gloom-role=chart-price-axis-cursor]")].some((tag) => { const r = tag.getBoundingClientRect(); return Math.abs(r.y + r.height / 2 - ${at.y}) <= 3; });
          return { ys, tag, ...${readout} };
        })()`;
        const state = await waitFor<(Readout & { ys: boolean[]; tag: boolean }) | null>(cdp, `(() => { const r = ${lines}; return r.entries === 6 && r.markers === 5 && r.ys.filter(Boolean).length === 1 && r.ys[${index}] && r.tag ? r : null; })()`);
        if (!state) fail(`the pointer in panel ${index} did not draw one horizontal line there with its price tag on the axis, and read out every series`, await evaluate(cdp, lines));
        if (state.floating.length) fail("text floats over the plot", state.floating);
        if (!state.timeTag) fail(`panel ${index}: the time axis has no tag under the crosshair`, state);
      }
      // The pointer leaves: the legend is back on the latest values.
      await mouse(cdp, "mouseMoved", plot.x + plot.width * 0.5, plot.y - 60, false);
      if (!await waitFor(cdp, `${legendText} === ${JSON.stringify(latest)}`)) fail("the legend kept the crosshair's values after the pointer left", await evaluate(cdp, legendText));
    },
  },
  {
    name: "idle: a pane with two tables renders nothing while nothing moves",
    scenario: "resize",
    async run(cdp) {
      // The sidebar pane's second table sits in a box that sizes to its content.
      await frames(cdp, 30);
      const before = await evaluate<number>(cdp, "window.__commits");
      await evaluate(cdp, "new Promise((done) => setTimeout(done, 1000))");
      const commits = await evaluate<number>(cdp, "window.__commits") - before;
      if (commits > 2) fail(`the page committed ${commits} times in a second with nothing moving`);
    },
  },
  {
    name: "dock divider: a drag resizes the panes on both sides",
    scenario: "docked",
    async run(cdp) {
      const before = { left: await rectOf(cdp, "plain:a"), right: await rectOf(cdp, "tabs:a") };
      if (!before.left || !before.right) fail("panes missing");
      // The divider between the first two panes of the top row.
      const divider = await evaluate<Point | null>(cdp, `(() => {
        const edge = ${before.left.x + before.left.width};
        const divider = [...document.querySelectorAll("[data-gloom-role=dock-divider]")].map((element) => element.getBoundingClientRect())
          .find((r) => r.height > r.width && Math.abs(r.x + r.width / 2 - edge) <= 6 && r.top < ${before.left.y + before.left.height / 2} && r.bottom > ${before.left.y + before.left.height / 2});
        return divider ? { x: divider.x + divider.width / 2, y: ${before.left.y + before.left.height / 2} } : null;
      })()`) ?? fail("no divider between plain:a and tabs:a");
      // The row's right edge stays put; the panes right of the divider share what is left.
      const rowEnd = await evaluate<number>(cdp, `(() => { const r = __check.paneRect("plain:b"); return r.x + r.width; })()`);
      const by = 96;
      await drag(cdp, divider, [{ x: divider.x + by, y: divider.y }]);
      const resized = `(() => { const left = __check.paneRect("plain:a"); const right = __check.paneRect("tabs:a"); const last = __check.paneRect("plain:b"); return left && right && last && Math.abs(left.width - ${before.left.width + by}) <= 8 && Math.abs(right.x - ${before.right.x + by}) <= 8 && right.width < ${before.right.width - 8} && Math.abs(last.x + last.width - ${rowEnd}) <= 2; })()`;
      if (!await waitFor(cdp, resized)) {
        fail(`dragging the divider ${by}px did not resize both sides`, { before: { left: round(before.left), right: round(before.right) }, after: { left: round(await rectOf(cdp, "plain:a")), right: round(await rectOf(cdp, "tabs:a")) } });
      }
    },
  },
  {
    name: "popped-out window: the empty bar moves the window",
    scenario: "detached",
    run: (cdp) => titleBarMovesWindow(cdp, "empty", "empty bar"),
  },
  {
    name: "popped-out window: the title moves the window",
    scenario: "detached",
    run: (cdp) => titleBarMovesWindow(cdp, "title", "title"),
  },
  {
    name: "popped-out window: a tab selects without moving the window",
    scenario: "detached",
    async run(cdp) {
      const tab = await evaluate<Rect | null>(cdp, `__check.rect(__check.tab("tabs:a", "Third"))`) ?? fail("no Third tab");
      await click(cdp, center(tab));
      if (!await waitFor(cdp, `__check.tab("tabs:a", "Third")?.getAttribute("aria-selected") === "true"`)) fail("clicking Third did not select it");
      if (await evaluate<number>(cdp, "__check.windowMoves()") > 0) fail("clicking a tab asked the window to move");
    },
  },
  {
    name: "popped-out window: the ? asks for the pane's docs without moving the window",
    scenario: "detached",
    async run(cdp) {
      await click(cdp, await pointOf(cdp, "tabs:a", "help"));
      if ((await waitFor<string[] | null>(cdp, `window.__paneChrome.docs.length ? window.__paneChrome.docs : null`))?.join() !== "tabs:a") {
        fail("the ? did not ask for the pane's docs");
      }
      if (await evaluate<number>(cdp, "__check.windowMoves()") > 0) fail("the ? asked the window to move");
    },
  },
  {
    name: "popped-out window: the pane menu button opens its menu without moving the window",
    scenario: "detached",
    async run(cdp) {
      await click(cdp, await pointOf(cdp, "tabs:a", "action"));
      if (!await waitFor(cdp, `!!document.querySelector("[role=menu]")`)) fail("the pane menu did not open");
      if (await evaluate<number>(cdp, "__check.windowMoves()") > 0) fail("the pane menu button asked the window to move");
    },
  },
  {
    name: "popped-out window: one Share entry opens its picture by pointer and held key",
    scenario: "detached",
    async run(cdp) {
      await click(cdp, await pointOf(cdp, "tabs:a", "action"));
      await waitFor(cdp, `!!document.querySelector('[role="menu"]')`);
      const shares = await evaluate<number>(cdp, `[...document.querySelectorAll('[role="menuitem"]')].filter(e => e.textContent.startsWith('Share')).length`);
      if (shares !== 1) fail("expected one Share entry", shares);
      const target = await evaluate<Rect>(cdp, `__check.rect([...document.querySelectorAll('[role="menuitem"]')].find(e => e.textContent.startsWith('Share')))`);
      await click(cdp, center(target));
      if (!await waitFor(cdp, `!!document.querySelector('[role="dialog"]')`)) fail("Share did not open");
      const press = async (key: string, code: string, modifiers: number, autoRepeat = false) => {
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, autoRepeat });
        if (!autoRepeat) await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
      };
      await press("Escape", "Escape", 0);
      await sleep(KEY_UP_FOR_MS);
      await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "S", code: "KeyS", modifiers: 10 });
      if (!await waitFor(cdp, "window.__paneChrome.shares === 2")) fail("Share key did not open");
      await press("Escape", "Escape", 0);
      for (let i = 0; i < 5; i++) await press("S", "KeyS", 10, true);
      await sleep(200);
      if (await evaluate<number>(cdp, "window.__paneChrome.shares") !== 2) fail("a held key opened Share twice");
      await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "S", code: "KeyS", modifiers: 10 });
      // Native menu and older terminals can repeat without the platform flag.
      await holdKey(cdp, { key: "S", code: "KeyS", keyCode: 83, modifiers: 10 }, HELD_MS, { flagRepeats: false });
      if (await evaluate<number>(cdp, "window.__paneChrome.shares") !== 2) fail("unflagged repeats reopened Share");
      await sleep(KEY_UP_FOR_MS);
      await holdKey(cdp, { key: "S", code: "KeyS", keyCode: 83, modifiers: 10 }, 0);
      if (!await waitFor(cdp, "window.__paneChrome.shares === 3")) fail("a later Share press did not open");
    },
  },
  {
    name: "held keys: Cmd+Shift+C held for 1.5 s copies one screenshot, and a later press copies another",
    scenario: "docked",
    async run(cdp) {
      await click(cdp, await pointOf(cdp, "plain:a", "title"));
      await holdKey(cdp, COPY_SCREENSHOT, HELD_MS);
      if (!await waitFor(cdp, "window.__paneChrome.clipboardImages.length >= 1", 10_000)) fail("a held Cmd+Shift+C copied no screenshot");
      // A capture the hold queued would land after the key came up.
      await sleep(KEY_UP_FOR_MS);
      const held = await evaluate<number[]>(cdp, "window.__paneChrome.clipboardImages");
      if (held.length !== 1) fail("a held Cmd+Shift+C did not copy exactly one screenshot", held);
      await holdKey(cdp, COPY_SCREENSHOT, 0);
      if (!await waitFor(cdp, "window.__paneChrome.clipboardImages.length >= 2", 10_000)) fail("a second Cmd+Shift+C press copied nothing");
      await sleep(KEY_UP_FOR_MS);
      const again = await evaluate<number[]>(cdp, "window.__paneChrome.clipboardImages");
      if (again.length !== 2) fail("a single Cmd+Shift+C press did not copy exactly one more screenshot", again);
    },
  },
  {
    name: "held keys: Cmd+Shift+C sent 45 times with no repeat flag in 1.5 s still copies one screenshot",
    scenario: "docked",
    async run(cdp) {
      await click(cdp, await pointOf(cdp, "plain:a", "title"));
      // What a held native menu accelerator looks like to the page: every trigger a fresh press.
      await holdKey(cdp, COPY_SCREENSHOT, HELD_MS, { flagRepeats: false });
      if (!await waitFor(cdp, "window.__paneChrome.clipboardImages.length >= 1", 10_000)) fail("the triggers copied no screenshot");
      await sleep(KEY_UP_FOR_MS);
      const copied = await evaluate<number[]>(cdp, "window.__paneChrome.clipboardImages");
      if (copied.length !== 1) fail("45 triggers in 1.5 s did not copy exactly one screenshot", copied);
    },
  },
  {
    name: "held keys: the Ask Gloom key held for 1.5 s hands the pane over once",
    scenario: "docked",
    async run(cdp) {
      await click(cdp, await pointOf(cdp, "plain:b", "title"));
      await holdKey(cdp, ASK_GLOOM, HELD_MS);
      await sleep(KEY_UP_FOR_MS);
      const asked = await evaluate<string[]>(cdp, "window.__paneChrome.asks");
      if (asked.join() !== "plain:b") fail("a held Ask Gloom key did not hand over the pane exactly once", asked);
    },
  },
  {
    name: "held keys: Cmd+W held for 1.5 s closes one pane, and a later press closes the next",
    scenario: "docked",
    async run(cdp) {
      const before = await evaluate<number>(cdp, PANE_COUNT);
      await click(cdp, await pointOf(cdp, "plain:a", "title"));
      await holdKey(cdp, CLOSE_PANE, HELD_MS);
      await frames(cdp, 3);
      const closed = await evaluate<number>(cdp, PANE_COUNT);
      if (closed !== before - 1) fail(`a held Cmd+W closed ${before - closed} panes, not one`, { before, closed });
      await sleep(KEY_UP_FOR_MS);
      await click(cdp, await pointOf(cdp, "plain:b", "title"));
      await holdKey(cdp, CLOSE_PANE, 0);
      await frames(cdp, 3);
      const next = await evaluate<number>(cdp, PANE_COUNT);
      if (next !== before - 2) fail(`a second Cmd+W press left ${next} panes, not ${before - 2}`);
    },
  },
  {
    name: "held keys: the arrow keys keep repeating in a table",
    scenario: "resize",
    async run(cdp) {
      await click(cdp, await pointOf(cdp, "news:float", "title"));
      const selected = `Number(__check.pane("news:float").querySelector("[data-selected=true]")?.textContent?.match(/^(\\d+)/)?.[1] ?? -1)`;
      const start = await evaluate<number>(cdp, selected);
      await holdKey(cdp, ARROW_DOWN, 1_000);
      const end = await evaluate<number>(cdp, selected);
      // About thirty repeats a second: the selection is well down the list, not one row on.
      if (start < 0 || end - start < 10) fail("a held arrow key did not keep moving the table selection", { start, end });
    },
  },
  {
    name: "held keys: Cmd+W held in a popped-out window closes it once",
    scenario: "detached",
    async run(cdp) {
      await holdKey(cdp, CLOSE_PANE, HELD_MS);
      const closes = await evaluate<number>(cdp, "window.__paneChrome.detachedCloses");
      if (closes !== 1) fail(`a held Cmd+W asked the popped-out window to close ${closes} times, not once`);
      await sleep(KEY_UP_FOR_MS);
      await holdKey(cdp, CLOSE_PANE, 0);
      if (await evaluate<number>(cdp, "window.__paneChrome.detachedCloses") !== 2) fail("a second Cmd+W press did not ask again");
    },
  },
  // Each caption button on a fresh window: it does its own job, never the window move.
  ...CAPTION_BUTTONS.map(([label, action]): Step => ({
    name: `popped-out window (Windows): the ${label} button does not move the window`,
    scenario: "detached&platform=win32",
    async run(cdp) {
      const actions = await evaluate<string[]>(cdp, `[...document.querySelectorAll("[data-gloom-role=window-control]")].map((button) => button.dataset.windowControlAction)`);
      if (actions.join() !== CAPTION_BUTTONS.map(([, value]) => value).join()) fail("the caption buttons changed; give each one a step", actions);
      const button = await evaluate<Rect | null>(cdp, `__check.rect(document.querySelector("[data-gloom-role=window-control][data-window-control-action=${action}]"))`)
        ?? fail(`no ${label} button`);
      await drag(cdp, center(button), [{ x: button.x - 60, y: button.y + 40 }], 6);
      const asked = await evaluate<string[]>(cdp, "window.__paneChrome.windowControls");
      if (asked.join() !== action) fail(`pressing ${label} did not ask for ${action} alone`, asked);
      if (await evaluate<number>(cdp, "__check.windowMoves()") > 0) fail(`the ${label} button asked the window to move`);
    },
  })),
  ...chatSteps,
  ...desSteps,
  ...heatSteps,
  ...headerSteps,
  ...layoutSteps,
  ...selectionSteps,
  ...axisSteps,
];

async function openScenario(cdp: Cdp, page: FixturePage, scenario: string): Promise<void> {
  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url: new URL(`?scenario=${scenario}`, page.url).href });
  await loaded;
  if (!await waitFor(cdp, "window.__paneChrome?.ready === true", 15_000)) {
    fail(`the ${scenario} fixture did not render`, await evaluate(cdp, "document.body.innerText.slice(0, 400)"));
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const only = takeOption(args, "--only");
  const repeat = positiveInteger(takeOption(args, "--repeat"), 1, "--repeat");
  const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
  const includeShare = !only || "global Share".includes(only);
  const selected = steps.filter((step) => !only || step.name.includes(only));
  if (selected.length === 0 && !includeShare) throw new Error(`No step matches "${only}"`);

  const page = await serveFixturePage(root, cacheDir("build", `checks-${process.pid}`));
  const browser = await launchBrowser("checks", VIEWPORT.width, VIEWPORT.height);
  const { cdp } = browser;
  const failures: Array<{ name: string; message: string }> = [];
  const passes = new Map<string, number>();
  try {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS + pageClock(process.env.PANE_CHROME_NOW) });
    for (let round = 1; round <= repeat; round += 1) {
      for (const step of selected) {
        const started = performance.now();
        try {
          await openScenario(cdp, page, step.scenario);
          await step.run(cdp);
          passes.set(step.name, (passes.get(step.name) ?? 0) + 1);
          console.log(`ok   ${step.name} (${Math.round(performance.now() - started)} ms)`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failures.push({ name: step.name, message });
          console.log(`FAIL ${step.name}\n     ${message}`);
          if (process.env.GITHUB_ACTIONS) console.log(`::error title=Pane chrome: ${step.name}::${message.replaceAll("\n", " ")}`);
          await saveScreenshot(cdp, step.name).catch(() => {});
        }
      }
      if (repeat > 1) console.log(`round ${round}/${repeat}: ${failures.length} failures so far`);
    }
    if (page.strayRequests.length > 0) {
      failures.push({ name: "fixture page", message: `requested files it does not have: ${page.strayRequests.join(", ")}` });
    }
  } finally {
    await browser.close();
    await page.close();
  }

  if (includeShare) {
    try {
      const { checkGlobalShare } = await import("./share");
      for (let round = 0; round < repeat; round++) await checkGlobalShare(root);
    } catch (error) {
      failures.push({ name: "global Share", message: error instanceof Error ? error.message : String(error) });
      console.error("FAIL global Share", error);
    }
  }

  const total = selected.length * repeat + (includeShare ? repeat : 0);
  const summary = [
    "### Pane chrome pointer checks",
    "",
    `${total - failures.length} of ${total} passed${repeat > 1 ? ` over ${repeat} rounds` : ""}.`,
    "",
    "| | Step |",
    "|---|---|",
    ...(includeShare ? [`| ${failures.some(f => f.name === "global Share") ? "**failed**" : "ok"} | global Share |`] : []),
    ...selected.map((step) => `| ${passes.get(step.name) === repeat ? "ok" : "**failed**"} | ${step.name} |`),
    ...(failures.length > 0 ? ["", "Failures:", "", ...failures.map((failure) => `- **${failure.name}**: ${failure.message}`)] : []),
  ].join("\n");
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  console.log(`\n${total - failures.length}/${total} passed`);
  if (failures.length > 0) process.exitCode = 1;
}

async function saveScreenshot(cdp: Cdp, name: string): Promise<void> {
  const dir = cacheDir("failures");
  await mkdir(dir, { recursive: true });
  const shot = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  const path = join(dir, `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`);
  await Bun.write(path, Buffer.from(shot.data, "base64"));
  console.log(`     screenshot: ${path}`);
}

await main();
