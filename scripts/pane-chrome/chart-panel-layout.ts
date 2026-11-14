import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import type { BrowserContext, Page } from "playwright-core";
import { testAppEnv, TEST_BROWSER_PRIVACY_SCRIPT } from "../test-app-env";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir } from "./browser";
import { serveFixturePage } from "./page";
import { pixelChange } from "./ui-audit-compare";

/**
 * The composite chart's own layout in Chromium and WebKit, with the
 * real pointer on the chart composer fixture (`scenario=cmp&chart=readout`: a
 * price panel, a volume panel and an RSI panel), at 640 and 1280 px. In each
 * browser and width it checks that at rest the chart draws as the base does
 * (`--base`, pixel for pixel within ImageMagick's 2% fuzz) outside the drawing
 * tool bar's own rectangle, and that the bar is folded to one button showing
 * the tool in hand (the pan tool) with a hint that it opens, while the legend's
 * chevron and the lines between panels are not drawn; that the pointer on that
 * button opens the bar without the button changing its width, and the bar stays
 * open while the pointer moves from one icon to the next and folds a moment
 * after it leaves; that focus moved to it (assistive technology's: Tab is the
 * window's, and the keyboard's own way is Shift+T) opens it and its leaving
 * folds it; that a press on the button at its right edge, as the bar opens,
 * keeps the bar open (as Shift+T does), a press on the chevron that then leads
 * it folds it at once, under the pointer, which keeps it folded while it moves
 * across the button, and the bar opens when the pointer leaves and comes back
 * within the delay; that a tool picked from the keys shows on the
 * folded button; that the button has the radius, height and hover fill of the
 * bar's other icon buttons; that the legend's chevron shows under the pointer
 * and folds the legend to its first series and a count of the rest, which
 * opens it again, as Shift+L does, and a click on an entry still hides its
 * series; that the line between two panels shows under the pointer, a click
 * on it that jitters keeps the split, a drag on it moves it and a double-click
 * puts back the split; that Shift+Up makes the top panel taller; that a
 * double-click on the RSI plot gives it the whole chart, with its
 * `All panels` button and every series still read in the legend, and the
 * button, a double-click on it or another on the plot gives the others back
 * and keeps them; and that a drag on the
 * plot still pans. It pictures each state, and writes a contact sheet per
 * browser: the base at rest (`--base`), then this tree at rest and in each new
 * state, a row per width.
 *
 *   bun run check:chart-panel-layout [--base <checkout>] [--out <dir>] [--root <checkout>]
 *                                    [--browsers chromium,webkit] [--widths 640,1280]
 *
 * Needs playwright-core's Chromium and WebKit
 * (`bunx playwright-core install chromium webkit`) and ImageMagick for the
 * comparison and the sheets. Pictures, `sheet-<browser>.jpg` and
 * `report.json` land in `--out` (default under the pane chrome cache).
 */

const args = process.argv.slice(2);
const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
const baseOption = takeOption(args, "--base");
const base = baseOption ? resolve(baseOption) : null;
const out = resolve(takeOption(args, "--out") ?? cacheDir("chart-panel-layout"));
const browsers = (takeOption(args, "--browsers") ?? "chromium,webkit").split(",") as Array<"chromium" | "webkit">;
const widths = (takeOption(args, "--widths") ?? "640,1280").split(",").map(Number);
const HEIGHT = 800;
/** A taller window, where a split kept in whole rows would share the plot unlike the chart's own. */
const TALL_HEIGHT = 1010;
const STATES = ["rest", "toolbar-open", "toolbar-tool", "legend-folded", "divider-hover", "panels-resized", "maximized"] as const;
/** The fold delay of the tool bar (`CHART_TOOLBAR_FOLD_DELAY_MS`), and a wait past it. */
const FOLD_DELAY = 300;
const PAST_FOLD_DELAY = FOLD_DELAY + 250;

interface Check { browser: string; width: number; name: string; ok: boolean; detail: string }
const checks: Check[] = [];
/** The base's open tool bar at rest, by browser and width: the one rectangle the comparison leaves out. */
const baseToolbar = new Map<string, Box>();
const shots: string[] = [];

function check(browser: string, width: number, name: string, ok: boolean, detail: unknown) {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail);
  checks.push({ browser, width, name, ok, detail: text });
  console.log(`${ok ? "ok  " : "FAIL"} ${browser.padEnd(8)} ${String(width).padEnd(5)} ${name}  ${text}`);
}

async function launch(name: "chromium" | "webkit", width: number): Promise<BrowserContext> {
  const engines = await import("playwright-core");
  const profile = join(out, "profiles", `${name}-${width}`);
  await rm(profile, { recursive: true, force: true });
  const context = await engines[name].launchPersistentContext(profile, { headless: true, env: testAppEnv(), viewport: { width, height: HEIGHT }, deviceScaleFactor: 1 });
  await context.addInitScript({ content: TEST_BROWSER_PRIVACY_SCRIPT });
  return context;
}

interface Box { x: number; y: number; width: number; height: number }
interface LayoutState {
  view: string | null;
  panels: { label: string; box: Box }[];
  /** Each line between two panels, with the opacity its drawn line has. */
  dividers: { box: Box; line: string }[];
  toolbar: { box: Box; folded: boolean; pinned: boolean; buttons: number; handle: { label: string; box: Box } | null } | null;
  legend: { text: string; collapsed: boolean; toggleShown: boolean; more: Box | null } | null;
  restore: Box | null;
}

const layoutState = (page: Page) => page.evaluate((): LayoutState => {
  const box = (element: Element | null | undefined) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const shown = (element: Element | null | undefined) => !!element && getComputedStyle(element).display !== "none" && element.getBoundingClientRect().width > 0;
  const toolbar = document.querySelector<HTMLElement>("[data-gloom-role=composite-chart-toolbar]");
  const legend = document.querySelector<HTMLElement>("[data-gloom-role=composite-chart-legend]");
  const handle = toolbar?.querySelector("[data-gloom-role=composite-chart-toolbar-toggle]");
  return {
    view: document.querySelector<HTMLElement>("[data-gloom-role=composite-chart]")?.dataset.gloomView ?? null,
    panels: Array.from(document.querySelectorAll<HTMLElement>("[data-gloom-role=composite-chart-panel]"))
      .map((panel) => ({ label: panel.dataset.gloomLabel ?? "?", box: box(panel)! })),
    dividers: Array.from(document.querySelectorAll("[data-gloom-role=composite-chart-panel-divider]"))
      .map((divider) => ({ box: box(divider)!, line: getComputedStyle(divider, "::before").opacity })),
    toolbar: toolbar ? {
      box: box(toolbar)!,
      folded: toolbar.dataset.folded === "true",
      pinned: toolbar.dataset.pinned === "true",
      buttons: Array.from(toolbar.querySelectorAll("button, [role=button]")).filter((button) => shown(button)).length,
      handle: handle ? { label: handle.getAttribute("aria-label") ?? "", box: box(handle)! } : null,
    } : null,
    legend: legend ? {
      text: legend.textContent ?? "",
      collapsed: legend.dataset.collapsed === "true",
      toggleShown: shown(legend.querySelector("[data-gloom-role=composite-chart-legend-toggle]")),
      more: box(legend.querySelector("[data-gloom-role=composite-chart-legend-more]")),
    } : null,
    restore: box(document.querySelector("[data-gloom-role=composite-chart-panels-restore] button")
      ?? document.querySelector("[data-gloom-role=composite-chart-panels-restore]")),
  };
});

const settle = (page: Page, ms = 300) => page.waitForTimeout(ms);
const center = (box: Box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const heights = (state: LayoutState) => Object.fromEntries(state.panels.map((panel) => [panel.label, Math.round(panel.box.height)]));
const sameHeights = (a: LayoutState, b: LayoutState) => a.panels.length === b.panels.length
  && a.panels.every((panel, index) => Math.abs(panel.box.height - b.panels[index]!.box.height) <= 1);

/** Out of the way: the pointer off the chart, so nothing it reveals is drawn. */
async function park(page: Page, width: number) {
  await page.mouse.move(width - 2, HEIGHT - 2);
  await settle(page, 200);
}

async function picture(page: Page, file: string) {
  await page.screenshot({ path: file });
  shots.push(file);
}

async function open(page: Page, url: URL) {
  const target = new URL(url);
  target.search = "?scenario=cmp&chart=readout";
  await page.goto(target.href, { waitUntil: "load" });
  await page.waitForFunction(() => !!document.querySelector("[data-gloom-role=composite-chart]")?.getAttribute("data-gloom-view")
    && document.querySelectorAll("[data-gloom-role=composite-chart-panel] canvas").length > 0, undefined, { timeout: 20_000 });
  await settle(page, 800);
}

/** A double click at a hand's pace, so the page draws what the first click did before the second lands. */
async function humanDoubleClick(page: Page, at: { x: number; y: number }) {
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(150);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await settle(page);
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 10) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await settle(page);
}

/** A copy of the picture with the rectangle (and a margin for its edge) painted over. */
function maskBar(file: string, box: Box): string {
  const masked = file.replace(/\.png$/, "-masked.png");
  const margin = 3;
  const [x0, y0, x1, y1] = [box.x - margin, box.y - margin, box.x + box.width + margin, box.y + box.height + margin].map((value) => Math.round(value));
  Bun.spawnSync(["convert", file, "-fill", "black", "-draw", `rectangle ${x0},${y0} ${x1},${y1}`, masked]);
  return masked;
}

const shotPath = (side: string, browser: string, width: number, state: string) => join(out, side, `${browser}-${width}-${state}.png`);

async function exercise(browser: "chromium" | "webkit", width: number, page: Page, url: URL) {
  const say = (name: string, ok: boolean, detail: unknown) => check(browser, width, name, ok, detail);
  const shoot = (state: typeof STATES[number]) => picture(page, shotPath("after", browser, width, state));
  await open(page, url);
  await park(page, width);
  const rest = await layoutState(page);
  if (rest.panels.length !== 3 || !rest.toolbar || !rest.legend) {
    say("the fixture chart has three panels, the tool bar and the legend", false, rest);
    return;
  }
  await shoot("rest");
  if (base) {
    // Everything but the bar's rectangle (the base's, which is open, holds this one's): legend, axes and plot.
    const before = shotPath("before", browser, width, "rest");
    const bar = baseToolbar.get(`${browser}-${width}`);
    const compared = existsSync(before) && bar
      ? pixelChange(maskBar(before, bar), maskBar(shotPath("after", browser, width, "rest"), bar))
      : { status: "error" as const, error: "no base picture" };
    say("at rest the chart draws as the base does outside the tool bar", compared.status === "compared" && compared.change === 0, { bar, compared });
  }
  say("at rest the tool bar is folded to one button, which names the pan tool, and the legend chevron and panel lines are not drawn",
    rest.toolbar.folded && rest.toolbar.buttons === 1 && /^Pan\b/.test(rest.toolbar.handle?.label ?? "") && !rest.legend.toggleShown
      && rest.dividers.length === 2 && rest.dividers.every((divider) => divider.line === "0"),
    { toolbar: rest.toolbar, chevron: rest.legend.toggleShown, lines: rest.dividers.map((divider) => divider.line) });

  // The tool bar: the pointer on its one button opens it, and a moment after the pointer leaves it folds.
  const handleAt = (state: LayoutState) => center(state.toolbar!.handle!.box);
  await page.mouse.move(handleAt(rest).x, handleAt(rest).y);
  await settle(page, 150);
  const hovered = await layoutState(page);
  say("the pointer on the folded button opens the tool bar", hovered.toolbar?.folded === false && hovered.toolbar.buttons > 4 && !hovered.toolbar.pinned, hovered.toolbar);
  await shoot("toolbar-open");
  const OPEN = hovered.toolbar?.buttons ?? 0;
  say("the button keeps its width when the bar opens", Math.abs((hovered.toolbar?.handle?.box.width ?? 0) - rest.toolbar.handle!.box.width) < 0.5,
    { folded: rest.toolbar.handle!.box.width, open: hovered.toolbar?.handle?.box.width });
  // Across the icons, each crossing leaving one and entering the next, it stays open past the delay.
  const tools = page.locator("[data-gloom-role=composite-chart-toolbar] [data-gloom-role=composite-chart-tool]");
  for (const index of [0, 1, 2, 1, 0]) {
    const at = center((await tools.nth(index).boundingBox())!);
    await page.mouse.move(at.x, at.y, { steps: 4 });
    await settle(page, 60);
  }
  await settle(page, PAST_FOLD_DELAY);
  say("it stays open while the pointer moves from one icon to the next", (await layoutState(page)).toolbar?.folded === false, (await layoutState(page)).toolbar);
  // Off the bar it waits, then folds.
  await page.mouse.move(width - 2, HEIGHT - 2);
  await settle(page, 100);
  const leaving = await layoutState(page);
  await settle(page, PAST_FOLD_DELAY);
  const left = await layoutState(page);
  say("it stays open for a moment after the pointer leaves, then folds", leaving.toolbar?.folded === false && left.toolbar?.folded === true && left.toolbar.buttons === 1,
    { shortly: leaving.toolbar?.folded, later: left.toolbar?.folded });

  // The handle looks like the bar's other icon buttons: radius, height and hover fill.
  await page.mouse.move(handleAt(rest).x, handleAt(rest).y);
  await settle(page, 150);
  const look = await page.evaluate(() => {
    const read = (element: Element | null | undefined) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      return { radius: style.borderTopLeftRadius, height: Math.round(element.getBoundingClientRect().height * 10) / 10, background: style.backgroundColor, paddingInline: style.paddingLeft };
    };
    return {
      handle: read(document.querySelector("[data-gloom-role=composite-chart-toolbar-toggle]")),
      tool: read(document.querySelector("[data-gloom-role=composite-chart-tool]:not([data-active=true])")),
    };
  });
  const handlePoint = await page.locator("[data-gloom-role=composite-chart-toolbar-toggle]").boundingBox();
  const toolPoint = await page.locator("[data-gloom-role=composite-chart-tool][data-active=false]").first().boundingBox();
  await page.mouse.move(center(handlePoint!).x, center(handlePoint!).y);
  await settle(page, 100);
  const handleFill = await page.locator("[data-gloom-role=composite-chart-toolbar-toggle]").evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.mouse.move(center(toolPoint!).x, center(toolPoint!).y);
  await settle(page, 100);
  const toolFill = await page.locator("[data-gloom-role=composite-chart-tool][data-active=false]").first().evaluate((element) => getComputedStyle(element).backgroundColor);
  say("the button has the radius, height and padding of the bar's icon buttons, and their hover fill",
    !!look.handle && !!look.tool && look.handle.radius === look.tool.radius && look.handle.height === look.tool.height
      && look.handle.paddingInline === look.tool.paddingInline && handleFill === toolFill && handleFill !== "rgba(0, 0, 0, 0)",
    { ...look, handleFill, toolFill });
  await park(page, width);
  await settle(page, PAST_FOLD_DELAY);

  // Focus moved to it opens it, and focus leaving folds it (assistive technology's: Tab never reaches
  // it, the window keeps that key). A key press first, so the focus counts as the keyboard's
  // (a pressed button is focused by the pointer, and shows no ring).
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("data-gloom-role") ?? "");
  await page.keyboard.press("Shift");
  await page.locator("[data-gloom-role=composite-chart-toolbar-toggle]").focus();
  await settle(page, 100);
  const keyOpen = await layoutState(page);
  say("focus on the button opens the tool bar", await focused() === "composite-chart-toolbar-toggle" && keyOpen.toolbar?.folded === false, { focus: await focused(), toolbar: keyOpen.toolbar });
  await page.locator("[data-gloom-role=composite-chart-toolbar] [data-gloom-role=composite-chart-tool]").first().focus();
  await settle(page, PAST_FOLD_DELAY);
  say("it stays open while the focus is on its icons", (await layoutState(page)).toolbar?.folded === false && await focused() === "composite-chart-tool", await focused());
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page, 100);
  say("and folds once the focus leaves it", (await layoutState(page)).toolbar?.folded === true, (await layoutState(page)).toolbar);

  // A press on the button keeps the bar open, even at its right edge the moment the bar opens (the
  // pointer is on the edge of the folded button, not of one that has shrunk); the chevron that then
  // leads it folds it under the pointer.
  const edge = { x: rest.toolbar.handle!.box.x + rest.toolbar.handle!.box.width - 2, y: handleAt(rest).y };
  await page.mouse.move(edge.x, edge.y);
  await page.mouse.down();
  await page.mouse.up();
  await park(page, width);
  await settle(page, PAST_FOLD_DELAY);
  const pinned = await layoutState(page);
  say("a press at the button's right edge keeps the tool bar open after the pointer leaves", pinned.toolbar?.folded === false && pinned.toolbar.pinned && pinned.toolbar.buttons === OPEN,
    { open: OPEN, pinned: pinned.toolbar });
  say("its handle then reads as the one that hides it", /^Hide drawing tools/.test(pinned.toolbar?.handle?.label ?? ""), pinned.toolbar?.handle?.label);
  await page.mouse.move(handleAt(pinned).x, handleAt(pinned).y);
  await page.mouse.down();
  await page.mouse.up();
  await settle(page, 120);
  const unpinned = await layoutState(page);
  say("a press on it folds the bar at once, though the pointer is still on it", unpinned.toolbar?.folded === true && !unpinned.toolbar.pinned, unpinned.toolbar);
  // Moving across the button keeps it folded; leaving and coming back within the delay opens it.
  const across = handleAt(unpinned);
  for (const dx of [-5, 5, -5]) {
    await page.mouse.move(across.x + dx, across.y, { steps: 3 });
    await settle(page, 40);
  }
  await settle(page, 150);
  say("it stays folded while the pointer moves across the button", (await layoutState(page)).toolbar?.folded === true, (await layoutState(page)).toolbar);
  await page.mouse.move(width - 2, HEIGHT - 2);
  await settle(page, 100);
  await page.mouse.move(handleAt(rest).x, handleAt(rest).y);
  await settle(page, 150);
  say("and it opens when the pointer leaves and comes back within the delay", (await layoutState(page)).toolbar?.folded === false, (await layoutState(page)).toolbar);
  await park(page, width);
  await settle(page, PAST_FOLD_DELAY);
  const unfolded = await layoutState(page);
  say("the toolbar is folded again with the pointer away", unfolded.toolbar?.folded === true && unfolded.toolbar.buttons === 1, unfolded.toolbar);

  // The legend: its chevron under the pointer, folded to the first series and a count.
  const legendBox = (await page.locator("[data-gloom-role=composite-chart-legend]").boundingBox())!;
  await page.mouse.move(legendBox.x + legendBox.width / 2, legendBox.y + 4);
  await settle(page, 200);
  const legendHovered = await layoutState(page);
  say("the legend chevron shows with the pointer on the legend", legendHovered.legend?.toggleShown === true, legendHovered.legend?.toggleShown);
  await page.locator("[data-gloom-role=composite-chart-legend-toggle]").click();
  await park(page, width);
  const legendFolded = await layoutState(page);
  const count = legendFolded.legend?.text.match(/\+(\d+)/)?.[1];
  say("the chevron folds the legend to its first series and a count of the rest",
    legendFolded.legend?.collapsed === true && !!legendFolded.legend.more && Number(count) > 0 && legendFolded.legend.toggleShown,
    legendFolded.legend);
  await shoot("legend-folded");
  await page.mouse.click(center(legendFolded.legend!.more!).x, center(legendFolded.legend!.more!).y);
  await park(page, width);
  const legendOpen = await layoutState(page);
  say("the count opens the legend again", legendOpen.legend?.collapsed === false && legendOpen.legend.text === rest.legend.text,
    legendOpen.legend?.text);

  // A click on an entry still hides its series, and another shows it.
  const entry = () => page.locator("[data-gloom-role=composite-chart-legend-series]").nth(1);
  const entryLabel = (await entry().textContent())?.trim();
  await entry().click();
  await park(page, width);
  const hidden = await entry().getAttribute("data-visible");
  await entry().click();
  await park(page, width);
  const shownAgain = await entry().getAttribute("data-visible");
  say("a click on a legend entry still hides its series, and another shows it", hidden === "false" && shownAgain === "true", { entry: entryLabel, hidden, shownAgain });

  // The line between the price and volume panels: under the pointer, dragged, then double-clicked.
  const divider = rest.dividers[0]!.box;
  const plotX = rest.panels[0]!.box.x + rest.panels[0]!.box.width / 2;
  // A click on it that jitters a few pixels, past the host's drag threshold
  // but short of a row, keeps the split: the panels share a taller window as
  // they did, where a split saved in whole rows would not.
  const taller = async () => {
    await page.setViewportSize({ width, height: TALL_HEIGHT });
    await settle(page, 400);
    const state = heights(await layoutState(page));
    await page.setViewportSize({ width, height: HEIGHT });
    await settle(page, 400);
    return state;
  };
  const tallBefore = await taller();
  await page.mouse.move(plotX, center(divider).y);
  await page.mouse.down();
  for (const offset of [4, 5, 3]) {
    await page.mouse.move(plotX, center(divider).y + offset);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await park(page, width);
  const tallAfter = await taller();
  say("a click on the line that jitters a few pixels keeps the split", JSON.stringify(tallAfter) === JSON.stringify(tallBefore), { before: tallBefore, after: tallAfter });
  await page.mouse.move(plotX, center(divider).y);
  await settle(page, 200);
  const dividerHovered = await layoutState(page);
  say("the line between two panels shows with the pointer on it",
    dividerHovered.dividers[0]!.line === "1" && await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)!).cursor, { x: plotX, y: center(divider).y }) === "row-resize",
    dividerHovered.dividers[0]);
  await shoot("divider-hover");
  const pull = Math.round(rest.panels[0]!.box.height / 3);
  await drag(page, { x: plotX, y: center(divider).y }, { x: plotX, y: center(divider).y - pull });
  await park(page, width);
  const resized = await layoutState(page);
  const restHeights = heights(rest);
  const resizedHeights = heights(resized);
  say("dragging the line up gives the volume panel what the price panel gives up, and leaves RSI",
    resizedHeights.main! < restHeights.main! - pull / 2 && resizedHeights.Volume! > restHeights.Volume! + pull / 2 && Math.abs(resizedHeights.RSI! - restHeights.RSI!) <= 1
      && Math.abs(resizedHeights.main! + resizedHeights.Volume! - restHeights.main! - restHeights.Volume!) <= 1,
    { rest: restHeights, resized: resizedHeights });
  await shoot("panels-resized");
  const movedDivider = resized.dividers[0]!.box;
  await page.mouse.dblclick(plotX, center(movedDivider).y);
  await park(page, width);
  const split = await layoutState(page);
  say("a double-click on the line puts back the split", sameHeights(split, rest), { split: heights(split), rest: restHeights });

  // Shift+Up on the focused chart: the top panel a row taller.
  await page.mouse.click(plotX, rest.panels[0]!.box.y + 10);
  await page.keyboard.press("Escape");
  await page.mouse.click(plotX, rest.panels[0]!.box.y + 10);
  await page.keyboard.press("Shift+ArrowUp");
  await settle(page);
  const stepped = await layoutState(page);
  say("Shift+Up makes the top panel taller", heights(stepped).main! > restHeights.main!, heights(stepped));
  await page.keyboard.press("Shift+ArrowDown");
  await settle(page);
  say("Shift+Down gives it back", sameHeights(await layoutState(page), rest), heights(await layoutState(page)));
  // Shift+T keeps the bar open and lets it fold again; Shift+L folds the legend.
  await park(page, width);
  await settle(page, PAST_FOLD_DELAY);
  await page.keyboard.press("Shift+T");
  await settle(page, 150);
  const keyPinned = await layoutState(page);
  await page.keyboard.press("Shift+T");
  await page.keyboard.press("Shift+L");
  await settle(page, 150);
  const keyLegend = await layoutState(page);
  await page.keyboard.press("Shift+L");
  await settle(page);
  say("Shift+T keeps the tool bar open and again lets it fold, and Shift+L folds the legend",
    keyPinned.toolbar?.folded === false && keyPinned.toolbar.pinned && (await layoutState(page)).toolbar?.folded === true
      && keyLegend.legend?.collapsed === true && (await layoutState(page)).legend?.collapsed === false,
    { pinned: keyPinned.toolbar?.pinned, legend: keyLegend.legend?.collapsed });

  // A tool picked from the keys is the folded button's tool, and the bar stays folded.
  await settle(page, PAST_FOLD_DELAY);
  await page.keyboard.press("Shift+M");
  await settle(page, 150);
  const toolFolded = await layoutState(page);
  await shoot("toolbar-tool");
  say("a tool picked from the keys shows on the folded button, which names it",
    toolFolded.toolbar?.folded === true && toolFolded.toolbar.buttons === 1 && /^Ruler\b/.test(toolFolded.toolbar.handle?.label ?? ""),
    toolFolded.toolbar);
  await page.keyboard.press("Escape");
  await settle(page, 150);
  say("and the pan tool again once it is put down", /^Pan\b/.test((await layoutState(page)).toolbar?.handle?.label ?? ""), (await layoutState(page)).toolbar?.handle?.label);

  // A double-click on the RSI plot gives it the whole chart, and the way back.
  const rsi = rest.panels.find((panel) => panel.label === "RSI")!.box;
  await page.mouse.dblclick(rsi.x + rsi.width / 2, rsi.y + rsi.height / 2);
  await park(page, width);
  const maximized = await layoutState(page);
  const plotTotal = rest.panels.reduce((sum, panel) => sum + panel.box.height, 0);
  say("a double-click on the RSI plot gives it the whole chart",
    maximized.panels.length === 1 && maximized.panels[0]!.label === "RSI" && Math.abs(maximized.panels[0]!.box.height - plotTotal) <= 2 && maximized.dividers.length === 0,
    heights(maximized));
  say("it shows its All panels button, and the legend still reads every series",
    !!maximized.restore && maximized.legend?.text === rest.legend.text,
    { restore: maximized.restore, legend: maximized.legend?.text, rest: rest.legend.text });
  await shoot("maximized");
  await page.mouse.click(center(maximized.restore!).x, center(maximized.restore!).y);
  await park(page, width);
  const restored = await layoutState(page);
  say("the All panels button gives the others back", sameHeights(restored, rest) && !restored.restore, heights(restored));
  await page.mouse.dblclick(rsi.x + rsi.width / 2, rsi.y + rsi.height / 2);
  await settle(page);
  const again = await layoutState(page);
  const whole = again.panels[0]!.box;
  await page.mouse.dblclick(whole.x + whole.width / 2, whole.y + whole.height / 2);
  await park(page, width);
  say("as does another double-click", again.panels.length === 1 && sameHeights(await layoutState(page), rest), heights(await layoutState(page)));
  // A double-click on All panels: its first click brings the panels back, and
  // its second, landing on the plot under it, does not take the chart again.
  await page.mouse.dblclick(rsi.x + rsi.width / 2, rsi.y + rsi.height / 2);
  await park(page, width);
  const remaximized = await layoutState(page);
  await humanDoubleClick(page, center(remaximized.restore!));
  await park(page, width);
  const doubleRestored = await layoutState(page);
  say("a double-click on All panels gives the others back and keeps them", remaximized.panels.length === 1
    && sameHeights(doubleRestored, rest) && !doubleRestored.restore, heights(doubleRestored));

  // A drag on the plot still pans (to older bars: the view starts at the newest), and gives no panel the chart.
  const price = rest.panels[0]!.box;
  await drag(page, { x: price.x + price.width * 0.3, y: price.y + price.height / 2 }, { x: price.x + price.width * 0.6, y: price.y + price.height / 2 });
  const panned = await layoutState(page);
  say("a drag on the plot still pans", panned.view !== rest.view && panned.panels.length === 3, { rest: rest.view, panned: panned.view });
}

/** The chart at rest on the base, in the same browser and width, for the comparison and the sheet. */
async function shootBase(browser: "chromium" | "webkit", width: number, page: Page, url: URL) {
  await open(page, url);
  await park(page, width);
  await picture(page, shotPath("before", browser, width, "rest"));
  const toolbar = (await layoutState(page)).toolbar;
  if (toolbar) baseToolbar.set(`${browser}-${width}`, toolbar.box);
}

function sheetFont(): string[] {
  const fonts = Bun.spawnSync(["convert", "-list", "font"]).stdout.toString();
  const font = ["JetBrains-Mono-Regular", "DejaVu-Sans-Mono", "Liberation-Mono"].find((name) => fonts.includes(`Font: ${name}\n`));
  return font ? ["-font", font] : [];
}

/** Per browser: a row per width, the base at rest, then this tree at rest and in each new state. */
function contactSheet(browser: string): string | null {
  const font = sheetFont();
  const work = join(out, ".sheet");
  const rows: string[] = [];
  for (const width of widths) {
    const cells = [
      ...(base ? [["before (base) at rest", shotPath("before", browser, width, "rest")]] : []),
      ...STATES.map((state) => [`after: ${state}`, shotPath("after", browser, width, state)]),
    ].filter(([, file]) => existsSync(file!));
    if (cells.length === 0) continue;
    const scale = width >= 1000 ? "40%" : "60%";
    const labelled = cells.map(([label, file], index) => {
      const cell = join(work, `${browser}-${width}-${index}.png`);
      Bun.spawnSync(["convert", "-background", "#1b1b1b", "-fill", "#e6e6e6", ...font, "-pointsize", "14", `label:${width}px  ${label}`, "(", file!, "-resize", scale, ")", "-gravity", "west", "-append", "+repage", cell]);
      return cell;
    });
    const row = join(work, `${browser}-${width}.png`);
    Bun.spawnSync(["convert", "-background", "#1b1b1b", ...labelled.flatMap((cell) => [cell, "(", "-size", "12x12", "xc:#1b1b1b", ")"]), "+append", "+repage", row]);
    rows.push(row);
  }
  if (rows.length === 0) return null;
  const sheet = join(out, `sheet-${browser}.jpg`);
  Bun.spawnSync(["convert", "-background", "#1b1b1b", ...rows, "-splice", "0x14", "-append", "+repage", "-quality", "88", sheet]);
  return sheet;
}

await mkdir(join(out, "after"), { recursive: true });
await mkdir(join(out, ".sheet"), { recursive: true });
if (base) {
  await mkdir(join(out, "before"), { recursive: true });
  const fixture = await serveFixturePage(base, join(out, "page-base"), { ownFixtureFallback: true });
  try {
    for (const browser of browsers) {
      for (const width of widths) {
        const context = await launch(browser, width);
        try {
          await shootBase(browser, width, context.pages()[0] ?? await context.newPage(), fixture.url);
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await fixture.close();
  }
}
const fixture = await serveFixturePage(root, join(out, "page"));
try {
  for (const browser of browsers) {
    for (const width of widths) {
      const context = await launch(browser, width);
      try {
        const page = context.pages()[0] ?? await context.newPage();
        // The desktop app takes a ResizeObserver loop notice as benign (renderer-window-error.ts); WebKit raises one as panels resize.
        page.on("pageerror", (error) => {
          if (!/ResizeObserver loop/.test(error.message)) check(browser, width, "page error", false, error.message);
        });
        await exercise(browser, width, page, fixture.url);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await fixture.close();
}
const sheets = browsers.map(contactSheet).filter((sheet): sheet is string => !!sheet);
await rm(join(out, ".sheet"), { recursive: true, force: true });
await rm(join(out, "profiles"), { recursive: true, force: true });
await Bun.write(join(out, "report.json"), JSON.stringify({ checks, shots, sheets }, null, 2));
const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed; pictures and sheets in ${out}`);
if (failed.length > 0) process.exit(1);
