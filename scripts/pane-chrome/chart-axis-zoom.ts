import { mkdir, rm } from "fs/promises";
import { join, resolve } from "path";
import type { BrowserContext, Page } from "playwright-core";
import { takeOption } from "../tui-benchmark-harness";
import { cacheDir } from "./browser";
import { serveFixturePage } from "./page";

/**
 * Axis zoom on the composite chart in Chromium and WebKit, with
 * the real pointer on the chart composer fixture (`scenario=cmp&chart=readout`:
 * a price panel, a volume panel and an RSI panel). In each browser it drags
 * the price axis up and checks the price panel alone is scaled by hand and
 * says so; scrolls over the RSI axis and checks that panel scales; drags the
 * plot and checks the hand-scaled values move with it; double-clicks the price
 * axis and presses the RSI panel's Auto, and checks both fit again as they
 * were; drags the time axis and checks time zooms from the newest bar, and a
 * double-click returns it; pinches (Chromium's own pinch, WebKit's gesture
 * events) and checks time zooms around the pointer; and checks a drag on the
 * plot still pans time without scaling values. It pictures the chart before,
 * with the price and RSI panels scaled, and after the reset.
 *
 *   bun run check:chart-axis-zoom [--out <dir>] [--root <checkout>] [--browsers chromium,webkit]
 *
 * Needs playwright-core's Chromium and WebKit
 * (`bunx playwright-core install chromium webkit`). Pictures and
 * `report.json` land in `--out` (default under the pane chrome cache).
 */

const args = process.argv.slice(2);
const root = resolve(takeOption(args, "--root") ?? join(import.meta.dir, "../.."));
const out = resolve(takeOption(args, "--out") ?? cacheDir("chart-axis-zoom"));
const browsers = (takeOption(args, "--browsers") ?? "chromium,webkit").split(",") as Array<"chromium" | "webkit">;
const WIDTH = 1280;
const HEIGHT = 800;

interface Check { browser: string; name: string; ok: boolean; detail: string }
const checks: Check[] = [];
const shots: string[] = [];

interface Box { x: number; y: number; width: number; height: number }
interface ChartState {
  view: [number, number] | null;
  panels: Record<string, { box: Box; scale: string; axis: Box | null; ticks: string; auto: Box | null }>;
  timeAxis: Box | null;
}

function check(browser: string, name: string, ok: boolean, detail: unknown) {
  checks.push({ browser, name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
  console.log(`${ok ? "ok  " : "FAIL"} ${browser.padEnd(8)} ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function launch(name: "chromium" | "webkit"): Promise<BrowserContext> {
  const engines = await import("playwright-core");
  const profile = join(out, "profiles", name);
  await rm(profile, { recursive: true, force: true });
  return engines[name].launchPersistentContext(profile, { headless: true, viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
}

/** Each panel by its label, with its left value axis, the ticks on it, and its Auto button while scaled by hand. */
const chartState = (page: Page) => page.evaluate((): ChartState => {
  const box = (element: Element | null | undefined) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const view = document.querySelector<HTMLElement>("[data-gloom-role=composite-chart]")?.dataset.gloomView?.split(":").map(Number);
  const axes = Array.from(document.querySelectorAll<HTMLElement>("[data-gloom-role=composite-chart-value-axis][data-gloom-side=left]"));
  const panels: ChartState["panels"] = {};
  for (const panel of Array.from(document.querySelectorAll<HTMLElement>("[data-gloom-role=composite-chart-panel]"))) {
    const rect = panel.getBoundingClientRect();
    const axis = axes.find((candidate) => Math.abs(candidate.getBoundingClientRect().y - rect.y) < 2);
    const auto = Array.from(document.querySelectorAll("[data-gloom-role=composite-chart-value-scale]"))
      .find((candidate) => { const r = candidate.getBoundingClientRect(); return r.y >= rect.y - 1 && r.y + r.height <= rect.y + rect.height + 1; });
    panels[panel.dataset.gloomLabel ?? "?"] = {
      box: box(panel)!,
      scale: panel.dataset.gloomValueScale ?? "auto",
      axis: box(axis),
      ticks: Array.from(axis?.querySelectorAll("*") ?? []).filter((node) => node.children.length === 0).map((node) => node.textContent?.trim()).filter(Boolean).join(" "),
      auto: box(auto?.querySelector("button") ?? auto),
    };
  }
  return {
    view: view && view.length === 2 ? [view[0]!, view[1]!] : null,
    panels,
    timeAxis: box(document.querySelector("[data-gloom-role=composite-chart-time-scale]")),
  };
});

const cursorReadout = (page: Page) => page.evaluate(() => document.querySelector("[data-gloom-role=chart-time-axis]")?.textContent?.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)?.[0] ?? null);
const span = (state: ChartState) => state.view ? state.view[1] - state.view[0] : Number.NaN;
const settle = (page: Page, ms = 300) => page.waitForTimeout(ms);

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step++) {
    await page.mouse.move(from.x + (to.x - from.x) * step / steps, from.y + (to.y - from.y) * step / steps);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  await settle(page);
}

/** A trackpad pinch: Chromium's own, which it sends as Ctrl+wheel; WebKit's gesture events, as Safari sends them. */
async function pinch(browser: "chromium" | "webkit", page: Page, at: { x: number; y: number }, scale: number) {
  if (browser === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.synthesizePinchGesture", { x: at.x, y: at.y, scaleFactor: scale, relativeSpeed: 400, gestureSourceType: "mouse" } as never);
    await cdp.detach();
  } else {
    await page.mouse.move(at.x, at.y);
    await page.evaluate(async ({ x, y, scale }) => {
      const target = document.elementFromPoint(x, y)!;
      const fire = (type: string, value: number) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { scale: value, rotation: 0, clientX: x, clientY: y });
        target.dispatchEvent(event);
      };
      fire("gesturestart", 1);
      for (let step = 1; step <= 10; step++) {
        fire("gesturechange", 1 + (scale - 1) * step / 10);
        await new Promise((done) => requestAnimationFrame(done));
      }
      fire("gestureend", scale);
    }, { ...at, scale });
  }
  await settle(page, 500);
}

async function picture(page: Page, browser: string, name: string) {
  const file = join(out, `${browser}-${name}.png`);
  await page.mouse.move(WIDTH - 2, HEIGHT - 2);
  await settle(page, 200);
  await page.screenshot({ path: file });
  shots.push(file);
}

async function exercise(browser: "chromium" | "webkit", page: Page, url: URL) {
  const target = new URL(url);
  target.search = "?scenario=cmp&chart=readout";
  await page.goto(target.href, { waitUntil: "load" });
  await page.waitForFunction(() => !!document.querySelector("[data-gloom-role=composite-chart]")?.getAttribute("data-gloom-view")
    && document.querySelectorAll("[data-gloom-role=composite-chart-panel] canvas").length > 0, undefined, { timeout: 20_000 });
  await settle(page, 800);
  const start = await chartState(page);
  const price = start.panels.main;
  const rsi = start.panels.RSI;
  if (!price?.axis || !rsi?.axis || !start.timeAxis || !start.view) {
    check(browser, "the fixture chart has a price panel, an RSI panel and a time axis", false, start);
    return;
  }
  await picture(page, browser, "1-before");

  // The price axis dragged up stretches the price panel, and that panel alone.
  const priceAxis = { x: price.axis.x + price.axis.width / 2, y: price.box.y + price.box.height / 2 };
  await drag(page, priceAxis, { x: priceAxis.x, y: priceAxis.y - 120 });
  const stretched = await chartState(page);
  check(browser, "dragging the price axis up scales the price panel by hand",
    stretched.panels.main?.scale === "manual" && stretched.panels.main.ticks !== price.ticks,
    { before: price.ticks, after: stretched.panels.main?.ticks });
  check(browser, "the other panels and time stay as they were",
    stretched.panels.RSI?.scale === "auto" && stretched.panels.Volume?.scale === "auto" && stretched.view?.join() === start.view.join(),
    { rsi: stretched.panels.RSI?.scale, volume: stretched.panels.Volume?.scale, view: stretched.view });
  check(browser, "a hand-scaled panel shows Auto at the foot of its axis", !!stretched.panels.main?.auto && !start.panels.main?.auto, stretched.panels.main?.auto);

  // A scroll over the RSI axis zooms that panel's values.
  const rsiAxis = { x: rsi.axis.x + rsi.axis.width / 2, y: rsi.box.y + rsi.box.height / 2 };
  await page.mouse.move(rsiAxis.x, rsiAxis.y);
  for (let step = 0; step < 4; step++) {
    await page.mouse.wheel(0, 40);
    await page.waitForTimeout(50);
  }
  await settle(page);
  const squeezed = await chartState(page);
  check(browser, "scrolling over the RSI axis scales the RSI panel by hand",
    squeezed.panels.RSI?.scale === "manual" && squeezed.panels.RSI.ticks !== rsi.ticks && squeezed.view?.join() === start.view.join(),
    { before: rsi.ticks, after: squeezed.panels.RSI?.ticks, view: squeezed.view });
  await picture(page, browser, "2-price-and-rsi-scaled");

  // The plot dragged down moves the hand-scaled values with it.
  const plot = { x: price.box.x + price.box.width * 0.5, y: price.box.y + price.box.height * 0.6 };
  await drag(page, plot, { x: plot.x, y: plot.y + 80 }, 8);
  const panned = await chartState(page);
  check(browser, "dragging a hand-scaled plot moves its values", panned.panels.main?.ticks !== squeezed.panels.main?.ticks,
    { before: squeezed.panels.main?.ticks, after: panned.panels.main?.ticks });

  // A double-click on the price axis fits the price panel again; Auto fits the RSI panel.
  await page.mouse.dblclick(priceAxis.x, priceAxis.y);
  await settle(page);
  const priceReset = await chartState(page);
  check(browser, "a double-click on the price axis fits the price panel again",
    priceReset.panels.main?.scale === "auto" && priceReset.panels.main.ticks === price.ticks && priceReset.panels.RSI?.scale === "manual",
    { ticks: priceReset.panels.main?.ticks, rsi: priceReset.panels.RSI?.scale });
  const auto = priceReset.panels.RSI?.auto;
  if (auto) await page.mouse.click(auto.x + auto.width / 2, auto.y + auto.height / 2);
  await settle(page);
  const reset = await chartState(page);
  check(browser, "Auto fits the RSI panel again", !!auto && reset.panels.RSI?.scale === "auto" && reset.panels.RSI.ticks === rsi.ticks && !reset.panels.RSI.auto,
    { ticks: reset.panels.RSI?.ticks });
  await picture(page, browser, "3-reset");

  // The time axis dragged left zooms time in from the newest bar; a double-click returns it.
  const timeAxis = { x: start.timeAxis.x + start.timeAxis.width * 0.6, y: start.timeAxis.y + start.timeAxis.height / 2 };
  await drag(page, timeAxis, { x: timeAxis.x - 150, y: timeAxis.y }, 10);
  const timeZoomed = await chartState(page);
  check(browser, "dragging the time axis left zooms time in from the newest bar",
    span(timeZoomed) < span(start) * 0.7 && timeZoomed.view?.[1] === start.view[1],
    { start: start.view, zoomed: timeZoomed.view });
  await page.mouse.dblclick(timeAxis.x, timeAxis.y);
  await settle(page);
  const timeReset = await chartState(page);
  check(browser, "a double-click on the time axis returns the view", timeReset.view?.join() === start.view.join(), timeReset.view);

  // A pinch zooms time around the pointer.
  const at = { x: price.box.x + price.box.width * 0.3, y: price.box.y + price.box.height * 0.5 };
  await page.mouse.move(at.x, at.y);
  await settle(page, 150);
  const underBefore = await cursorReadout(page);
  await pinch(browser, page, at, 2);
  await page.mouse.move(at.x, at.y);
  await settle(page, 150);
  const underAfter = await cursorReadout(page);
  const pinched = await chartState(page);
  const ratio = span(start) / span(pinched);
  // The bars under the pointer stay there, to within a pixel or two of time.
  const drift = underBefore && underAfter ? Math.abs(Date.parse(`${underAfter}Z`) - Date.parse(`${underBefore}Z`)) : Number.NaN;
  const pixelTime = span(pinched) / price.box.width;
  check(browser, "a pinch zooms time about twofold around the pointer",
    ratio > 1.8 && ratio < 2.2 && drift <= pixelTime * 2 && Object.values(pinched.panels).every((panel) => panel.scale === "auto"),
    { ratio: Number(ratio.toFixed(3)), underBefore, underAfter, pixelMinutes: Math.round(pixelTime / 60_000) });

  // A drag across the plot still pans time, and leaves the values fitted.
  await drag(page, { x: at.x + 200, y: at.y }, { x: at.x + 400, y: at.y }, 10);
  const timePanned = await chartState(page);
  check(browser, "a drag across the plot still pans time and scales no values",
    !!timePanned.view && !!pinched.view && timePanned.view[0] < pinched.view[0] && Object.values(timePanned.panels).every((panel) => panel.scale === "auto"),
    { before: pinched.view, after: timePanned.view });
}

await mkdir(out, { recursive: true });
const fixture = await serveFixturePage(root, join(out, "page"));
try {
  for (const browser of browsers) {
    const context = await launch(browser);
    try {
      const page = context.pages()[0] ?? await context.newPage();
      page.on("pageerror", (error) => check(browser, "page error", false, error.message));
      await exercise(browser, page, fixture.url);
    } finally {
      await context.close();
    }
  }
} finally {
  await fixture.close();
}
await Bun.write(join(out, "report.json"), JSON.stringify({ checks, shots }, null, 2));
const failed = checks.filter((entry) => !entry.ok);
console.log(`\n${checks.length - failed.length} of ${checks.length} checks passed; pictures in ${out}`);
if (failed.length > 0) process.exit(1);
