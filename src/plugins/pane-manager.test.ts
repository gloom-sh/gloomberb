import { describe, expect, test } from "bun:test";
import { cloneLayout, createDefaultConfig, createPaneInstance, type LayoutConfig } from "../types/config";
import {
  addPaneFloating,
  analyzeFloatingPaneVisibility,
  applyDrop,
  floatAtRect,
  getDockResizeTargets,
  gridlockAllPanes,
  shouldShowTidyWindows,
  getDockDividerLayouts,
  getDockLeafLayouts,
  getDockedPaneIds,
  getLeafRect,
  moveFloatingPane,
  resizeFloatingPaneFromCorner,
  simulateDrop,
} from "./pane-manager";

const BOUNDS = { x: 0, y: 0, width: 120, height: 40 };

describe("pane-manager split-tree drops", () => {
  test("clamps a pane's preferred floating size to a small terminal", () => {
    const config = createDefaultConfig("/tmp/gloomberb-test");
    const next = addPaneFloating(
      cloneLayout(config.layout),
      createPaneInstance("help"),
      80,
      24,
      { id: "help", name: "Help", component: () => null, defaultFloatingSize: { width: 88, height: 32 } },
    );

    expect(next.floating.at(-1)).toMatchObject({ x: 0, y: 0, width: 80, height: 24 });
  });

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

  test("detects a floating pane whose title bar is buried", () => {
    const layout: LayoutConfig = {
      dockRoot: null,
      instances: [
        createPaneInstance("chat", { instanceId: "lower" }),
        createPaneInstance("chat", { instanceId: "upper" }),
      ],
      floating: [
        { instanceId: "lower", x: 0, y: 0, width: 40, height: 20, zIndex: 10 },
        { instanceId: "upper", x: 0, y: 0, width: 40, height: 4, zIndex: 20 },
      ],
      detached: [],
    };

    const visibility = analyzeFloatingPaneVisibility(layout);
    const lower = visibility.find((pane) => pane.instanceId === "lower");
    expect(lower?.visibleRatio).toBeCloseTo(0.8);
    expect(lower?.titleBarVisibleRatio).toBe(0);
    expect(lower?.buried).toBe(true);
    expect(shouldShowTidyWindows(layout)).toBe(true);

    const separated = {
      ...layout,
      floating: [layout.floating[0]!, { ...layout.floating[1]!, x: 50 }],
    };
    expect(shouldShowTidyWindows(separated)).toBe(false);
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
