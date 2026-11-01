import { expect, test } from "bun:test";
import type { LayoutConfig } from "../../types/config";
import { addPaneFloating, floatPane } from "./floating-actions";
import { placeFloatingRect } from "./floating-placement";

const W = 200;
const H = 50;

function layout(floating: LayoutConfig["floating"] = [], dockRoot: LayoutConfig["dockRoot"] = { kind: "pane", instanceId: "main" }): LayoutConfig {
  const ids = ["main", "side", ...floating.map((entry) => entry.instanceId)];
  return {
    dockRoot,
    instances: ids.map((instanceId) => ({ instanceId, paneId: "plain", binding: { kind: "none" } })),
    floating,
    detached: [],
  };
}

const covers = (outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }) =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;

test("two windows opened one after the other never land on the same spot", () => {
  const first = addPaneFloating(layout(), "chart-a", W, H);
  const second = addPaneFloating(first, "chart-b", W, H);
  const [a, b] = second.floating;
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  expect([b!.x, b!.y]).not.toEqual([a!.x, a!.y]);
  // Today's first window: 60% of the area, centred.
  expect(a).toMatchObject({ x: 40, y: 10, width: 120, height: 30 });
});

test("a new window opens beside the pane being worked in, not over it", () => {
  // `main` docked on the left third, `side` on the right; `main` has focus.
  const split = layout([], {
    kind: "split",
    axis: "horizontal",
    ratio: 0.3,
    first: { kind: "pane", instanceId: "main" },
    second: { kind: "pane", instanceId: "side" },
  });
  const rect = placeFloatingRect(split, "new", { width: 120, height: 30 }, W, H, { focusedPaneId: "main" });
  // The free 140 cells to the right hold it whole, centred.
  expect(rect).toMatchObject({ x: 70, y: 10, width: 120, height: 30 });
});

test("a window shrinks into a free spot that holds most of it, rather than cover another window", () => {
  const withWindow = layout([{ instanceId: "left", x: 0, y: 0, width: 110, height: 50, zIndex: 51 }]);
  const rect = placeFloatingRect(withWindow, "new", { width: 120, height: 30 }, W, H);
  expect(rect).toMatchObject({ x: 110, y: 10, width: 90, height: 30 });
});

test("with no room left, a window cascades from the frontmost one and keeps the focused pane in sight", () => {
  const crowded = layout([
    { instanceId: "back", x: 0, y: 0, width: 200, height: 50, zIndex: 51 },
    { instanceId: "front", x: 30, y: 8, width: 120, height: 30, zIndex: 52 },
  ]);
  const rect = placeFloatingRect(crowded, "new", { width: 120, height: 30 }, W, H, { focusedPaneId: "front" });
  expect(rect).toMatchObject({ x: 32, y: 9, width: 120, height: 30 });
  expect(covers(rect, { x: 30, y: 8, width: 120, height: 30 })).toBe(false);
  // Down to the corner and round again, never on a window's spot.
  const corner = layout([
    { instanceId: "back", x: 0, y: 0, width: 200, height: 50, zIndex: 51 },
    { instanceId: "front", x: 80, y: 20, width: 120, height: 30, zIndex: 52 },
  ]);
  const wrapped = placeFloatingRect(corner, "new", { width: 120, height: 30 }, W, H);
  expect(wrapped.x + wrapped.width).toBeLessThanOrEqual(W);
  expect(wrapped.y + wrapped.height).toBeLessThanOrEqual(H);
  expect([[0, 0], [80, 20]]).not.toContainEqual([wrapped.x, wrapped.y]);
});

test("a cascade steps past a spot that would cover all of a small focused pane", () => {
  // The focused window sits exactly where the next cascade step would swallow it.
  const crowded = layout([
    { instanceId: "back", x: 0, y: 0, width: 200, height: 50, zIndex: 51 },
    { instanceId: "front", x: 10, y: 5, width: 120, height: 30, zIndex: 53 },
    { instanceId: "small", x: 20, y: 10, width: 20, height: 8, zIndex: 52 },
  ]);
  const rect = placeFloatingRect(crowded, "new", { width: 120, height: 30 }, W, H, { focusedPaneId: "small" });
  expect(covers(rect, { x: 20, y: 10, width: 20, height: 8 })).toBe(false);
});

test("a pane floated back to its remembered spot steps off a window already there", () => {
  const base = layout([{ instanceId: "other", x: 10, y: 5, width: 60, height: 20, zIndex: 51 }]);
  const withMemory: LayoutConfig = {
    ...base,
    instances: base.instances.map((instance) => (
      instance.instanceId === "side" ? { ...instance, placementMemory: { floating: { x: 10, y: 5, width: 60, height: 20 } } } : instance
    )),
  };
  const floated = floatPane(withMemory, "side", W, H).floating.find((entry) => entry.instanceId === "side");
  expect(floated).toMatchObject({ x: 12, y: 6, width: 60, height: 20 });
});
