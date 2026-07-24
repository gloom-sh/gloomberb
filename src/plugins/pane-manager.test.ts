import { describe, expect, test } from "bun:test";
import { cloneLayout, createDefaultConfig, createPaneInstance, type LayoutConfig } from "../types/config";
import {
  addPaneFloating,
  applyLayoutPreset,
  applyDrop,
  compactDockedPaneAtRect,
  dockFloatingPaneAtCurrentRect,
  floatAtRect,
  getDockResizeTargets,
  gridlockAllPanes,
  getDockDividerLayouts,
  getDockLeafLayouts,
  getDockedPaneIds,
  getLeafRect,
  moveFloatingPane,
  resizeFloatingPaneFromCorner,
  simulateDrop,
  snapPaneToGridRect,
} from "./pane-manager";

const BOUNDS = { x: 0, y: 0, width: 120, height: 40 };

function rectsOverlap(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

describe("pane-manager split-tree drops", () => {
  test("docks the first floating pane into an empty dock root", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const layout = {
      ...cloneLayout(config.layout),
      dockRoot: null,
      floating: [],
      detached: [],
      instances: [],
    };
    const floatingOnly = addPaneFloating(layout, createPaneInstance("chat"), 120, 30);
    const paneId = floatingOnly.floating[0]!.instanceId;

    const next = applyDrop(floatingOnly, paneId, { kind: "frame", edge: "left" });

    expect(getDockedPaneIds(next)).toEqual([paneId]);
    expect(next.floating).toHaveLength(0);
  });

  test("keeps frame-drop previews identical to the committed rect", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const notesPane = createPaneInstance("chat");
    const withFloating = addPaneFloating(cloneLayout(config.layout), notesPane, 120, 30);
    const target = { kind: "frame", edge: "right" } as const;

    const simulation = simulateDrop(withFloating, notesPane.instanceId, target, BOUNDS);
    const next = applyDrop(withFloating, notesPane.instanceId, target);

    expect(getLeafRect(next, notesPane.instanceId, BOUNDS)).toEqual(simulation.previewRect);
    expect(getDockedPaneIds(next)).toContain(notesPane.instanceId);
  });

  test("can reserve a gutter for dock dividers without overlapping pane rects", () => {
    const layout = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "left:main" },
        second: { kind: "pane" as const, instanceId: "right:main" },
      },
      instances: [
        createPaneInstance("left", { instanceId: "left:main" }),
        createPaneInstance("right", { instanceId: "right:main" }),
      ],
      floating: [],
      detached: [],
    };

    const leaves = getDockLeafLayouts(layout, BOUNDS, { reserveDividerGutters: true });
    const divider = getDockDividerLayouts(layout, BOUNDS, { reserveDividerGutters: true })[0];
    const left = leaves.find((leaf) => leaf.instanceId === "left:main");
    const right = leaves.find((leaf) => leaf.instanceId === "right:main");

    expect(left).toBeDefined();
    expect(right).toBeDefined();
    expect(divider).toBeDefined();
    expect(divider!.rect.x).toBe(left!.rect.x + left!.rect.width);
    expect(right!.rect.x).toBe(divider!.rect.x + divider!.rect.width);
  });

  test("splits the hovered pane on leaf drops and matches the preview", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const notesPane = createPaneInstance("chat");
    const withFloating = addPaneFloating(cloneLayout(config.layout), notesPane, 120, 30);
    const target = { kind: "leaf", targetId: "ticker-detail:main", position: "top" } as const;

    const simulation = simulateDrop(withFloating, notesPane.instanceId, target, BOUNDS);
    const next = applyDrop(withFloating, notesPane.instanceId, target);
    const notesRect = getLeafRect(next, notesPane.instanceId, BOUNDS);
    const tickerRect = getLeafRect(next, "ticker-detail:main", BOUNDS);

    expect(notesRect).toEqual(simulation.previewRect);
    expect(notesRect).not.toBeNull();
    expect(tickerRect).not.toBeNull();
    expect(notesRect!.x).toBe(tickerRect!.x);
    expect(notesRect!.width).toBe(tickerRect!.width);
    expect(notesRect?.y).toBeLessThan(tickerRect!.y);
  });

  test("gridlocks floating windows back into a tiled layout", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    let layout = cloneLayout(config.layout);
    layout = addPaneFloating(layout, createPaneInstance("chat"), 120, 30);
    layout = addPaneFloating(layout, createPaneInstance("chat"), 120, 30);

    const next = gridlockAllPanes(layout);

    expect(next.floating).toHaveLength(0);
    expect(getDockedPaneIds(next)).toHaveLength(layout.instances.length);
  });

  test("gridlock drops pane types that cannot render before tiling", () => {
    const layout: LayoutConfig = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: {
          kind: "split" as const,
          axis: "vertical" as const,
          ratio: 0.5,
          first: { kind: "pane" as const, instanceId: "missing:main" },
          second: { kind: "pane" as const, instanceId: "chat:main" },
        },
        second: { kind: "pane" as const, instanceId: "sectors:main" },
      },
      instances: [
        createPaneInstance("missing-plugin", { instanceId: "missing:main" }),
        createPaneInstance("chat", { instanceId: "chat:main" }),
        createPaneInstance("sectors", { instanceId: "sectors:main" }),
      ],
      floating: [],
      detached: [],
    };

    const next = gridlockAllPanes(layout, BOUNDS, new Set(["chat", "sectors"]));

    expect(next.instances.map((instance) => instance.instanceId)).toEqual(["chat:main", "sectors:main"]);
    expect(getDockedPaneIds(next)).toEqual(["chat:main", "sectors:main"]);
    expect(getLeafRect(next, "missing:main", BOUNDS)).toBeNull();
    expect(getLeafRect(next, "chat:main", BOUNDS)).toEqual({ x: 0, y: 0, width: 60, height: 40 });
    expect(getLeafRect(next, "sectors:main", BOUNDS)).toEqual({ x: 60, y: 0, width: 60, height: 40 });
  });

  test("gridlock infers a matching tiled layout from arranged windows", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    let layout: LayoutConfig = {
      ...cloneLayout(config.layout),
      dockRoot: null,
      floating: [],
      detached: [],
      instances: [],
    };
    const leftPane = createPaneInstance("chat");
    const topRightPane = createPaneInstance("chat");
    const bottomRightPane = createPaneInstance("chat");

    layout = addPaneFloating(layout, leftPane, 120, 40);
    layout = addPaneFloating(layout, topRightPane, 120, 40);
    layout = addPaneFloating(layout, bottomRightPane, 120, 40);
    layout = floatAtRect(layout, leftPane.instanceId, { x: 0, y: 0, width: 60, height: 40 });
    layout = floatAtRect(layout, topRightPane.instanceId, { x: 60, y: 0, width: 60, height: 20 });
    layout = floatAtRect(layout, bottomRightPane.instanceId, { x: 60, y: 20, width: 60, height: 20 });

    const next = gridlockAllPanes(layout, BOUNDS);

    expect(next.floating).toHaveLength(0);
    expect(getLeafRect(next, leftPane.instanceId, BOUNDS)).toEqual({ x: 0, y: 0, width: 60, height: 40 });
    expect(getLeafRect(next, topRightPane.instanceId, BOUNDS)).toEqual({ x: 60, y: 0, width: 60, height: 20 });
    expect(getLeafRect(next, bottomRightPane.instanceId, BOUNDS)).toEqual({ x: 60, y: 20, width: 60, height: 20 });
  });

  test("builds grid and left-main presets from every visible pane without changing the schema", () => {
    const config = createDefaultConfig("/tmp/gloomberb-preset-test");
    let layout = cloneLayout(config.layout);
    layout = addPaneFloating(layout, createPaneInstance("chat"), 120, 40);
    const visibleIds = new Set([
      ...getDockedPaneIds(layout),
      ...layout.floating.map((entry) => entry.instanceId),
    ]);

    for (const preset of ["single", "2x2", "3x3", "left-main"] as const) {
      const next = applyLayoutPreset(layout, preset, BOUNDS);
      expect(new Set(getDockedPaneIds(next))).toEqual(visibleIds);
      expect(next.floating).toEqual([]);
      expect(next.instances).toHaveLength(layout.instances.length);
      expect(next.detached).toEqual(layout.detached);
    }

    const leftMain = applyLayoutPreset(layout, "left-main", BOUNDS);
    const leaves = getDockLeafLayouts(leftMain, BOUNDS, { precise: true });
    const main = leaves.find((leaf) => leaf.instanceId === getDockedPaneIds(layout)[0]);
    const stack = leaves.filter((leaf) => leaf.instanceId !== main?.instanceId);
    expect(main?.rect).toEqual({ x: 0, y: 0, width: 60, height: 40 });
    expect(stack.every((leaf) => leaf.rect.x === 60 && leaf.rect.width === 60)).toBe(true);
  });

  test("keeps a snapped grid cell as exact committed floating geometry", () => {
    const config = createDefaultConfig("/tmp/gloomberb-cell-snap-test");
    const floatingPane = createPaneInstance("chat", { instanceId: "chat:floating" });
    const layout = addPaneFloating(cloneLayout(config.layout), floatingPane, 120, 40);

    const next = snapPaneToGridRect(
      layout,
      floatingPane.instanceId,
      { x: 80, y: 0, width: 20, height: 10 },
      BOUNDS,
    );

    expect(getDockedPaneIds(next)).not.toContain(floatingPane.instanceId);
    expect(next.floating.find((entry) => entry.instanceId === floatingPane.instanceId)).toEqual(expect.objectContaining({
      x: 80,
      y: 0,
      width: 20,
      height: 10,
      fixedGeometry: true,
    }));
  });

  test("keeps snapped cell geometry when center-swapping with a docked pane", () => {
    const config = createDefaultConfig("/tmp/gloomberb-cell-swap-test");
    const floatingPane = createPaneInstance("chat", { instanceId: "chat:floating" });
    const dockedPaneId = "ticker-detail:main";
    const snapped = snapPaneToGridRect(
      addPaneFloating(cloneLayout(config.layout), floatingPane, 120, 40),
      floatingPane.instanceId,
      { x: 80, y: 4, width: 6, height: 6 },
      BOUNDS,
    );
    const snappedEntry = snapped.floating.find((entry) => entry.instanceId === floatingPane.instanceId)!;

    const swapped = applyDrop(snapped, floatingPane.instanceId, {
      kind: "leaf",
      targetId: dockedPaneId,
      position: "center",
    });
    const replacement = swapped.floating.find((entry) => entry.instanceId === dockedPaneId);

    expect(replacement).toEqual({ ...snappedEntry, instanceId: dockedPaneId });
    expect(replacement).toEqual(expect.objectContaining({
      x: 80,
      y: 4,
      width: 6,
      height: 6,
      fixedGeometry: true,
    }));
    expect(getDockedPaneIds(swapped)).toContain(floatingPane.instanceId);
    expect(getDockedPaneIds(swapped)).not.toContain(dockedPaneId);

    const clamped = moveFloatingPane(swapped, dockedPaneId, 0, 0, BOUNDS);
    expect(clamped.floating.find((entry) => entry.instanceId === dockedPaneId)).toEqual(replacement);
  });

  test("rejects an overlapping auto-compact candidate without rebuilding the dock tree", () => {
    const layout: LayoutConfig = {
      dockRoot: {
        kind: "split",
        axis: "horizontal",
        ratio: 0.5,
        first: { kind: "pane", instanceId: "left:main" },
        second: {
          kind: "split",
          axis: "vertical",
          ratio: 0.5,
          first: { kind: "pane", instanceId: "top-right:main" },
          second: { kind: "pane", instanceId: "bottom-right:main" },
        },
      },
      instances: [
        createPaneInstance("left", { instanceId: "left:main" }),
        createPaneInstance("top-right", { instanceId: "top-right:main" }),
        createPaneInstance("bottom-right", { instanceId: "bottom-right:main" }),
        createPaneInstance("floating", { instanceId: "floating:main" }),
        createPaneInstance("detached", { instanceId: "detached:main" }),
      ],
      floating: [{ instanceId: "floating:main", x: 45, y: 10, width: 30, height: 12, zIndex: 77 }],
      detached: [{ instanceId: "detached:main", x: 10, y: 10, width: 50, height: 20 }],
    };
    const next = compactDockedPaneAtRect(
      layout,
      "left:main",
      { x: 60, y: 20, width: 60, height: 20 },
      BOUNDS,
    );
    expect(next).toBe(layout);
    expect(next.dockRoot).toEqual(layout.dockRoot);
    expect(getDockLeafLayouts(next, BOUNDS)).toEqual(getDockLeafLayouts(layout, BOUNDS));
  });

  test("restores a floated tile to its target-relative dock placement", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const unrelated = createPaneInstance("chat");
    let layout = addPaneFloating(cloneLayout(config.layout), unrelated, 120, 40);
    layout = floatAtRect(layout, unrelated.instanceId, { x: 5, y: 5, width: 25, height: 10, zIndex: 80 });
    const paneId = "ticker-detail:main";
    const tiledRect = getLeafRect(layout, paneId, BOUNDS)!;

    const floated = floatAtRect(layout, paneId, tiledRect);

    expect(getDockedPaneIds(floated)).not.toContain(paneId);
    expect(floated.floating.find((entry) => entry.instanceId === paneId)).toEqual(expect.objectContaining(tiledRect));
    expect(floated.floating.find((entry) => entry.instanceId === unrelated.instanceId)).toEqual(
      layout.floating.find((entry) => entry.instanceId === unrelated.instanceId),
    );

    const docked = dockFloatingPaneAtCurrentRect(floated, paneId, BOUNDS);
    const leaves = getDockLeafLayouts(docked, BOUNDS);

    expect(getDockedPaneIds(docked)).toContain(paneId);
    expect(getDockedPaneIds(docked)).toEqual(getDockedPaneIds(layout));
    expect(docked.floating.some((entry) => entry.instanceId === paneId)).toBe(false);
    expect(docked.floating.find((entry) => entry.instanceId === unrelated.instanceId)).toEqual(
      layout.floating.find((entry) => entry.instanceId === unrelated.instanceId),
    );
    for (let firstIndex = 0; firstIndex < leaves.length; firstIndex += 1) {
      for (let secondIndex = firstIndex + 1; secondIndex < leaves.length; secondIndex += 1) {
        expect(rectsOverlap(leaves[firstIndex]!.rect, leaves[secondIndex]!.rect)).toBe(false);
      }
    }
  });

  test("moves floating panes repeatedly within the terminal bounds", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const pane = createPaneInstance("chat");
    let layout = addPaneFloating(cloneLayout(config.layout), pane, 120, 40);
    layout = floatAtRect(layout, pane.instanceId, { x: 8, y: 4, width: 30, height: 10 });

    layout = moveFloatingPane(layout, pane.instanceId, 12, 3, BOUNDS);
    layout = moveFloatingPane(layout, pane.instanceId, 200, 200, BOUNDS);

    expect(layout.floating.find((entry) => entry.instanceId === pane.instanceId)).toEqual(expect.objectContaining({
      x: 90,
      y: 30,
      width: 30,
      height: 10,
    }));
  });

  test("resizes a floating pane from the focused corner", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const pane = createPaneInstance("chat");
    let layout = addPaneFloating(cloneLayout(config.layout), pane, 120, 40);
    layout = floatAtRect(layout, pane.instanceId, { x: 20, y: 8, width: 40, height: 14 });

    layout = resizeFloatingPaneFromCorner(layout, pane.instanceId, "top-left", -5, -2, BOUNDS);
    expect(layout.floating.find((entry) => entry.instanceId === pane.instanceId)).toEqual(expect.objectContaining({
      x: 15,
      y: 6,
      width: 45,
      height: 16,
    }));

    layout = resizeFloatingPaneFromCorner(layout, pane.instanceId, "bottom-right", 100, 100, BOUNDS);
    expect(layout.floating.find((entry) => entry.instanceId === pane.instanceId)).toEqual(expect.objectContaining({
      x: 15,
      y: 6,
      width: 105,
      height: 34,
    }));
  });

  test("resizes floating panes from each edge without changing the orthogonal axis", () => {
    const cases = [
      { corner: "right", deltaX: 10, deltaY: 99, expected: { x: 20, y: 8, width: 50, height: 14 } },
      { corner: "left", deltaX: -5, deltaY: 99, expected: { x: 15, y: 8, width: 45, height: 14 } },
      { corner: "bottom", deltaX: 99, deltaY: 6, expected: { x: 20, y: 8, width: 40, height: 20 } },
      { corner: "top", deltaX: 99, deltaY: -3, expected: { x: 20, y: 5, width: 40, height: 17 } },
    ] as const;

    for (const { corner, deltaX, deltaY, expected } of cases) {
      const config = createDefaultConfig("/tmp/gloomberb-test");
      const pane = createPaneInstance("chat");
      let layout = addPaneFloating(cloneLayout(config.layout), pane, 120, 40);
      layout = floatAtRect(layout, pane.instanceId, { x: 20, y: 8, width: 40, height: 14 });

      layout = resizeFloatingPaneFromCorner(layout, pane.instanceId, corner, deltaX, deltaY, BOUNDS);

      expect(layout.floating.find((entry) => entry.instanceId === pane.instanceId)).toEqual(expect.objectContaining(expected));
    }
  });

  test("finds dock resize targets from the focused pane ancestors", () => {
    const layout: LayoutConfig = {
      dockRoot: {
        kind: "split" as const,
        axis: "horizontal" as const,
        ratio: 0.5,
        first: { kind: "pane" as const, instanceId: "left:main" },
        second: {
          kind: "split" as const,
          axis: "vertical" as const,
          ratio: 0.5,
          first: { kind: "pane" as const, instanceId: "top:main" },
          second: { kind: "pane" as const, instanceId: "bottom:main" },
        },
      },
      instances: [
        createPaneInstance("left", { instanceId: "left:main" }),
        createPaneInstance("top", { instanceId: "top:main" }),
        createPaneInstance("bottom", { instanceId: "bottom:main" }),
      ],
      floating: [],
      detached: [],
    };

    const targets = getDockResizeTargets(layout, "bottom:main", BOUNDS);

    expect(targets.map((target) => ({ path: target.path, axis: target.axis, leafBranch: target.leafBranch }))).toEqual([
      { path: [1], axis: "vertical", leafBranch: 1 },
      { path: [], axis: "horizontal", leafBranch: 1 },
    ]);
  });
});
