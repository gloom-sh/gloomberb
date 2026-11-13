import { afterEach, expect, test } from "bun:test";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import type { CellRect } from "../../components/chart/native/chart-rasterizer";
import { NativeSurfaceManager } from "../../components/chart/native/surface/manager";
import type { NativeRendererHost } from "../../ui/host";
import { createFrameHits } from "./frame-hits";

// The terminal image layer against a real frame: which kitty images the
// escape stream leaves placed for a given layout.

let current: TestRendererSetup | null = null;
let manager: NativeSurfaceManager | null = null;
afterEach(() => {
  manager?.destroy();
  manager = null;
  current?.renderer.destroy();
  current = null;
});

/** The cells each live placement covers once the terminal has run every write, as kitty keeps them. */
function placedCells(writes: readonly string[]): CellRect[] {
  const live = new Map<string, CellRect>();
  const pattern = /(?:\x1b\[s\x1b\[(\d+);(\d+)H)?\x1b_G([^;\x1b]*);?[^\x1b]*\x1b\\/g;
  for (const match of writes.join("").matchAll(pattern)) {
    const control = Object.fromEntries(match[3]!.split(",").map((pair) => pair.split("=") as [string, string]));
    if (control.a === "p") {
      live.set(`${control.i}:${control.p}`, {
        x: Number(match[2]) - 1,
        y: Number(match[1]) - 1,
        width: Number(control.c),
        height: Number(control.r),
      });
    } else if (control.a === "d") {
      for (const key of [...live.keys()]) {
        const [image, placement] = key.split(":");
        if (image === control.i && (control.p === undefined || placement === control.p)) live.delete(key);
      }
    }
  }
  return [...live.values()].sort((a, b) => a.y - b.y || a.x - b.x);
}

async function chartUnderWindow() {
  current = await createTestRenderer({ width: 40, height: 20 });
  const { renderer, renderOnce } = current;
  const writes: string[] = [];
  const host = {
    get terminalWidth() { return renderer.terminalWidth; },
    get terminalHeight() { return renderer.terminalHeight; },
    resolution: { width: 400, height: 400 },
    write(data: string | Uint8Array) {
      writes.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
      return true;
    },
    on: (event: string, handler: (...args: any[]) => void) => renderer.on(event, handler),
    off: (event: string, handler: (...args: any[]) => void) => renderer.off(event, handler),
    frameHits: createFrameHits(renderer),
  } as unknown as NativeRendererHost;

  // A pane with a chart and a legend of its own over the chart's first row,
  // a see-through layer over the pane, and a window over both.
  const pane = new BoxRenderable(renderer, { id: "pane", position: "absolute", left: 0, top: 0, width: 30, height: 12, backgroundColor: "#101010" });
  (pane as unknown as Record<string, unknown>)["data-gloom-pane-id"] = "chart-pane";
  const chart = new BoxRenderable(renderer, { id: "chart", position: "absolute", left: 2, top: 2, width: 20, height: 8 });
  const legend = new BoxRenderable(renderer, { id: "legend", position: "absolute", left: 2, top: 2, width: 6, height: 1, zIndex: 5, backgroundColor: "#202020" });
  pane.add(chart);
  pane.add(legend);
  const catcher = new BoxRenderable(renderer, { id: "catcher", position: "absolute", left: 0, top: 0, width: 40, height: 20, zIndex: 40 });
  const window = new BoxRenderable(renderer, { id: "window", position: "absolute", left: 15, top: 5, width: 20, height: 10, zIndex: 50, backgroundColor: "#303030" });
  renderer.root.add(pane);
  renderer.root.add(catcher);
  renderer.root.add(window);
  await renderOnce();

  manager = new NativeSurfaceManager(host);
  manager.upsertSurface({
    id: "chart",
    paneId: "chart-pane",
    rect: { x: 2, y: 2, width: 20, height: 8 },
    visibleRect: { x: 2, y: 2, width: 20, height: 8 },
    bitmap: { width: 200, height: 160, pixels: new Uint8Array(200 * 160 * 4) },
    bitmapKey: "plot",
    anchor: { renderable: chart as never },
  });
  return { writes, pane, chart, window, renderOnce };
}

test("a chart image stays under a window drawn over it, not under its own pane's drawing or a see-through layer", async () => {
  const { writes } = await chartUnderWindow();

  expect(placedCells(writes)).toEqual([
    { x: 2, y: 2, width: 20, height: 3 },
    { x: 2, y: 5, width: 13, height: 5 },
  ]);
});

test("after each frame a chart image follows its box, and goes with it", async () => {
  const { writes, pane, chart, window, renderOnce } = await chartUnderWindow();

  window.left = 30;
  pane.left = 4;
  await renderOnce();
  expect(placedCells(writes)).toEqual([
    { x: 6, y: 2, width: 20, height: 8 },
  ]);

  pane.visible = false;
  await renderOnce();
  expect(placedCells(writes)).toEqual([]);

  pane.visible = true;
  await renderOnce();
  expect(placedCells(writes)).toEqual([
    { x: 6, y: 2, width: 20, height: 8 },
  ]);

  // Out of the tree before React lets the surface go: a closed pane, a lost tab.
  pane.remove(chart.id);
  await renderOnce();
  expect(placedCells(writes)).toEqual([]);
});
