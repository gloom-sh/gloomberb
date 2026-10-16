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
          await mouse(cdp, "mouseMoved", at.x, plot.y + plot.height * 0.85, false); await frames(cdp, 3);
          await checkReadout(cdp);
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
