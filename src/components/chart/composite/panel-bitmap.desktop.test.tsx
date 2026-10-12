/** @jsxImportSource react */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, Profiler, useState } from "react";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { useCompositePanelBitmap } from "./panel-bitmap";
import type { CompositeChartColors, CompositePanelScene } from "./types";

const harness = createDomTestHarness({ withUi: false });
const panel: CompositePanelScene = { id: "test", height: 5, scale: "linear", axes: {}, series: [] };
const colors: CompositeChartColors = {
  background: "#101218", grid: "#222222", crosshair: "#ffffff", text: "#cccccc", textDim: "#888888", negative: "#ff0000",
};

type Layout = { widths: number[]; colors: CompositeChartColors };

/** Keep resize timers separate tasks: wrapping all callbacks in one act would hide the regression. */
function controlledClock() {
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  const frames: FrameRequestCallback[] = [];
  let id = 0;
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay !== 32) return set(callback, delay, ...args);
    const handle = --id as unknown as ReturnType<typeof setTimeout>;
    timers.set(handle, callback);
    return handle;
  }) as typeof setTimeout);
  const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation((handle) => {
    if (!timers.delete(handle as ReturnType<typeof setTimeout>)) clear(handle);
  });
  const frameSpy = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  const restore = () => { setSpy.mockRestore(); clearSpy.mockRestore(); frameSpy.mockRestore(); };
  return {
    timers,
    restore,
    paint() { while (frames.length) for (const callback of frames.splice(0)) callback(0); },
    async fire() {
      for (const [handle, callback] of [...timers]) {
        if (!timers.delete(handle)) continue;
        await act(async () => { callback(); });
      }
    },
  };
}

let restoreClock: (() => void) | undefined;
afterEach(() => { restoreClock?.(); restoreClock = undefined; });

async function mountPlots(widths: number[]) {
  let change!: (layout: Layout) => void;
  let commits = 0;
  function Plot({ width, palette }: { width: number; palette: CompositeChartColors }) {
    const bitmap = useCompositePanelBitmap({ panel, bitmapSize: { pixelWidth: width, pixelHeight: 20 }, colors: palette, isDesktopWeb: true });
    return <span data-width={bitmap?.width} data-red={bitmap?.pixels[0]} />;
  }
  function Plots() {
    const [layout, setLayout] = useState<Layout>({ widths, colors });
    change = setLayout;
    return <>{layout.widths.map((width, index) => <Plot key={index} width={width} palette={layout.colors} />)}</>;
  }
  const container = await harness.render(<Profiler id="plots" onRender={() => { commits += 1; }}><Plots /></Profiler>);
  return {
    widths: () => [...container.querySelectorAll("span")].map((node) => Number(node.dataset.width)),
    reds: () => [...container.querySelectorAll("span")].map((node) => Number(node.dataset.red)),
    commits: () => commits,
    resize: async (next: number[], palette = colors) => { await act(async () => { change({ widths: next, colors: palette }); }); },
  };
}

describe("desktop panel bitmap resize batching", () => {
  test("eight plots publish the latest sizes in one commit, not one per timer", async () => {
    const clock = controlledClock();
    restoreClock = clock.restore;
    const plots = await mountPlots(Array(8).fill(40));
    clock.paint();
    await plots.resize(Array(8).fill(50));
    await plots.resize(Array(8).fill(60));
    expect(plots.widths()).toEqual(Array(8).fill(40));
    const before = plots.commits();
    await clock.fire();
    expect(plots.widths()).toEqual(Array(8).fill(60));
    expect(plots.commits() - before).toBe(1);
    expect(clock.timers.size).toBe(0);
  });

  test("unmount and immediate palette paints cancel pending work without dropping other plots", async () => {
    const clock = controlledClock();
    restoreClock = clock.restore;
    const plots = await mountPlots([40, 40, 40]);
    clock.paint();
    await plots.resize([50, 50, 50]);
    await plots.resize([60, 60]);
    await clock.fire();
    expect(plots.widths()).toEqual([60, 60]);

    await plots.resize([70, 70]);
    const palette = { ...colors, background: "#abcdef" };
    await plots.resize([80, 80], palette);
    expect(plots.widths()).toEqual([80, 80]);
    expect(plots.reds()).toEqual([0xab, 0xab]);
    expect(clock.timers.size).toBe(0);

    await plots.resize([90, 90], palette);
    await plots.resize([], palette);
    expect(clock.timers.size).toBe(0);
    await clock.fire();
    expect(plots.widths()).toEqual([]);
  });
});
