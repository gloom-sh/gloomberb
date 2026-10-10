import { appendFile, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { positiveInteger, takeOption } from "../tui-benchmark-harness";
import { cacheDir, click, drag, evaluate, frames, launchBrowser, waitFor, type Cdp, type Point } from "./browser";
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
    const element = part === "resize" ? this.part(id, "resize-handle") : part === "action" ? this.part(id, "pane-action")?.querySelector("button") : this.part(id, "pane-" + part);
    const r = this.rect(element);
    return r && { x: r.x + Math.min(r.width / 2, 16), y: r.y + r.height / 2 };
  },
  /**
   * Bare header bar: just left of the pane menu button, where no title, tab
   * or button is. Throws when something else is under that point, so a layout
   * change fails loudly instead of testing the wrong spot.
   */
  emptyBarPoint(id) {
    const header = this.part(id, "pane-header");
    const action = this.part(id, "pane-action");
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

const PRESS_POINTS = [["grip", "grip"], ["title", "title"], ["empty bar", "empty"]] as const;
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
