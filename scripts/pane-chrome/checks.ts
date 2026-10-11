import { appendFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { positiveInteger, takeOption } from "../tui-benchmark-harness";
import { cacheDir, click, drag, evaluate, frames, launchBrowser, mouse, waitFor, type Cdp, type Point } from "./browser";
import { serveFixturePage, type FixturePage } from "./page";

/**
 * Moves panes the way a person does: real pointer input (DevTools
 * Input.dispatchMouseEvent) on the desktop pane chrome in headless Chrome,
 * checking where each pane ends up rather than which handler ran. The pane
 * header has broken this way before: v0.16.1 shipped panes that only moved
 * from the grip and the title (#1478).
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
      : part === "action" || part === "help" ? this.part(id, "pane-" + part)?.querySelector("button")
      : this.part(id, "pane-" + part);
    const r = this.rect(element);
    return r && { x: r.x + Math.min(r.width / 2, 16), y: r.y + r.height / 2 };
  },
  /**
   * Bare header bar: just left of the header's buttons (the docs ?, then the
   * pane menu), where no title, tab or button is. Throws when something else
   * is under that point, so a layout change fails loudly instead of testing
   * the wrong spot.
   */
  emptyBarPoint(id) {
    const header = this.part(id, "pane-header");
    const action = this.part(id, "pane-help") ?? this.part(id, "pane-action");
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

const PRESS_POINTS = [["grip", "grip"], ["title", "title"], ["empty bar", "empty"]] as const;
const EDGES = [
  { edge: "left", by: { x: -64, y: 0 }, moves: { x: 1, y: 0 }, grows: { x: -1, y: 0 } },
  { edge: "right", by: { x: 64, y: 0 }, moves: { x: 0, y: 0 }, grows: { x: 1, y: 0 } },
  { edge: "bottom", by: { x: 0, y: 36 }, moves: { x: 0, y: 0 }, grows: { x: 0, y: 1 } },
  { edge: "top-left", by: { x: -64, y: -36 }, moves: { x: 1, y: 1 }, grows: { x: -1, y: -1 } },
] as const;
const CAPTION_BUTTONS = [["minimize", "minimize"], ["maximize", "toggle-maximize"], ["close", "close"]] as const;

const steps: Step[] = [
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
  const selected = steps.filter((step) => !only || step.name.includes(only));
  if (selected.length === 0) throw new Error(`No step matches "${only}"`);

  const page = await serveFixturePage(root, cacheDir("build", `checks-${process.pid}`));
  const browser = await launchBrowser("checks", VIEWPORT.width, VIEWPORT.height);
  const { cdp } = browser;
  const failures: Array<{ name: string; message: string }> = [];
  const passes = new Map<string, number>();
  try {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HELPERS });
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

  const total = selected.length * repeat;
  const summary = [
    "### Pane chrome pointer checks",
    "",
    `${total - failures.length} of ${total} passed${repeat > 1 ? ` over ${repeat} rounds` : ""}.`,
    "",
    "| | Step |",
    "|---|---|",
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
