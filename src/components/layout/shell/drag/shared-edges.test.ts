import { describe, expect, test } from "bun:test";
import { applySharedEdges, NO_SHARED_EDGES, resolveSharedEdges } from "./shared-edges";

// a | b side by side, c under both; d far away on the right.
const a = { id: "a", rect: { x: 0, y: 0, width: 40, height: 20 } };
const b = { id: "b", rect: { x: 40, y: 0, width: 40, height: 20 } };
const c = { id: "c", rect: { x: 0, y: 20, width: 80, height: 10 } };
const d = { id: "d", rect: { x: 100, y: 0, width: 20, height: 20 } };
const AREA = { width: 120, height: 40 };

describe("floating windows snapped edge to edge resize together", () => {
  test("dragging the edge two windows share moves it for both, and nothing else", () => {
    const groups = resolveSharedEdges([a, b, c, d], a, { x: 1, y: 0 });
    expect([...groups.ids].sort()).toEqual(["a", "b"]);
    const rects = applySharedEdges(groups, "a", { ...a.rect, width: 50 }, AREA);
    expect(rects.get("a")).toMatchObject({ x: 0, width: 50 });
    expect(rects.get("b")).toMatchObject({ x: 50, width: 30 });
  });

  test("a row along one line moves as one, and the line stops where a window would go under its minimum", () => {
    // a's bottom edge: c is across it, and b sits on the same line beside c.
    const groups = resolveSharedEdges([a, b, c], a, { x: 0, y: 1 });
    expect([...groups.ids].sort()).toEqual(["a", "b", "c"]);
    const rects = applySharedEdges(groups, "a", { ...a.rect, height: 28 }, AREA);
    // c keeps its 6-row minimum: the line stops at 24.
    expect(rects.get("c")).toMatchObject({ y: 24, height: 6 });
    expect(rects.get("b")).toMatchObject({ y: 0, height: 24 });
    expect(rects.get("a")).toMatchObject({ y: 0, height: 24 });
  });

  test("a window alone on its edge resizes alone", () => {
    expect(resolveSharedEdges([a, b, c, d], d, { x: -1, y: 0 })).toBe(NO_SHARED_EDGES);
  });
});
