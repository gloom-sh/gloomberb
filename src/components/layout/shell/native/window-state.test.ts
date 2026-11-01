import { expect, test } from "bun:test";
import { bringFloatingToFront } from "../../../../core/state/app/layout";
import { sanitizeLayout } from "../../../../data/config/layout";
import { bringToFront, FLOATING_PANE_MAX_Z } from "../../../../layout/pane-manager";
import { DEFAULT_LAYOUT, type LayoutConfig } from "../../../../types/config";
import type { CellRect } from "../../../chart/native/chart-rasterizer";
import { computeSurfaceVisibleFragments } from "../../../chart/native/surface/manager";
import type { DragPreview } from "../drag";
import { buildNativeTransientOccluders, buildNativeWindowState } from "./window-state";

const HEADER = 1;
// Screen cells: under the open pane menu, under a dock preview's outline, inside
// that outline (which fills nothing in), and clear of both.
const UNDER_MENU = { x: 75, y: 10 };
const UNDER_PREVIEW = { x: 10, y: 10 };
const INSIDE_PREVIEW = { x: 15, y: 10 };
const CLEAR = { x: 40, y: 10 };

function floatingLayout(zIndexes: [number, number]): LayoutConfig {
  return {
    dockRoot: null,
    instances: [
      { instanceId: "cryp", paneId: "crypto-board", binding: { kind: "none" } },
      { instanceId: "news", paneId: "news-feed", binding: { kind: "none" } },
    ],
    floating: [
      { instanceId: "cryp", x: 10, y: 2, width: 80, height: 30, zIndex: zIndexes[0] },
      { instanceId: "news", x: 95, y: 8, width: 20, height: 20, zIndex: zIndexes[1] },
    ],
    detached: [],
  };
}

/** The cells of CRYP's chart band that keep the image, with its pane menu open and a dock preview showing. */
function crypChartFragments(layout: LayoutConfig): CellRect[] {
  const transient = buildNativeTransientOccluders({
    activeHoverOverlay: null,
    activePaneDrag: null,
    commandBarNativeOccluder: null,
    dragFloatingRect: null,
    dockPreview: { kind: "dock", rect: { x: 10, y: 8, width: 10, height: 4 } } as DragPreview,
    menu: { paneId: "cryp", x: 70, y: 3, width: 20, itemCount: 12 },
    nativeWindowModePanelRect: null,
    windowModeDockMovePreview: null,
  });
  const state = buildNativeWindowState(
    [],
    layout.floating.map((entry) => ({ paneId: entry.instanceId, rect: entry, zIndex: entry.zIndex ?? 50 })),
    null,
    { open: false, width: 120, contentHeight: 40 },
    transient,
    [],
    HEADER,
  );
  const paneZ = state.paneLayers.find((layer) => layer.paneId === "cryp")!.zIndex;
  const chart = { x: 11, y: 7, width: 78, height: 10 };
  return computeSurfaceVisibleFragments(chart, chart, paneZ, "cryp", state.occluders);
}

function drawn(fragments: readonly CellRect[], cell: { x: number; y: number }): boolean {
  return fragments.some((rect) => cell.x >= rect.x && cell.x < rect.x + rect.width && cell.y >= rect.y && cell.y < rect.y + rect.height);
}

test("windows raised back and forth stay under the pane menu and drag previews, which keep cutting their charts", () => {
  let layout = floatingLayout([50, 51]);
  // Focus moves between two windows, through both ways a pane is raised.
  let highest = 0;
  for (let turn = 0; turn < 120; turn += 1) {
    const pane = turn % 2 === 0 ? "cryp" : "news";
    layout = turn % 3 === 0 ? bringToFront(layout, pane) : bringFloatingToFront(layout, pane);
    highest = Math.max(highest, ...layout.floating.map((entry) => entry.zIndex ?? 50));
  }
  layout = bringFloatingToFront(layout, "cryp");

  expect(highest).toBe(FLOATING_PANE_MAX_Z);
  // Window mode highlights a pane three levels up; at the top of the stack that still stays under the drag outline (95).
  expect(highest + 3).toBeLessThan(95);
  const [cryp, news] = layout.floating;
  expect(cryp!.zIndex!).toBeGreaterThan(news!.zIndex!);
  // Unbounded, CRYP reached z 171 here, over the dock preview (96), which then no longer cut its chart.
  const fragments = crypChartFragments(layout);
  expect([drawn(fragments, UNDER_MENU), drawn(fragments, UNDER_PREVIEW), drawn(fragments, INSIDE_PREVIEW), drawn(fragments, CLEAR)])
    .toEqual([false, false, true, true]);
});

test("a layout saved with its windows stacked past the pane menu loads renumbered in the same order", () => {
  const saved = floatingLayout([10_051, 9_990]);
  // As saved, the open menu (z 10000) does not cut CRYP's chart.
  expect(drawn(crypChartFragments(saved), UNDER_MENU)).toBe(true);

  const loaded = sanitizeLayout(saved, DEFAULT_LAYOUT);
  expect(loaded.floating.map((entry) => [entry.instanceId, entry.zIndex])).toEqual([["cryp", 51], ["news", 50]]);
  expect(drawn(crypChartFragments(loaded), UNDER_MENU)).toBe(false);
  // A stack within the limit loads as it was saved.
  expect(sanitizeLayout(floatingLayout([70, 52]), DEFAULT_LAYOUT).floating.map((entry) => entry.zIndex)).toEqual([70, 52]);
});
