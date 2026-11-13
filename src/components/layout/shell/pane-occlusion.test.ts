import { describe, expect, test } from "bun:test";
import { resolveOccludedPaneIds, resolveTitleCoveredPaneIds, visibleFocusTarget, type OcclusionPane } from "./pane-occlusion";

const bounds = { width: 40, height: 20 };

function pane(paneId: string, rect: [number, number, number, number], zIndex: number | null, order: number): OcclusionPane {
  return { paneId, rect: { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }, zIndex, order };
}

describe("resolveOccludedPaneIds", () => {
  test("a window wholly inside a higher one is hidden, the higher one is not", () => {
    const occluded = resolveOccludedPaneIds([
      pane("under", [5, 5, 10, 6], 50, 0),
      pane("over", [4, 4, 14, 9], 51, 1),
    ], bounds);
    expect([...occluded]).toEqual(["under"]);
  });

  test("the union of two windows hides a pane neither covers alone", () => {
    const occluded = resolveOccludedPaneIds([
      pane("under", [0, 0, 20, 10], 50, 0),
      pane("left", [0, 0, 10, 10], 51, 1),
      pane("right", [10, 0, 10, 10], 51, 2),
    ], bounds);
    expect([...occluded]).toEqual(["under"]);
  });

  test("a single uncovered cell keeps the pane visible", () => {
    const occluded = resolveOccludedPaneIds([
      pane("under", [0, 0, 20, 10], 50, 0),
      pane("over", [0, 0, 20, 9], 51, 1),
    ], bounds);
    expect(occluded.size).toBe(0);
  });

  test("equal z-index stacks by render order and docked panes sit below floating ones", () => {
    const occluded = resolveOccludedPaneIds([
      pane("dock", [0, 0, 40, 20], null, 0),
      pane("first", [0, 0, 40, 20], 50, 1),
      pane("second", [0, 0, 40, 20], 50, 2),
    ], bounds);
    expect([...occluded].sort()).toEqual(["dock", "first"]);
  });

  test("a window off the content area does not count as covering", () => {
    const occluded = resolveOccludedPaneIds([
      pane("under", [0, 0, 10, 10], 50, 0),
      pane("outside", [40, 20, 10, 10], 51, 1),
    ], bounds);
    expect(occluded.size).toBe(0);
  });
});

// A window filling a 55-column terminal hid the docked pane that a restored session focused: keys went to it unseen.
test("focus moves from a pane hidden under windows to the topmost one that shows", () => {
  const panes = [
    pane("dock", [0, 0, 40, 20], null, 0),
    pane("small", [2, 2, 10, 5], 50, 1),
    pane("full", [0, 0, 40, 20], 51, 2),
  ];
  const occluded = resolveOccludedPaneIds(panes, bounds);
  expect(visibleFocusTarget("dock", panes, occluded)).toBe("full");
  expect(visibleFocusTarget("full", panes, occluded)).toBeNull();
  // A window that leaves part of the dock showing leaves its focus alone.
  const partial = [pane("dock", [0, 0, 40, 20], null, 0), pane("window", [0, 0, 30, 20], 51, 1)];
  expect(visibleFocusTarget("dock", partial, resolveOccludedPaneIds(partial, bounds))).toBeNull();
});

describe("resolveTitleCoveredPaneIds", () => {
  const docked = (paneId: string, x: number, y: number, width: number) => ({ paneId, rect: { x, y, width, height: 10 } });

  test("a window over half or more of a docked pane's title row covers it; one over its body alone does not", () => {
    const covered = resolveTitleCoveredPaneIds([
      docked("half", 0, 0, 20),
      docked("less", 20, 0, 20),
      docked("body", 0, 10, 40),
    ], [{ x: 10, y: 0, width: 19, height: 5 }, { x: 0, y: 12, width: 40, height: 6 }]);
    expect([...covered]).toEqual(["half"]);
  });

  test("two windows side by side cover a title row neither covers half of", () => {
    const covered = resolveTitleCoveredPaneIds(
      [docked("pane", 0, 0, 40)],
      [{ x: 0, y: 0, width: 10, height: 4 }, { x: 25, y: 0, width: 10, height: 4 }],
    );
    expect([...covered]).toEqual(["pane"]);
  });

  // The desktop's bar is taller than a row and a divider or a window's border
  // runs over its top: a window reaching just past that line hides no title,
  // one over the bar's middle does, at fractional positions too.
  test("a desktop bar is judged along its middle, not the line over its top", () => {
    const headerRows = 1.75;
    const panes = [docked("edge", 0, 10.06, 30), docked("middle", 30, 10.06, 30)];
    const covered = resolveTitleCoveredPaneIds(panes, [
      { x: 0, y: 4.5, width: 30, height: 6 },
      { x: 29.5, y: 4.5, width: 30.5, height: 6.5 },
    ], { headerRows });
    expect([...covered]).toEqual(["middle"]);
  });
});
