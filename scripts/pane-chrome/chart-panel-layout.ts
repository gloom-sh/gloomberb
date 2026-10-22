import { existsSync } from "fs";
import { mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import type { BrowserContext, Page } from "playwright-core";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir } from "./browser";
import { serveFixturePage } from "./page";
import { pixelChange } from "./ui-audit-compare";

/**
 * The composite chart's own layout in Chromium and WebKit (GLO-1215), with the
 * real pointer on the chart composer fixture (`scenario=cmp&chart=readout`: a
 * price panel, a volume panel and an RSI panel), at 640 and 1280 px. In each
 * browser and width it checks that at rest the chart draws as the base does
 * (`--base`, pixel for pixel within ImageMagick's 2% fuzz) and shows none of
 * the new controls; that the drawing tool bar's fold button shows under the
 * pointer and folds the bar to the one button that opens it again, as Shift+T
 * does; that the legend's chevron shows under the pointer and folds the legend
 * to its first series and a count of the rest, which opens it again, as
 * Shift+L does, and a click on an entry still hides its series; that the line
 * between two panels shows under the pointer, a drag on it moves it and a
 * double-click puts back the split; that Shift+Up makes the top panel taller;
 * that a double-click on the RSI plot gives it the whole chart, with its
 * `All panels` button and every series still read in the legend, and the
 * button or another double-click gives the others back; and that a drag on the
 * plot still pans. It pictures each state, and writes a contact sheet per
 * browser: before and after at rest, then each new state, a row per width.
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
const STATES = ["rest", "toolbar-hidden", "legend-folded", "divider-hover", "panels-resized", "maximized"] as const;

interface Check { browser: string; width: number; name: string; ok: boolean; detail: string }
const checks: Check[] = [];
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
  return engines[name].launchPersistentContext(profile, { headless: true, viewport: { width, height: HEIGHT }, deviceScaleFactor: 1 });
}

interface Box { x: number; y: number; width: number; height: number }
interface LayoutState {
  view: string | null;
  panels: { label: string; box: Box }[];
  /** Each line between two panels, with the opacity its drawn line has. */
  dividers: { box: Box; line: string }[];
  toolbar: { box: Box; folded: boolean; buttons: number; foldShown: boolean } | null;
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
  const fold = toolbar?.querySelector("[data-gloom-role=composite-chart-toolbar-toggle]");
  return {
    view: document.querySelector<HTMLElement>("[data-gloom-role=composite-chart]")?.dataset.gloomView ?? null,
    panels: Array.from(document.querySelectorAll<HTMLElement>("[data-gloom-role=composite-chart-panel]"))
      .map((panel) => ({ label: panel.dataset.gloomLabel ?? "?", box: box(panel)! })),
    dividers: Array.from(document.querySelectorAll("[data-gloom-role=composite-chart-panel-divider]"))
      .map((divider) => ({ box: box(divider)!, line: getComputedStyle(divider, "::before").opacity })),
    toolbar: toolbar ? {
      box: box(toolbar)!,
      folded: toolbar.dataset.folded === "true",
      buttons: Array.from(toolbar.querySelectorAll("button, [role=button]")).filter((button) => shown(button)).length,
      foldShown: shown(fold),
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
  say("at rest the fold button, the legend chevron and the panel lines are not drawn",
    !rest.toolbar.foldShown && !rest.legend.toggleShown && rest.dividers.length === 2 && rest.dividers.every((divider) => divider.line === "0"),
    { fold: rest.toolbar.foldShown, chevron: rest.legend.toggleShown, lines: rest.dividers.map((divider) => divider.line) });
  if (base) {
    const before = shotPath("before", browser, width, "rest");
    const compared = existsSync(before) ? pixelChange(before, shotPath("after", browser, width, "rest")) : { status: "error" as const, error: "no base picture" };
    say("at rest the chart draws as the base does", compared.status === "compared" && compared.change === 0, compared);
  }

  // The tool bar: its fold button under the pointer, and folded, the one button back.
  await page.mouse.move(rest.toolbar.box.x + 6, rest.toolbar.box.y + rest.toolbar.box.height / 2);
  await settle(page, 200);
  const hovered = await layoutState(page);
  say("the fold button shows with the pointer on the tool bar", hovered.toolbar?.foldShown === true, hovered.toolbar);
  await page.locator("[data-gloom-role=composite-chart-toolbar] [data-gloom-role=composite-chart-toolbar-toggle]").click();
  await park(page, width);
  const folded = await layoutState(page);
  say("the fold button folds the tool bar to the button that opens it",
    folded.toolbar?.folded === true && folded.toolbar.buttons === 1 && folded.toolbar.box.width < rest.toolbar.box.width / 3,
    { before: rest.toolbar, after: folded.toolbar });
  await shoot("toolbar-hidden");
  await page.locator("[data-gloom-role=composite-chart-toolbar] [data-gloom-role=composite-chart-toolbar-toggle]").click();
  await park(page, width);
  const unfolded = await layoutState(page);
  say("that button opens the tool bar again", unfolded.toolbar?.folded === false && unfolded.toolbar.buttons === rest.toolbar.buttons,
    unfolded.toolbar);

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
  const taller = await layoutState(page);
  say("Shift+Up makes the top panel taller", heights(taller).main! > restHeights.main!, heights(taller));
  await page.keyboard.press("Shift+ArrowDown");
  await settle(page);
  say("Shift+Down gives it back", sameHeights(await layoutState(page), rest), heights(await layoutState(page)));
  await page.keyboard.press("Shift+T");
  await settle(page);
  const keyFolded = await layoutState(page);
  await page.keyboard.press("Shift+T");
  await page.keyboard.press("Shift+L");
  await settle(page);
  const keyLegend = await layoutState(page);
  await page.keyboard.press("Shift+L");
  await settle(page);
  say("Shift+T folds the tool bar and Shift+L the legend", keyFolded.toolbar?.folded === true && keyLegend.legend?.collapsed === true
    && (await layoutState(page)).legend?.collapsed === false, { toolbar: keyFolded.toolbar?.folded, legend: keyLegend.legend?.collapsed });

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
