import { mkdir } from "fs/promises";
import { join } from "path";
import { cacheDir, evaluate, frames, mouse, type Cdp } from "./browser";

interface Expected { id: string; panel: string; side: string; value: number; label: string; ratio: number; color: string; carried: boolean }
interface Rect { x: number; y: number; width: number; height: number }

async function checkReadout(cdp: Cdp): Promise<void> {
  const result = await evaluate<{ expected: Expected[]; failures: string[] }>(cdp, `(() => {
    const expected = window.__axisReadout?.expected ?? [];
    const tags = [...document.querySelectorAll('[data-gloom-role=chart-series-axis-tag]')];
    const failures = [];
    if (!expected.length || tags.length !== expected.length) failures.push('expected ' + expected.length + ' tags, found ' + tags.length);
    for (const entry of expected) {
      const tag = tags.find(tag => tag.dataset.seriesId === entry.id);
      const anchor = [...document.querySelectorAll('[data-gloom-role=chart-series-axis-anchor]')].find(node => node.dataset.seriesId === entry.id);
      const plot = [...document.querySelectorAll('[data-gloom-role=composite-chart-panel]')].find(node => node.dataset.gloomLabel === entry.panel);
      if (!tag || !anchor || !plot) { failures.push(entry.id + ': missing tag/anchor/plot'); continue; }
      if (tag.dataset.value !== String(entry.value) || tag.textContent.trim() !== entry.label) failures.push(entry.id + ': wrong observation ' + tag.textContent);
      if (tag.dataset.side !== entry.side) failures.push(entry.id + ': wrong axis');
      if ((tag.dataset.carried === 'true') !== entry.carried) failures.push(entry.id + ': wrong carried state');
      const p = plot.getBoundingClientRect(), a = anchor.getBoundingClientRect(), t = tag.getBoundingClientRect();
      const y = p.y + Math.max(p.height - 1, 0) * entry.ratio;
      if (Math.abs(a.y - y) > 1) failures.push(entry.id + ': anchor ' + a.y + ' != projected ' + y);
      if (t.y < p.y - 1 || t.bottom > p.bottom + 1) failures.push(entry.id + ': tag outside panel');
      const isolated = expected.every(other => other.id === entry.id || other.panel !== entry.panel || other.side !== entry.side || Math.abs(other.ratio - entry.ratio) * (p.height - 1) >= t.height);
      if (isolated && y >= p.y + t.height/2 && y <= p.bottom - t.height/2 && Math.abs(t.y + t.height/2 - y) > 1) failures.push(entry.id + ': unobstructed tag is not at its projected height');
      if (entry.side === 'left' ? t.right > p.x + 1 : t.left < p.right - 1) failures.push(entry.id + ': tag on plot, not axis');
      if (tag.scrollWidth > tag.clientWidth + 1) failures.push(entry.id + ': clipped value');
      const probe = document.createElement('span'); probe.style.color = entry.color; document.body.append(probe);
      if (getComputedStyle(tag).color !== getComputedStyle(probe).color) failures.push(entry.id + ': wrong series colour');
      probe.remove();
    }
    for (let i = 0; i < tags.length; i++) for (const other of tags.slice(i + 1)) {
      const a = tags[i].getBoundingClientRect(), b = other.getBoundingClientRect();
      if (Math.min(a.right,b.right)-Math.max(a.left,b.left) > 1 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top) > 1) failures.push('overlapping tags');
    }
    const xs = [...document.querySelectorAll('[data-gloom-role=chart-crosshair-x]')].map(node => node.getBoundingClientRect().x);
    if (!xs.length || xs.some(x => Math.abs(x - xs[0]) > 1)) failures.push('unaligned shared crosshair');
    if (!document.querySelector('[data-gloom-role=chart-time-axis][data-gloom-cursor]')) failures.push('missing date tag');
    if (document.querySelector('[data-gloom-role=composite-chart-cursor]')) failures.push('floating popup');
    return { expected, failures };
  })()`);
  if (result.failures.length) throw new Error(JSON.stringify(result));
}

async function plots(cdp: Cdp): Promise<Rect[]> {
  return evaluate(cdp, `[...document.querySelectorAll('[data-gloom-role=composite-chart-panel]')].map(node => { const r = node.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })`);
}

/** Every pixel of the page, as the encoded image: equal strings are equal pictures. */
async function picture(cdp: Cdp): Promise<string> {
  return (await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" })).data;
}

interface LevelReadout {
  /** Horizontal level lines, one entry per chart panel. */
  lines: boolean[];
  /** The pointer-height value tags on the axes, with where their centres sit on the page and how tall they are. */
  values: Array<{ text: string; y: number; height: number }>;
  seriesTags: number;
  measure: string | null;
}

async function levelReadout(cdp: Cdp): Promise<LevelReadout> {
  return evaluate(cdp, `(() => ({
    lines: [...document.querySelectorAll('[data-gloom-role=composite-chart-panel]')].map(plot => !!plot.querySelector('[data-gloom-role=chart-crosshair-y]')),
    values: [...document.querySelectorAll('[data-gloom-role=chart-price-axis-cursor]')].map(tag => { const r = tag.getBoundingClientRect(); return { text: tag.textContent.trim(), y: r.y + r.height / 2, height: r.height }; }),
    seriesTags: document.querySelectorAll('[data-gloom-role=chart-series-axis-tag]').length,
    measure: document.querySelector('[data-gloom-role=composite-chart-measure]')?.textContent ?? null,
  }))()`);
}

/**
 * The pointer over panel `panel` of `plot` at `at`: that panel draws the level
 * line, and the value at the pointer's height sits on the axis there (kept
 * inside the panel at its edges); no other panel draws one. The series tags
 * stay beside it.
 */
async function checkHoverLevel(cdp: Cdp, panel: number, plot: Rect, at: { y: number }, label = "hover"): Promise<LevelReadout> {
  return assertHoverLevel(await levelReadout(cdp), panel, plot, at, label);
}

function assertHoverLevel(level: LevelReadout, panel: number, plot: Rect, at: { y: number }, label = "hover"): LevelReadout {
  const expected = level.lines.map((_, index) => index === panel);
  if (JSON.stringify(level.lines) !== JSON.stringify(expected)) throw new Error(`Panel ${panel}: ${label} did not draw one level line there ${JSON.stringify(level)}`);
  const atHeight = (value: { y: number; height: number }) => Math.abs(value.y - Math.min(Math.max(at.y, plot.y + value.height / 2), plot.y + plot.height - value.height / 2)) <= 3;
  if (!level.values.length || level.values.some((value) => !value.text || !atHeight(value))) {
    throw new Error(`Panel ${panel}: ${label} shows no value at the pointer's height on the axis ${JSON.stringify({ at, level })}`);
  }
  if (level.seriesTags < 2) throw new Error(`Panel ${panel}: ${label} lost the series tags ${JSON.stringify(level)}`);
  return level;
}

/** Moves the pointer to two heights in the plot, in the same column, and reads the chart at each. */
async function atTwoHeights(cdp: Cdp, plot: Rect, share: number): Promise<Array<{ at: { x: number; y: number }; level: LevelReadout; picture: string }>> {
  const reads = [];
  for (const height of [0.25, 0.75]) {
    const at = { x: plot.x + share * (plot.width - 1), y: plot.y + plot.height * height };
    await mouse(cdp, "mouseMoved", at.x, at.y, false); await frames(cdp, 4);
    reads.push({ at, level: await levelReadout(cdp), picture: await picture(cdp) });
  }
  return reads;
}

async function pressTool(cdp: Cdp, label: string): Promise<void> {
  const at = await evaluate<{ x: number; y: number } | null>(cdp, `(() => {
    const chip = [...document.querySelectorAll('[data-gloom-role=composite-chart-tool]')].find(node => (node.getAttribute('data-gloom-label') ?? '').startsWith(${JSON.stringify(label)}));
    const r = chip?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  })()`);
  if (!at) throw new Error(`No ${label} tool in the chart toolbar`);
  await mouse(cdp, "mouseMoved", at.x, at.y, false);
  await mouse(cdp, "mousePressed", at.x, at.y, true);
  await mouse(cdp, "mouseReleased", at.x, at.y, false);
  await frames(cdp, 3);
}

const toolSteps = ["desktop", "browser"].flatMap((host) => [640, 1280].flatMap((width) => ["three", "stacked"].map((kind) => ({
  name: `series axis tags: ${host} ${width} hover and tools place a level (${kind})`,
  scenario: `axis&axis=${kind}&host=${host}&theme=white&float=0&short=0`,
  async run(cdp: Cdp) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await frames(cdp, 8);
    try {
      let panels = await plots(cdp);
      if (!panels.length) throw new Error("No plotted fixture");
      // An ordinary hover and an armed tool both place a level: the line follows the pointer in
      // the panel it is in, and its value sits on the axis at that height, beside the series tags.
      for (const tool of [null, "Ruler"] as const) {
        if (tool) {
          await pressTool(cdp, tool);
          // The armed tool's key hint can move the plot.
          panels = await plots(cdp);
        }
        for (const [index, plot] of panels.entries()) {
          const [high, low] = await atTwoHeights(cdp, plot, 0.44);
          for (const read of [high!, low!]) assertHoverLevel(read.level, index, plot, read.at, tool ?? "hover");
          if (high!.picture === low!.picture) throw new Error(`Panel ${index}: the level line did not follow the pointer (${tool ?? "hover"})`);
          if (high!.level.values.map((value) => value.text).join() === low!.level.values.map((value) => value.text).join()) throw new Error(`Panel ${index}: the axis value did not follow the pointer (${tool ?? "hover"})`);
        }
      }
      // A measure drag keeps its readout, and its end reads its level on the axis.
      const plot = panels[0]!;
      const from = { x: plot.x + plot.width * 0.3, y: plot.y + plot.height * 0.7 };
      const to = { x: plot.x + plot.width * 0.6, y: plot.y + plot.height * 0.3 };
      await mouse(cdp, "mouseMoved", from.x, from.y, false);
      await mouse(cdp, "mousePressed", from.x, from.y, true); await frames(cdp, 2);
      for (let step = 1; step <= 8; step++) { await mouse(cdp, "mouseMoved", from.x + (to.x - from.x) * step / 8, from.y + (to.y - from.y) * step / 8, true); await frames(cdp, 1); }
      const held = await levelReadout(cdp);
      await mouse(cdp, "mouseReleased", to.x, to.y, false); await frames(cdp, 3);
      if (!held.measure || !held.lines[0] || !held.values.length || held.values.some((value) => Math.abs(value.y - to.y) > 3)) {
        throw new Error(`A dragged measure lost its readout, level line or axis value ${JSON.stringify(held)}`);
      }
      // Back to the resting pointer: an ordinary hover, its level still under the pointer.
      await pressTool(cdp, "Pan");
      const rest = (await plots(cdp))[0]!;
      const [, restLow] = await atTwoHeights(cdp, rest, 0.44);
      await checkHoverLevel(cdp, 0, rest, restLow!.at);
      // Alt held on the press is a measure without a tool armed: the drag reads out, the hover after does not.
      const alt = (type: "mousePressed" | "mouseMoved" | "mouseReleased", at: { x: number; y: number }, held: boolean) => cdp.send("Input.dispatchMouseEvent", {
        type, x: at.x, y: at.y, modifiers: 1, button: type === "mouseMoved" && !held ? "none" : "left", buttons: held ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1,
      });
      await alt("mouseMoved", from, false);
      await alt("mousePressed", from, true); await frames(cdp, 2);
      for (let step = 1; step <= 8; step++) { await alt("mouseMoved", { x: from.x + (to.x - from.x) * step / 8, y: from.y + (to.y - from.y) * step / 8 }, true); await frames(cdp, 1); }
      const modified = await levelReadout(cdp);
      await alt("mouseReleased", to, false); await frames(cdp, 3);
      if (!modified.measure || !modified.lines[0] || !modified.values.length) throw new Error(`A modifier-held measure lost its readout, level line or axis value ${JSON.stringify(modified)}`);
      const after = { x: to.x, y: to.y + 6 };
      await mouse(cdp, "mouseMoved", after.x, after.y, false); await frames(cdp, 4);
      const hover = await checkHoverLevel(cdp, 0, plot, after);
      if (hover.measure) throw new Error(`The hover after a modifier-held measure kept its readout ${JSON.stringify(hover)}`);
    } finally {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    }
  },
}))));

export const axisSteps = ["desktop", "browser"].flatMap((host) => [640, 1280].flatMap((width) => ["white", "paper"].flatMap((theme) => [false, true].flatMap((floating) => ["two", "three", "percent", "mixed", "missing", "stacked", "dense"].map((kind) => ({
  name: `series axis tags: ${host} ${width} ${theme} ${floating ? "floating" : "docked"} ${kind}`,
  scenario: `axis&axis=${kind}&host=${host}&theme=${theme}&float=${Number(floating)}&short=${Number(kind === "dense")}`,
  async run(cdp: Cdp) {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: kind === "dense" ? 140 : 800, deviceScaleFactor: 1, mobile: false });
    await frames(cdp, 8);
    // A floating frame was created at the suite's initial viewport. Resize it
    // through its saved layout on the next load, rather than clipping it.
    if (floating) {
      const loaded = cdp.once("Page.loadEventFired");
      await cdp.send("Page.reload"); await loaded; await frames(cdp, 8);
    }
    try {
      const panels = await plots(cdp);
      if (!panels.length) throw new Error("No plotted fixture");
      for (const [panelIndex, plot] of panels.entries()) {
        for (const share of [0.02, 0.33, 0.44, 0.55, 0.95]) {
          const at = { x: plot.x + share * (plot.width - 1), y: plot.y + plot.height * 0.15 };
          await mouse(cdp, "mouseMoved", at.x, at.y, false); await frames(cdp, 3);
          // Keep before screenshots even when the new assertion fails on main.
          if (panelIndex === 0 && share === 0.44 && kind === "three" && !floating) {
            const dir = cacheDir("axis-shots"); await mkdir(dir, { recursive: true });
            const shot = await cdp.send<{data: string}>("Page.captureScreenshot", { format: "png" });
            await Bun.write(join(dir, `${host}-${width}-${theme}.png`), Buffer.from(shot.data, "base64"));
          }
          // The whole matrix can be captured before the fix; the final
          // assertion still records the failure for every scenario.
          if (process.env.AXIS_CAPTURE_BASE !== "1" || share === 0.95) await checkReadout(cdp);
          if (process.env.AXIS_CAPTURE_BASE === "1") continue;
          const first = await evaluate(cdp, "window.__axisReadout");
          await checkHoverLevel(cdp, panelIndex, plot, at);
          const low = { x: at.x, y: plot.y + plot.height * 0.85 };
          await mouse(cdp, "mouseMoved", low.x, low.y, false); await frames(cdp, 3);
          await checkReadout(cdp);
          await checkHoverLevel(cdp, panelIndex, plot, low);
          // The pointer's height moves the level line and its value, never the series' observations.
          const second = await evaluate(cdp, "window.__axisReadout");
          if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("Pointer height changed the observations");
        }
      }
      // Fast successive resizes, then inspect the actual laid-out plot again.
      for (const next of [width - 67, width + 23, width]) await cdp.send("Emulation.setDeviceMetricsOverride", { width: next, height: 800, deviceScaleFactor: 1, mobile: false });
      await frames(cdp, 8);
      const plot = (await plots(cdp))[0]!;
      await mouse(cdp, "mouseMoved", plot.x + plot.width * 0.55, plot.y + plot.height * 0.6, false);
      await frames(cdp, 3); await checkReadout(cdp);
      await mouse(cdp, "mouseMoved", 1, 1, false); await frames(cdp, 3);
      if (await evaluate(cdp, "document.querySelectorAll('[data-gloom-role=chart-series-axis-tag]').length")) throw new Error("Tags remain after pointer leaves");
    } finally {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    }
  },
}))))));

axisSteps.push(...toolSteps);
