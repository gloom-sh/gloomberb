import { describe, expect, test } from "bun:test";
import type { MetricTreemapItem } from "./layout";
import { buildMetricTreemapScene, type MetricTreemapSceneOptions, type TreemapRect } from "./scene";

const FLOAT: MetricTreemapSceneOptions = {
  snap: false,
  aspect: 1,
  groupInset: 0,
  subgroupInset: 0,
  headerHeight: [0, 0],
  headerMin: [{ width: Infinity, height: Infinity }, { width: Infinity, height: Infinity }],
  minTile: { width: 0, height: 0 },
};

function item(id: string, weight: number, group?: string, subgroup?: string): MetricTreemapItem<string> {
  return { id, label: id, weight, group, subgroup, data: id };
}

function area(rect: TreemapRect): number {
  return rect.width * rect.height;
}

function overlaps(left: TreemapRect, right: TreemapRect): boolean {
  const epsilon = 1e-6;
  return left.x < right.x + right.width - epsilon
    && right.x < left.x + left.width - epsilon
    && left.y < right.y + right.height - epsilon
    && right.y < left.y + left.height - epsilon;
}

/** A market-like board: a few groups, a few subgroups each, a long tail of small names. */
function board(count: number): Array<MetricTreemapItem<string>> {
  return Array.from({ length: count }, (_, index) => item(
    `N${index}`,
    1000 / (index + 1) ** 1.1,
    `G${index % 4}`,
    `S${index % 4}-${index % 3}`,
  ));
}

describe("metric treemap scene", () => {
  test("blocks follow summed weights, tiles follow their own, and the canvas is filled without overlap", () => {
    const items = [
      item("a", 6, "Tech", "Chips"), item("b", 2, "Tech", "Chips"), item("c", 4, "Tech", "Software"),
      item("d", 3, "Banks", "Banks"), item("e", 1, "Banks", "Banks"),
      item("f", 4, "Energy", "Oil"),
    ];
    const scene = buildMetricTreemapScene(items, 400, 300, FLOAT);
    const total = 20;
    const tileArea = (id: string) => area(scene.tiles.find((tile) => tile.item.id === id)!);

    expect(scene.tiles).toHaveLength(items.length);
    expect(scene.other).toBeNull();
    for (const entry of items) expect(tileArea(entry.id)).toBeCloseTo((entry.weight as number) / total * 400 * 300, 3);
    expect(scene.tiles.reduce((sum, tile) => sum + area(tile), 0)).toBeCloseTo(400 * 300, 3);
    for (const [index, tile] of scene.tiles.entries()) {
      for (const other of scene.tiles.slice(index + 1)) expect(overlaps(tile, other)).toBe(false);
    }
    // Tiles of one group sit together: reading order walks a group before the next.
    expect(scene.tiles.map((tile) => tile.item.group)).toEqual(["Tech", "Tech", "Tech", "Banks", "Banks", "Energy"]);
  });

  test("headers reserve their band, and a block too small for one gets none", () => {
    const items = [
      item("a", 40, "Tech", "Chips"), item("a2", 20, "Tech", "Chips"), item("b", 30, "Tech", "Software"),
      item("c", 15, "Banks", "Banks"), item("d", 0.5, "Tiny", "Tiny"),
    ];
    const scene = buildMetricTreemapScene(items, 400, 300, {
      ...FLOAT,
      groupInset: 2,
      subgroupInset: 1,
      headerHeight: [16, 12],
      headerMin: [{ width: 40, height: 40 }, { width: 40, height: 30 }],
    });

    expect(scene.headers.map((header) => header.label).sort()).toEqual(["Banks", "Chips", "Tech"]);
    for (const header of scene.headers) {
      for (const tile of scene.tiles) expect(overlaps(header.rect, tile)).toBe(false);
    }
    const tech = scene.headers.find((header) => header.label === "Tech")!;
    const chips = scene.headers.find((header) => header.label === "Chips")!;
    expect(chips.rect.y).toBeGreaterThanOrEqual(tech.rect.y + tech.rect.height);
    // One subgroup in a group says nothing its group header does not.
    expect(scene.headers.filter((header) => header.label === "Banks").map((header) => header.level)).toEqual([0]);
  });

  test("names too small to draw fold into Other, laid out last, and every drawn tile meets the minimum", () => {
    const items = board(400);
    const minTile = { width: 10, height: 10 };
    const scene = buildMetricTreemapScene(items, 400, 300, {
      ...FLOAT,
      groupInset: 2,
      headerHeight: [14, 12],
      headerMin: [{ width: 40, height: 40 }, { width: 50, height: 34 }],
      minTile,
    });
    const drawn = new Set(scene.tiles.map((tile) => tile.item.id));

    expect(scene.other).not.toBeNull();
    expect(scene.tiles.length + scene.other!.items.length).toBe(items.length);
    expect(scene.other!.items.every((entry) => !drawn.has(entry.id))).toBe(true);
    expect(scene.tiles.every((tile) => tile.width >= minTile.width && tile.height >= minTile.height)).toBe(true);
    // The largest names always draw; what folds is the tail.
    expect(items.slice(0, 40).every((entry) => drawn.has(entry.id))).toBe(true);
    const otherRect = scene.other!.rect;
    expect(otherRect.x + otherRect.width > 380 || otherRect.y + otherRect.height > 280).toBe(true);
    for (const tile of scene.tiles) expect(overlaps(tile, otherRect)).toBe(false);
  });

  test("a cell grid snaps every edge to whole cells, inside the canvas, without overlap", () => {
    const scene = buildMetricTreemapScene(board(300), 196, 55, {
      snap: true,
      aspect: 2.25,
      groupInset: 0,
      subgroupInset: 0,
      headerHeight: [1, 1],
      headerMin: [{ width: 8, height: 4 }, { width: 14, height: 6 }],
      minTile: { width: 3, height: 1 },
    });
    const rects = [...scene.tiles, ...scene.headers.map((header) => header.rect), ...(scene.other ? [scene.other.rect] : [])];

    expect(scene.tiles.length).toBeGreaterThan(50);
    for (const rect of rects) {
      for (const value of [rect.x, rect.y, rect.width, rect.height]) expect(Number.isInteger(value)).toBe(true);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.width).toBeLessThanOrEqual(196);
      expect(rect.y + rect.height).toBeLessThanOrEqual(55);
    }
    for (const [index, rect] of rects.entries()) {
      for (const other of rects.slice(index + 1)) expect(overlaps(rect, other)).toBe(false);
    }
  });

  test("names without a group share one quiet Other block with the folded tail; a one-name industry gets no header", () => {
    const items = [
      item("a", 50, "Tech", "Chips"), item("b", 30, "Tech", "Chips"), item("c", 40, "Tech", "Software"),
      item("d", 30, "Banks", "Banks"), item("e", 20, "Banks", "Lenders"),
      item("x", 15), item("y", 10),
      ...Array.from({ length: 40 }, (_, index) => item(`t${index}`, 0.02, "Banks", "Lenders")),
    ];
    const scene = buildMetricTreemapScene(items, 600, 400, {
      ...FLOAT,
      groupInset: 2,
      subgroupInset: 1,
      headerHeight: [16, 12],
      headerMin: [{ width: 40, height: 40 }, { width: 60, height: 40 }],
      minTile: { width: 8, height: 8 },
    });
    const otherHeader = scene.headers.find((header) => header.other)!;
    const tile = (id: string) => scene.tiles.find((entry) => entry.item.id === id)!;

    expect(otherHeader).toBeDefined();
    expect(scene.headers.map((header) => header.label)).toContain("Chips");
    expect(scene.headers.map((header) => header.label)).not.toContain("Software");
    expect(scene.headers.map((header) => header.label)).not.toContain("Lenders");
    // The unclassified names draw, under the Other header, beside the folded tail.
    for (const id of ["x", "y"]) {
      expect(tile(id).y).toBeGreaterThanOrEqual(otherHeader.rect.y + otherHeader.rect.height);
      expect(tile(id).x).toBeGreaterThanOrEqual(otherHeader.rect.x - 1e-6);
    }
    expect(scene.other!.items).toHaveLength(40);
    expect(scene.other!.showLabel).toBe(false);
    expect(scene.other!.rect.y).toBeGreaterThanOrEqual(otherHeader.rect.y + otherHeader.rect.height);
    for (const entry of scene.tiles) expect(overlaps(entry, scene.other!.rect)).toBe(false);
  });

  test("a relayout keeps blocks in place through small size changes, and lets a clear overtake through", () => {
    const board = (tech: number, banks: number) => [
      item("a", tech * 0.6, "Tech", "Chips"), item("b", tech * 0.4, "Tech", "Chips"),
      item("c", banks * 0.7, "Banks", "Banks"), item("d", banks * 0.3, "Banks", "Banks"),
      item("e", 40, "Energy", "Oil"),
    ];
    const order = (scene: ReturnType<typeof buildMetricTreemapScene<string>>) => [...new Set(scene.tiles.map((tile) => tile.item.group))];
    const first = buildMetricTreemapScene(board(100, 97), 400, 300, FLOAT);
    expect(order(first)).toEqual(["Tech", "Banks", "Energy"]);
    // Banks edges past Tech by 3%: without the last layout it would lead, with it the board stays put.
    expect(order(buildMetricTreemapScene(board(97, 100), 400, 300, FLOAT))).toEqual(["Banks", "Tech", "Energy"]);
    const nudged = buildMetricTreemapScene(board(97, 100), 400, 300, FLOAT, first);
    expect(order(nudged)).toEqual(["Tech", "Banks", "Energy"]);
    expect(order(buildMetricTreemapScene(board(90, 110), 400, 300, FLOAT, nudged))).toEqual(["Banks", "Tech", "Energy"]);
  });

  test("items without groups lay out flat, with no header", () => {
    const scene = buildMetricTreemapScene([item("a", 3), item("b", 2), item("c", 1)], 120, 80, {
      ...FLOAT,
      headerHeight: [16, 12],
      headerMin: [{ width: 1, height: 1 }, { width: 1, height: 1 }],
    });
    expect(scene.headers).toEqual([]);
    expect(scene.tiles.map((tile) => tile.item.id)).toEqual(["a", "b", "c"]);
  });
});
