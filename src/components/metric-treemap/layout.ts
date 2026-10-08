export interface MetricTreemapItem<T = unknown> {
  id: string;
  label: string;
  weight: number | null | undefined;
  colorValue?: number | null;
  primaryText?: string | null;
  secondaryText?: string | null;
  tertiaryText?: string | null;
  /** Optional hierarchy for the heat map layout (a sector); the flat layouts ignore it. */
  group?: string | null;
  /** Second level inside `group` (an industry). */
  subgroup?: string | null;
  /** Hover lines on the desktop heat map, the first one emphasised. */
  tooltip?: readonly string[];
  data: T;
}

export interface MetricTreemapTile<T = unknown> {
  item: MetricTreemapItem<T>;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FloatMetricTreemapTile<T = unknown> {
  item: MetricTreemapItem<T>;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MetricTreemapDirection = "left" | "right" | "up" | "down";
export type MetricTreemapLayoutMode = "integer" | "float";

export interface MetricTreemapLayoutOptions {
  maxItems?: number;
  minTileWidth?: number;
  minTileHeight?: number;
}

interface WeightedTreemapItem<T> {
  item: MetricTreemapItem<T>;
  weight: number;
  area: number;
}

interface TreemapGroup<T> {
  items: WeightedTreemapItem<T>[];
  weight: number;
}

interface FloatRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_TREEMAP_ITEMS = 160;
const DEFAULT_MIN_TILE_WIDTH = 3;
const DEFAULT_MIN_TILE_HEIGHT = 1.8;

function itemWeight(item: MetricTreemapItem): number {
  return Math.max(item.weight ?? 0, 0);
}

function worstAspectRatio<T>(items: WeightedTreemapItem<T>[], sideLength: number): number {
  if (items.length === 0 || sideLength <= 0) return Number.POSITIVE_INFINITY;
  const areaSum = items.reduce((sum, item) => sum + item.area, 0);
  const minArea = Math.min(...items.map((item) => item.area));
  const maxArea = Math.max(...items.map((item) => item.area));
  if (areaSum <= 0 || minArea <= 0) return Number.POSITIVE_INFINITY;

  const sideSquared = sideLength * sideLength;
  return Math.max(
    (sideSquared * maxArea) / (areaSum * areaSum),
    (areaSum * areaSum) / (sideSquared * minArea),
  );
}

function layoutFloatGroup<T>(items: WeightedTreemapItem<T>[], rect: FloatRect): FloatRect {
  const areaSum = items.reduce((sum, item) => sum + item.area, 0);
  if (areaSum <= 0 || rect.width <= 0 || rect.height <= 0) return rect;

  if (rect.width >= rect.height) {
    const columnWidth = Math.min(rect.width, areaSum / rect.height);
    return {
      x: rect.x + columnWidth,
      y: rect.y,
      width: Math.max(0, rect.width - columnWidth),
      height: rect.height,
    };
  }

  const rowHeight = Math.min(rect.height, areaSum / rect.width);
  return {
    x: rect.x,
    y: rect.y + rowHeight,
    width: rect.width,
    height: Math.max(0, rect.height - rowHeight),
  };
}

function buildSquarifiedGroups<T>(items: WeightedTreemapItem<T>[], width: number, height: number): TreemapGroup<T>[] {
  const groups: TreemapGroup<T>[] = [];
  let rect: FloatRect = { x: 0, y: 0, width, height };
  let index = 0;

  while (index < items.length && rect.width > 0 && rect.height > 0) {
    const group: WeightedTreemapItem<T>[] = [];
    let currentWorst = Number.POSITIVE_INFINITY;
    const sideLength = Math.min(rect.width, rect.height);

    while (index < items.length) {
      const candidate = items[index]!;
      const nextGroup = [...group, candidate];
      const nextWorst = worstAspectRatio(nextGroup, sideLength);
      if (group.length > 0 && nextWorst > currentWorst) break;
      group.push(candidate);
      currentWorst = nextWorst;
      index += 1;
    }

    groups.push({
      items: group,
      weight: group.reduce((sum, item) => sum + item.weight, 0),
    });
    rect = layoutFloatGroup(group, rect);
  }

  return groups;
}

function normalizeWeightedItems<T>(
  items: MetricTreemapItem<T>[],
  width: number,
  height: number,
  cellAspect: number,
  maxItems: number,
): WeightedTreemapItem<T>[] {
  const weightedItems = items
    .map((item) => ({ item, weight: itemWeight(item) }))
    .filter((item) => item.weight > 0)
    .slice(0, maxItems);
  const totalWeight = weightedItems.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return [];

  const normalizedHeight = height * cellAspect;
  const totalArea = width * normalizedHeight;
  return weightedItems.map((item) => ({
    ...item,
    area: item.weight / totalWeight * totalArea,
  }));
}

function maxItemsForLayout(width: number, height: number, options?: MetricTreemapLayoutOptions): number {
  const requested = options?.maxItems ?? width * height;
  return Math.max(1, Math.min(MAX_TREEMAP_ITEMS, Math.floor(requested)));
}

function isTooSmall(
  tile: { width: number; height: number },
  options: MetricTreemapLayoutOptions | undefined,
  defaultMinTileWidth: number,
  defaultMinTileHeight: number,
): boolean {
  const minTileWidth = options?.minTileWidth ?? defaultMinTileWidth;
  const minTileHeight = options?.minTileHeight ?? defaultMinTileHeight;
  return tile.width < minTileWidth || tile.height < minTileHeight;
}

function allocateLengths(totalLength: number, weights: number[]): number[] {
  if (weights.length === 0 || totalLength <= 0) return [];
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let remainingLength = totalLength;
  let remainingWeight = totalWeight;

  return weights.map((weight, index) => {
    const remainingItems = weights.length - index;
    if (remainingItems === 1) return remainingLength;
    const ideal = remainingWeight > 0 ? Math.round(remainingLength * weight / remainingWeight) : 1;
    const length = Math.max(1, Math.min(remainingLength - (remainingItems - 1), ideal));
    remainingLength -= length;
    remainingWeight -= weight;
    return length;
  });
}

function buildMetricTreemapRectsForLimit<T>(
  items: MetricTreemapItem<T>[],
  width: number,
  height: number,
  cellAspect = 1,
  maxItems = maxItemsForLayout(width, height),
): FloatMetricTreemapTile<T>[] {
  if (width <= 0 || height <= 0) return [];
  const normalizedCellAspect = Math.max(0.25, cellAspect);
  const weightedItems = normalizeWeightedItems(items, width, height, normalizedCellAspect, maxItems);
  if (weightedItems.length === 0) return [];

  const normalizedHeight = height * normalizedCellAspect;
  const groups = buildSquarifiedGroups(weightedItems, width, normalizedHeight);
  const tiles: FloatMetricTreemapTile<T>[] = [];
  let rect: FloatRect = { x: 0, y: 0, width, height: normalizedHeight };

  for (const group of groups) {
    const areaSum = group.items.reduce((sum, item) => sum + item.area, 0);
    if (areaSum <= 0 || rect.width <= 0 || rect.height <= 0) break;

    if (rect.width >= rect.height) {
      const columnWidth = Math.min(rect.width, areaSum / rect.height);
      let itemY = rect.y;
      for (const item of group.items) {
        const itemHeight = Math.min(rect.y + rect.height - itemY, item.area / columnWidth);
        tiles.push({
          item: item.item,
          x: rect.x,
          y: itemY / normalizedCellAspect,
          width: columnWidth,
          height: itemHeight / normalizedCellAspect,
        });
        itemY += itemHeight;
      }
      rect = {
        x: rect.x + columnWidth,
        y: rect.y,
        width: Math.max(0, rect.width - columnWidth),
        height: rect.height,
      };
    } else {
      const rowHeight = Math.min(rect.height, areaSum / rect.width);
      let itemX = rect.x;
      for (const item of group.items) {
        const itemWidth = Math.min(rect.x + rect.width - itemX, item.area / rowHeight);
        tiles.push({
          item: item.item,
          x: itemX,
          y: rect.y / normalizedCellAspect,
          width: itemWidth,
          height: rowHeight / normalizedCellAspect,
        });
        itemX += itemWidth;
      }
      rect = {
        x: rect.x,
        y: rect.y + rowHeight,
        width: rect.width,
        height: Math.max(0, rect.height - rowHeight),
      };
    }
  }

  return tiles.filter((tile) => tile.width > 0 && tile.height > 0);
}

export function buildMetricTreemapRects<T>(
  items: MetricTreemapItem<T>[],
  width: number,
  height: number,
  cellAspect = 1,
  options?: MetricTreemapLayoutOptions,
): FloatMetricTreemapTile<T>[] {
  let limit = maxItemsForLayout(width, height, options);
  let lastTiles: FloatMetricTreemapTile<T>[] = [];

  while (limit > 0) {
    const tiles = buildMetricTreemapRectsForLimit(items, width, height, cellAspect, limit);
    lastTiles = tiles;
    const firstSmallIndex = tiles.findIndex((tile) => isTooSmall(tile, options, DEFAULT_MIN_TILE_WIDTH, DEFAULT_MIN_TILE_HEIGHT));
    if (firstSmallIndex < 0) return tiles;
    limit = Math.min(limit - 1, firstSmallIndex);
  }

  return lastTiles.filter((tile) => !isTooSmall(tile, options, DEFAULT_MIN_TILE_WIDTH, DEFAULT_MIN_TILE_HEIGHT));
}

function buildMetricTreemapForLimit<T>(
  items: MetricTreemapItem<T>[],
  width: number,
  height: number,
  cellAspect = 1,
  maxItems = maxItemsForLayout(width, height),
): MetricTreemapTile<T>[] {
  if (width <= 0 || height <= 0) return [];
  const normalizedCellAspect = Math.max(0.25, cellAspect);
  const weightedItems = normalizeWeightedItems(items, width, height, normalizedCellAspect, maxItems);
  if (weightedItems.length === 0) return [];

  const normalizedHeight = height * normalizedCellAspect;
  const groups = buildSquarifiedGroups(weightedItems, width, normalizedHeight);
  const tiles: MetricTreemapTile<T>[] = [];

  let x = 0;
  let y = 0;
  let remainingWidth = width;
  let remainingHeight = height;
  let remainingWeight = groups.reduce((sum, group) => sum + group.weight, 0);

  groups.forEach((group, groupIndex) => {
    if (remainingWidth <= 0 || remainingHeight <= 0) return;
    const isLastGroup = groupIndex === groups.length - 1;
    const remainingNormalizedHeight = remainingHeight * normalizedCellAspect;

    if (remainingWidth >= remainingNormalizedHeight) {
      const columnWidth = isLastGroup
        ? remainingWidth
        : Math.max(1, Math.min(remainingWidth - 1, Math.round(remainingWidth * group.weight / remainingWeight)));
      const heights = allocateLengths(remainingHeight, group.items.map((item) => item.weight));
      let tileY = y;
      group.items.forEach((item, itemIndex) => {
        const tileHeight = heights[itemIndex] ?? 0;
        if (tileHeight > 0) {
          tiles.push({ item: item.item, x, y: tileY, width: columnWidth, height: tileHeight });
        }
        tileY += tileHeight;
      });
      x += columnWidth;
      remainingWidth -= columnWidth;
    } else {
      const rowHeight = isLastGroup
        ? remainingHeight
        : Math.max(1, Math.min(remainingHeight - 1, Math.round(remainingHeight * group.weight / remainingWeight)));
      const widths = allocateLengths(remainingWidth, group.items.map((item) => item.weight));
      let tileX = x;
      group.items.forEach((item, itemIndex) => {
        const tileWidth = widths[itemIndex] ?? 0;
        if (tileWidth > 0) {
          tiles.push({ item: item.item, x: tileX, y, width: tileWidth, height: rowHeight });
        }
        tileX += tileWidth;
      });
      y += rowHeight;
      remainingHeight -= rowHeight;
    }

    remainingWeight -= group.weight;
  });

  return tiles.filter((tile) => tile.width > 0 && tile.height > 0);
}

export function buildMetricTreemap<T>(
  items: MetricTreemapItem<T>[],
  width: number,
  height: number,
  cellAspect = 1,
  options?: MetricTreemapLayoutOptions,
): MetricTreemapTile<T>[] {
  let limit = maxItemsForLayout(width, height, options);
  let lastTiles: MetricTreemapTile<T>[] = [];

  while (limit > 0) {
    const tiles = buildMetricTreemapForLimit(items, width, height, cellAspect, limit);
    lastTiles = tiles;
    const firstSmallIndex = tiles.findIndex((tile) => isTooSmall(tile, options, 2, 1));
    if (firstSmallIndex < 0) return tiles;
    limit = Math.min(limit - 1, firstSmallIndex);
  }

  return lastTiles.filter((tile) => !isTooSmall(tile, options, 2, 1));
}

function center(rect: { x: number; y: number; width: number; height: number }) {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  };
}

function rangeGap(startA: number, endA: number, startB: number, endB: number): number {
  if (endA < startB) return startB - endA;
  if (endB < startA) return startA - endB;
  return 0;
}

function primaryGap(
  current: { x: number; y: number; width: number; height: number },
  candidate: { x: number; y: number; width: number; height: number },
  direction: MetricTreemapDirection,
): number {
  switch (direction) {
    case "left":
      return Math.max(0, current.x - (candidate.x + candidate.width));
    case "right":
      return Math.max(0, candidate.x - (current.x + current.width));
    case "up":
      return Math.max(0, current.y - (candidate.y + candidate.height));
    case "down":
      return Math.max(0, candidate.y - (current.y + current.height));
  }
}

function perpendicularGap(
  current: { x: number; y: number; width: number; height: number },
  candidate: { x: number; y: number; width: number; height: number },
  direction: MetricTreemapDirection,
): number {
  if (direction === "left" || direction === "right") {
    return rangeGap(current.y, current.y + current.height, candidate.y, candidate.y + candidate.height);
  }
  return rangeGap(current.x, current.x + current.width, candidate.x, candidate.x + candidate.width);
}

function isEdgeCandidate(
  current: { x: number; y: number; width: number; height: number },
  candidate: { x: number; y: number; width: number; height: number },
  direction: MetricTreemapDirection,
): boolean {
  const epsilon = 0.0001;
  switch (direction) {
    case "left":
      return candidate.x + candidate.width <= current.x + epsilon;
    case "right":
      return candidate.x >= current.x + current.width - epsilon;
    case "up":
      return candidate.y + candidate.height <= current.y + epsilon;
    case "down":
      return candidate.y >= current.y + current.height - epsilon;
  }
}

function isCenterCandidate(
  currentCenter: { x: number; y: number },
  candidateCenter: { x: number; y: number },
  direction: MetricTreemapDirection,
): boolean {
  switch (direction) {
    case "left":
      return candidateCenter.x < currentCenter.x;
    case "right":
      return candidateCenter.x > currentCenter.x;
    case "up":
      return candidateCenter.y < currentCenter.y;
    case "down":
      return candidateCenter.y > currentCenter.y;
  }
}

export function findMetricTreemapNeighbor<T>(
  tiles: Array<MetricTreemapTile<T> | FloatMetricTreemapTile<T>>,
  selectedId: string | null,
  direction: MetricTreemapDirection,
): MetricTreemapTile<T> | FloatMetricTreemapTile<T> | null {
  if (tiles.length === 0) return null;
  const current = tiles.find((tile) => tile.item.id === selectedId) ?? tiles[0]!;
  const currentCenter = center(current);
  let best: { tile: MetricTreemapTile<T> | FloatMetricTreemapTile<T>; score: number } | null = null;
  const hasEdgeCandidate = tiles.some((tile) => tile.item.id !== current.item.id && isEdgeCandidate(current, tile, direction));

  for (const tile of tiles) {
    if (tile.item.id === current.item.id) continue;
    const candidateCenter = center(tile);
    const isCandidate = hasEdgeCandidate
      ? isEdgeCandidate(current, tile, direction)
      : isCenterCandidate(currentCenter, candidateCenter, direction);
    if (!isCandidate) continue;

    const centerDistance = direction === "left" || direction === "right"
      ? Math.abs(candidateCenter.x - currentCenter.x)
      : Math.abs(candidateCenter.y - currentCenter.y);
    const score = primaryGap(current, tile, direction) * 1000
      + perpendicularGap(current, tile, direction) * 100
      + centerDistance;
    if (!best || score < best.score) best = { tile, score };
  }

  return best?.tile ?? null;
}

export function buildMetricTreemapNavigationTiles<T>(
  items: MetricTreemapItem<T>[],
  width: number,
  height: number,
  cellAspect: number,
  mode: MetricTreemapLayoutMode,
): Array<MetricTreemapTile<T> | FloatMetricTreemapTile<T>> {
  return mode === "float"
    ? buildMetricTreemapRects(items, width, height, cellAspect)
    : buildMetricTreemap(items, width, height, cellAspect);
}
