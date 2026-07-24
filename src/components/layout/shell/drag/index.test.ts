import { describe, expect, test } from "bun:test";
import { createPaneInstance, type LayoutConfig } from "../../../../types/config";
import { getDockLeafLayouts } from "../../../../plugins/pane-manager";
import {
  createCompactedDropPreview,
  createLeafDropPreview,
  createSnapDropPreview,
  constrainFloatingRectToBounds,
  finalizePaneDragRelease,
  LAYOUT_GRID_COLUMNS,
  LAYOUT_GRID_ROWS,
  makeLayoutGridCells,
  makeSnapGuides,
  resolveFloatResizeRect,
  resolveSnapGuide,
} from "./index";

const BOUNDS = { x: 0, y: 0, width: 120, height: 60 };

function threePaneLayout(): LayoutConfig {
  return {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "a:main" },
      second: {
        kind: "split",
        axis: "vertical",
        ratio: 0.5,
        first: { kind: "pane", instanceId: "b:main" },
        second: { kind: "pane", instanceId: "c:main" },
      },
    },
    instances: [
      createPaneInstance("a", { instanceId: "a:main" }),
      createPaneInstance("b", { instanceId: "b:main" }),
      createPaneInstance("c", { instanceId: "c:main" }),
    ],
    floating: [],
    detached: [],
  };
}

describe("layout construction grid", () => {
  test("builds a visible 6x6 grid whose cells cover odd dashboard bounds", () => {
    const cells = makeLayoutGridCells(121, 41);

    expect(cells).toHaveLength(LAYOUT_GRID_COLUMNS * LAYOUT_GRID_ROWS);
    expect(cells[0]?.rect).toEqual({ x: 0, y: 0, width: 20, height: 6 });
    expect(cells.at(-1)?.rect).toEqual({ x: 100, y: 34, width: 21, height: 7 });
    expect(Math.max(...cells.map((cell) => cell.rect.x + cell.rect.width))).toBe(121);
    expect(Math.max(...cells.map((cell) => cell.rect.y + cell.rect.height))).toBe(41);
  });

  test("resolves every pointer position to the matching highlighted cell", () => {
    const guides = makeSnapGuides(120, 42);

    expect(guides).toHaveLength(36);
    expect(resolveSnapGuide(0, 0, guides)).toMatchObject({
      position: "cell-1-1",
      previewRect: { x: 0, y: 0, width: 20, height: 7 },
    });
    expect(resolveSnapGuide(119, 41, guides)).toMatchObject({
      position: "cell-6-6",
      previewRect: { x: 100, y: 35, width: 20, height: 7 },
    });
    expect(resolveSnapGuide(120, 41, guides)).toBeNull();
  });

  test("coarsens the grid safely when the content area is smaller than 6x6", () => {
    const guides = makeSnapGuides(3, 2);
    expect(guides).toHaveLength(6);
    expect(guides.every((guide) => guide.previewRect.width === 1 && guide.previewRect.height === 1)).toBe(true);
  });

  test("builds a deterministic compact preview outside the explicit target overlay", () => {
    const layout = threePaneLayout();
    const targetLeaf = getDockLeafLayouts(layout, BOUNDS, { reserveDividerGutters: true })
      .find((leaf) => leaf.instanceId === "b:main")!;
    const preview = createCompactedDropPreview(
      layout,
      "a:main",
      targetLeaf,
      targetLeaf.rect.x + targetLeaf.rect.width - 1,
      targetLeaf.rect.y + Math.floor(targetLeaf.rect.height / 2),
      BOUNDS,
      { reserveDividerGutters: true },
    );

    expect(preview).not.toBeNull();
    expect(preview!.kind).toBe("compact");
    expect(preview!.layout.dockRoot).toMatchObject({
      kind: "split",
      axis: "vertical",
      first: {
        kind: "split",
        axis: "horizontal",
        first: { kind: "pane", instanceId: "b:main" },
        second: { kind: "pane", instanceId: "a:main" },
      },
      second: { kind: "pane", instanceId: "c:main" },
    });
    expect(finalizePaneDragRelease(
      layout,
      "a:main",
      { x: 9, y: 8, width: 20, height: 10 },
      preview,
    ).nextLayout).toEqual(preview!.layout);
  });

  for (const directionalCase of [
    {
      position: "top" as const,
      axis: "vertical" as const,
      order: ["a:main", "b:main"],
      previewRects: [
        { instanceId: "a:main", rect: { x: 0, y: 0, width: 120, height: 15 } },
        { instanceId: "b:main", rect: { x: 0, y: 16, width: 120, height: 14 } },
        { instanceId: "c:main", rect: { x: 0, y: 31, width: 120, height: 29 } },
      ],
      committedRects: [
        { instanceId: "a:main", rect: { x: 0, y: 0, width: 120, height: 15 } },
        { instanceId: "b:main", rect: { x: 0, y: 16, width: 120, height: 14 } },
        { instanceId: "c:main", rect: { x: 0, y: 31, width: 120, height: 29 } },
      ],
    },
    {
      position: "left" as const,
      axis: "horizontal" as const,
      order: ["a:main", "b:main"],
      previewRects: [
        { instanceId: "a:main", rect: { x: 0, y: 0, width: 60, height: 30 } },
        { instanceId: "c:main", rect: { x: 0, y: 31, width: 120, height: 29 } },
      ],
      committedRects: [
        { instanceId: "a:main", rect: { x: 0, y: 0, width: 60, height: 30 } },
        { instanceId: "b:main", rect: { x: 61, y: 0, width: 59, height: 30 } },
        { instanceId: "c:main", rect: { x: 0, y: 31, width: 120, height: 29 } },
      ],
    },
    {
      position: "right" as const,
      axis: "horizontal" as const,
      order: ["b:main", "a:main"],
      previewRects: [
        { instanceId: "b:main", rect: { x: 0, y: 0, width: 60, height: 30 } },
        { instanceId: "a:main", rect: { x: 61, y: 0, width: 59, height: 30 } },
        { instanceId: "c:main", rect: { x: 0, y: 31, width: 120, height: 29 } },
      ],
      committedRects: [
        { instanceId: "b:main", rect: { x: 0, y: 0, width: 60, height: 30 } },
        { instanceId: "a:main", rect: { x: 61, y: 0, width: 59, height: 30 } },
        { instanceId: "c:main", rect: { x: 0, y: 31, width: 120, height: 29 } },
      ],
    },
    {
      position: "bottom" as const,
      axis: "vertical" as const,
      order: ["b:main", "a:main"],
      previewRects: [
        { instanceId: "b:main", rect: { x: 0, y: 0, width: 120, height: 15 } },
        { instanceId: "a:main", rect: { x: 0, y: 16, width: 120, height: 14 } },
        { instanceId: "c:main", rect: { x: 0, y: 31, width: 120, height: 29 } },
      ],
      committedRects: [
        { instanceId: "b:main", rect: { x: 0, y: 0, width: 120, height: 15 } },
        { instanceId: "a:main", rect: { x: 0, y: 16, width: 120, height: 14 } },
        { instanceId: "c:main", rect: { x: 0, y: 31, width: 120, height: 29 } },
      ],
    },
  ]) {
    test(`routes the ${directionalCase.position} cell to an exact target-relative preview and commit`, () => {
      const layout = threePaneLayout();
      const preview = createLeafDropPreview(
        layout,
        "a:main",
        { kind: "leaf", targetId: "b:main", position: directionalCase.position },
        BOUNDS,
        { reserveDividerGutters: true },
      );

      expect(preview).not.toBeNull();
      expect(preview!.layout.dockRoot).toMatchObject({
        kind: "split",
        axis: "vertical",
        first: {
          kind: "split",
          axis: directionalCase.axis,
          first: { kind: "pane", instanceId: directionalCase.order[0] },
          second: { kind: "pane", instanceId: directionalCase.order[1] },
        },
        second: { kind: "pane", instanceId: "c:main" },
      });
      expect(preview!.rects).toEqual(directionalCase.previewRects);

      const committed = finalizePaneDragRelease(
        layout,
        "a:main",
        { x: 9, y: 8, width: 20, height: 10 },
        preview,
      ).nextLayout;
      expect(committed).toEqual(preview!.layout);
      expect(getDockLeafLayouts(committed, BOUNDS, { reserveDividerGutters: true })
        .map(({ instanceId, rect }) => ({ instanceId, rect })))
        .toEqual(directionalCase.committedRects);
    });
  }

  test("commits the selected grid cell exactly for one-pane and empty-grid layouts", () => {
    const target = { x: 80, y: 40, width: 20, height: 10 };
    const dockedOnly: LayoutConfig = {
      dockRoot: { kind: "pane", instanceId: "a:main" },
      instances: [createPaneInstance("a", { instanceId: "a:main" })],
      floating: [],
      detached: [],
    };
    const floatingOnly: LayoutConfig = {
      ...dockedOnly,
      dockRoot: null,
      floating: [{ instanceId: "a:main", x: 5, y: 5, width: 40, height: 20, zIndex: 70 }],
    };

    for (const layout of [dockedOnly, floatingOnly]) {
      const preview = createSnapDropPreview(layout, "a:main", "cell-5-5", target, BOUNDS);
      expect(preview.rect).toEqual(target);
      expect(preview.layout.dockRoot).toBeNull();
      expect(preview.layout.floating.find((entry) => entry.instanceId === "a:main"))
        .toEqual(expect.objectContaining({ ...target, fixedGeometry: true }));
      expect(preview.rects).toEqual([{ instanceId: "a:main", rect: target }]);
    }
  });

  test("preserves fixed cells without weakening ordinary floating minimums", () => {
    const selectedCell = { x: 50, y: 30, width: 10, height: 3 };

    expect(constrainFloatingRectToBounds({ ...selectedCell, fixedGeometry: true }, 60, 36))
      .toEqual({ ...selectedCell, fixedGeometry: true });
    expect(constrainFloatingRectToBounds(selectedCell, 60, 36))
      .toEqual({ x: 45, y: 30, width: 15, height: 6 });
  });

  test("resizes a snapped grid cell without expanding it or losing fixed geometry", () => {
    const rect = resolveFloatResizeRect({
      corner: "bottom-right",
      startX: 56,
      startY: 33,
      origRect: { x: 50, y: 30, width: 6, height: 3, zIndex: 75, fixedGeometry: true },
    }, 58, 34, 120, 60);

    expect(rect).toEqual({
      x: 50,
      y: 30,
      width: 8,
      height: 4,
      zIndex: 75,
      fixedGeometry: true,
    });
  });
});
