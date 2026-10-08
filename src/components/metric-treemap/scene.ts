import type { FloatMetricTreemapTile, MetricTreemapItem } from "./layout";

/**
 * A treemap with an optional two-level hierarchy (sector, then industry) and
 * an "Other" block for names too small to draw. Items without a `group` lay
 * out flat. Every block is squarified, so the canvas is always filled; a
 * header band is reserved only where its block has room for it.
 */

export interface TreemapRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MetricTreemapHeader {
  id: string;
  level: 0 | 1;
  /** The group or subgroup key; empty for the Other block, which the surface names. */
  label: string;
  /** The Other block's header: names without a group and the folded tail. */
  other?: boolean;
  rect: TreemapRect;
}

interface MetricTreemapOtherBlock<T> {
  /** The area of the folded names: the whole Other block, or its last part when it also draws tiles. */
  rect: TreemapRect;
  /** Names folded in, largest first. */
  items: MetricTreemapItem<T>[];
  /** Whether this rect names itself; false when the Other header above it already does. */
  showLabel: boolean;
}

export interface MetricTreemapScene<T> {
  width: number;
  height: number;
  tiles: FloatMetricTreemapTile<T>[];
  headers: MetricTreemapHeader[];
  other: MetricTreemapOtherBlock<T> | null;
}

interface BoxSize {
  width: number;
  height: number;
}

export interface MetricTreemapSceneOptions {
  /** Snap every edge to whole units, for a cell grid. */
  snap: boolean;
  /** Height of one y unit in x units, so a square tile looks square. */
  aspect: number;
  /** Space kept around each group and subgroup, in layout units (the gutter between blocks is twice this). */
  groupInset: number;
  subgroupInset: number;
  /** Header band height for groups and subgroups. */
  headerHeight: readonly [number, number];
  /**
   * The smallest block that carries its header. A subgroup header also needs
   * company: a one-name industry never gets one, its tile already says it all.
   */
  headerMin: readonly [BoxSize, BoxSize];
  /** Smaller tiles fold into Other. */
  minTile: BoxSize;
}

interface SubgroupNode<T> {
  key: string | null;
  weight: number;
  items: Array<{ item: MetricTreemapItem<T>; weight: number }>;
}

interface GroupNode<T> {
  key: string | null;
  weight: number;
  subgroups: SubgroupNode<T>[];
}

const MAX_LAYOUT_PASSES = 6;
/** Headers, gutters and squarify slack take part of the canvas; the first guess at what fits allows for it. */
const EXPECTED_AREA_EFFICIENCY = 0.72;
const EMPTY_RECT: TreemapRect = { x: 0, y: 0, width: 0, height: 0 };

function itemWeight(item: MetricTreemapItem): number {
  const weight = item.weight ?? 0;
  return Number.isFinite(weight) && weight > 0 ? weight : 0;
}

function worstRatio(sum: number, min: number, max: number, side: number): number {
  const sideSquared = side * side;
  const sumSquared = sum * sum;
  return Math.max((sideSquared * max) / sumSquared, sumSquared / (sideSquared * min));
}

/**
 * Squarified treemap of `weights`, in order, filling `rect`. Strips share
 * edges computed from one running sum, so snapping a shared edge rounds it
 * the same way for both neighbours and blocks never overlap or gap.
 */
function squarifyRects(
  weights: readonly number[],
  rect: TreemapRect,
  aspect: number,
  snap: boolean,
): TreemapRect[] {
  const out: TreemapRect[] = [];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (weights.length === 0) return out;
  if (!(total > 0) || rect.width <= 0 || rect.height <= 0) {
    return weights.map(() => ({ x: rect.x, y: rect.y, width: 0, height: 0 }));
  }
  const fullWidth = rect.width;
  const fullHeight = rect.height * aspect;
  const scale = (fullWidth * fullHeight) / total;
  const local: TreemapRect[] = new Array(weights.length);
  let x = 0;
  let y = 0;
  let index = 0;

  while (index < weights.length) {
    const width = fullWidth - x;
    const height = fullHeight - y;
    const side = Math.min(width, height);
    let end = index + 1;
    let sum = weights[index]! * scale;
    let min = sum;
    let max = sum;
    let worst = worstRatio(sum, min, max, side);
    while (end < weights.length) {
      const area = weights[end]! * scale;
      const nextSum = sum + area;
      const nextMin = Math.min(min, area);
      const nextMax = Math.max(max, area);
      const nextWorst = worstRatio(nextSum, nextMin, nextMax, side);
      if (nextWorst > worst) break;
      sum = nextSum;
      min = nextMin;
      max = nextMax;
      worst = nextWorst;
      end += 1;
    }
    const last = end === weights.length;
    if (width >= height) {
      const stripWidth = last ? width : Math.min(width, sum / height);
      let cursor = y;
      for (let k = index; k < end; k += 1) {
        const itemHeight = k === end - 1 ? fullHeight - cursor : (weights[k]! * scale) / stripWidth;
        local[k] = { x, y: cursor, width: stripWidth, height: itemHeight };
        cursor += itemHeight;
      }
      x += stripWidth;
    } else {
      const stripHeight = last ? height : Math.min(height, sum / width);
      let cursor = x;
      for (let k = index; k < end; k += 1) {
        const itemWidth = k === end - 1 ? fullWidth - cursor : (weights[k]! * scale) / stripHeight;
        local[k] = { x: cursor, y, width: itemWidth, height: stripHeight };
        cursor += itemWidth;
      }
      y += stripHeight;
    }
    index = end;
  }

  for (const box of local) {
    if (snap) {
      const left = Math.round(box.x);
      const right = Math.round(box.x + box.width);
      const top = Math.round(box.y / aspect);
      const bottom = Math.round((box.y + box.height) / aspect);
      out.push({ x: rect.x + left, y: rect.y + top, width: right - left, height: bottom - top });
    } else {
      out.push({ x: rect.x + box.x, y: rect.y + box.y / aspect, width: box.width, height: box.height / aspect });
    }
  }
  return out;
}

function inset(rect: TreemapRect, amount: number): TreemapRect {
  if (amount <= 0) return rect;
  const dx = Math.min(amount, rect.width / 2);
  const dy = Math.min(amount, rect.height / 2);
  return { x: rect.x + dx, y: rect.y + dy, width: rect.width - dx * 2, height: rect.height - dy * 2 };
}

function fits(rect: TreemapRect, size: BoxSize): boolean {
  return rect.width >= size.width && rect.height >= size.height;
}

function takeHeader(rect: TreemapRect, height: number): { band: TreemapRect; rest: TreemapRect } {
  return {
    band: { x: rect.x, y: rect.y, width: rect.width, height },
    rest: { x: rect.x, y: rect.y + height, width: rect.width, height: Math.max(0, rect.height - height) },
  };
}

function byWeight<T extends { weight: number }>(left: T, right: T): number {
  return right.weight - left.weight;
}

/** Where each block and tile sat in the last layout, so a refresh keeps the board in place. */
type SceneRanks = ReadonlyMap<string, number>;

/**
 * A block or tile overtakes the one before it only when it is this much
 * larger. Without it two sectors of nearly equal size swap places on a
 * refresh and every tile flies across the board.
 */
const ORDER_HYSTERESIS = 1.06;

function groupRankKey(group: string | null): string {
  return `g:${group ?? ""}`;
}

function subgroupRankKey(group: string | null, subgroup: string | null): string {
  return `s:${group ?? ""}\u0000${subgroup ?? ""}`;
}

function sceneRanks(scene: MetricTreemapScene<unknown> | null | undefined): SceneRanks | null {
  if (!scene || scene.tiles.length === 0) return null;
  const ranks = new Map<string, number>();
  scene.tiles.forEach((tile, index) => {
    const group = tile.item.group ?? null;
    const subgroup = tile.item.subgroup ?? null;
    if (!ranks.has(groupRankKey(group))) ranks.set(groupRankKey(group), index);
    if (!ranks.has(subgroupRankKey(group, subgroup))) ranks.set(subgroupRankKey(group, subgroup), index);
    ranks.set(`i:${tile.item.id}`, index);
  });
  return ranks;
}

/**
 * Largest first; with a previous layout, its order is kept unless a later
 * entry outweighs an earlier one by the hysteresis. New entries find their
 * place by weight.
 */
function stickySort<N extends { weight: number }>(nodes: N[], keyOf: (node: N) => string, ranks: SceneRanks | null): N[] {
  nodes.sort(byWeight);
  if (!ranks) return nodes;
  const rankOf = (node: N) => ranks.get(keyOf(node)) ?? Number.POSITIVE_INFINITY;
  nodes.sort((left, right) => rankOf(left) - rankOf(right) || right.weight - left.weight);
  for (let index = 1; index < nodes.length; index += 1) {
    let cursor = index;
    while (cursor > 0 && nodes[cursor]!.weight > nodes[cursor - 1]!.weight * ORDER_HYSTERESIS) {
      [nodes[cursor - 1], nodes[cursor]] = [nodes[cursor]!, nodes[cursor - 1]!];
      cursor -= 1;
    }
  }
  return nodes;
}

function buildTree<T>(items: readonly MetricTreemapItem<T>[], ranks: SceneRanks | null): GroupNode<T>[] {
  const groups = new Map<string | null, Map<string | null, SubgroupNode<T>>>();
  for (const item of items) {
    const weight = itemWeight(item);
    const groupKey = item.group ?? null;
    const subgroupKey = item.subgroup ?? null;
    let subgroups = groups.get(groupKey);
    if (!subgroups) {
      subgroups = new Map();
      groups.set(groupKey, subgroups);
    }
    let subgroup = subgroups.get(subgroupKey);
    if (!subgroup) {
      subgroup = { key: subgroupKey, weight: 0, items: [] };
      subgroups.set(subgroupKey, subgroup);
    }
    subgroup.items.push({ item, weight });
    subgroup.weight += weight;
  }
  const tree: GroupNode<T>[] = [];
  for (const [key, subgroupMap] of groups) {
    const subgroups = [...subgroupMap.values()];
    for (const subgroup of subgroups) stickySort(subgroup.items, (entry) => `i:${entry.item.id}`, ranks);
    stickySort(subgroups, (subgroup) => subgroupRankKey(key, subgroup.key), ranks);
    tree.push({ key, weight: subgroups.reduce((sum, subgroup) => sum + subgroup.weight, 0), subgroups });
  }
  return stickySort(tree, (group) => groupRankKey(group.key), ranks);
}

function layoutPass<T>(
  visible: readonly MetricTreemapItem<T>[],
  folded: readonly MetricTreemapItem<T>[],
  width: number,
  height: number,
  options: MetricTreemapSceneOptions,
  ranks: SceneRanks | null,
): MetricTreemapScene<T> {
  const fullTree = buildTree(visible, ranks);
  // Names without a group join the folded tail in one quiet Other block, laid
  // out last so it lands bottom right. A board where nothing has a group is
  // flat, not one big Other.
  const grouped = fullTree.some((group) => group.key != null);
  const unclassified = grouped ? fullTree.find((group) => group.key == null) ?? null : null;
  const tree = unclassified ? fullTree.filter((group) => group !== unclassified) : fullTree;
  const unclassifiedItems = unclassified
    ? stickySort(unclassified.subgroups.flatMap((subgroup) => subgroup.items), (entry) => `i:${entry.item.id}`, ranks)
    : [];
  const foldedWeight = folded.reduce((sum, item) => sum + itemWeight(item), 0);
  const otherWeight = foldedWeight + (unclassified?.weight ?? 0);
  const blockWeights = [...tree.map((group) => group.weight), ...(otherWeight > 0 ? [otherWeight] : [])];
  const blockRects = squarifyRects(blockWeights, { x: 0, y: 0, width, height }, options.aspect, options.snap);
  const tiles: FloatMetricTreemapTile<T>[] = [];
  const headers: MetricTreemapHeader[] = [];
  const placeItems = (entries: Array<{ item: MetricTreemapItem<T>; weight: number }>, rect: TreemapRect) => {
    const rects = squarifyRects(entries.map((entry) => entry.weight), rect, options.aspect, options.snap);
    entries.forEach((entry, index) => {
      const box = rects[index] ?? EMPTY_RECT;
      tiles.push({ item: entry.item, x: box.x, y: box.y, width: box.width, height: box.height });
    });
  };

  tree.forEach((group, groupIndex) => {
    let content = inset(blockRects[groupIndex] ?? EMPTY_RECT, options.groupInset);
    if (group.key != null && fits(content, options.headerMin[0])) {
      const { band, rest } = takeHeader(content, options.headerHeight[0]);
      headers.push({ id: `group:${group.key}`, level: 0, label: group.key, rect: band });
      content = rest;
    }
    if (group.subgroups.length === 1) {
      placeItems(group.subgroups[0]!.items, content);
      return;
    }
    const subgroupRects = squarifyRects(group.subgroups.map((subgroup) => subgroup.weight), content, options.aspect, options.snap);
    group.subgroups.forEach((subgroup, subgroupIndex) => {
      let subContent = inset(subgroupRects[subgroupIndex] ?? EMPTY_RECT, options.subgroupInset);
      // One industry in a sector says nothing its sector header does not, and
      // a one-name industry says nothing its tile does not.
      if (
        subgroup.key != null
        && subgroup.key !== group.key
        && subgroup.items.length > 1
        && fits(subContent, options.headerMin[1])
      ) {
        const { band, rest } = takeHeader(subContent, options.headerHeight[1]);
        headers.push({ id: `subgroup:${group.key ?? ""}:${subgroup.key}`, level: 1, label: subgroup.key, rect: band });
        subContent = rest;
      }
      placeItems(subgroup.items, subContent);
    });
  });

  let other: MetricTreemapOtherBlock<T> | null = null;
  if (otherWeight > 0) {
    let rect = inset(blockRects[blockRects.length - 1] ?? EMPTY_RECT, options.groupInset);
    const foldedItems = [...folded].sort((left, right) => itemWeight(right) - itemWeight(left));
    if (unclassifiedItems.length > 0) {
      const labelled = fits(rect, options.headerMin[0]);
      if (labelled) {
        const { band, rest } = takeHeader(rect, options.headerHeight[0]);
        headers.push({ id: "other", level: 0, label: "", other: true, rect: band });
        rect = rest;
      }
      const parts = squarifyRects(
        [...unclassifiedItems.map((entry) => entry.weight), ...(foldedWeight > 0 ? [foldedWeight] : [])],
        rect,
        options.aspect,
        options.snap,
      );
      unclassifiedItems.forEach((entry, index) => {
        const box = parts[index] ?? EMPTY_RECT;
        tiles.push({ item: entry.item, x: box.x, y: box.y, width: box.width, height: box.height });
      });
      if (foldedWeight > 0) {
        other = { rect: parts[parts.length - 1] ?? EMPTY_RECT, items: foldedItems, showLabel: !labelled && fits(rect, options.headerMin[0]) };
      }
    } else {
      other = { rect, items: foldedItems, showLabel: fits(rect, options.headerMin[0]) };
    }
  }
  return { width, height, tiles, headers, other };
}

function tooSmall(tile: { width: number; height: number }, minTile: BoxSize): boolean {
  return tile.width < minTile.width || tile.height < minTile.height;
}

/**
 * Lays out `items` with their optional `group` / `subgroup` keys. A name whose
 * tile would be smaller than `minTile` folds into Other, which is laid out
 * last so it lands in the bottom-right corner; the layout reruns until every
 * drawn tile fits. Given the scene on screen, blocks and tiles keep their
 * order through small size changes, so a relayout moves them a little
 * instead of reshuffling the board.
 */
export function buildMetricTreemapScene<T>(
  items: readonly MetricTreemapItem<T>[],
  width: number,
  height: number,
  options: MetricTreemapSceneOptions,
  previous?: MetricTreemapScene<T> | null,
): MetricTreemapScene<T> {
  const ranks = sceneRanks(previous);
  const weighted = items.filter((item) => itemWeight(item) > 0);
  if (width <= 0 || height <= 0 || weighted.length === 0) {
    return { width, height, tiles: [], headers: [], other: null };
  }
  const total = weighted.reduce((sum, item) => sum + itemWeight(item), 0);
  const canvasArea = width * height * EXPECTED_AREA_EFFICIENCY;
  const minArea = options.minTile.width * options.minTile.height;
  const folded = new Set<string>();
  for (const item of weighted) {
    if (itemWeight(item) / total * canvasArea < minArea) folded.add(item.id);
  }
  // Never fold everything: the largest name always gets a tile.
  if (folded.size === weighted.length) {
    const largest = weighted.reduce((best, item) => (itemWeight(item) > itemWeight(best) ? item : best));
    folded.delete(largest.id);
  }

  let scene: MetricTreemapScene<T> | null = null;
  for (let pass = 0; pass < MAX_LAYOUT_PASSES; pass += 1) {
    const visible = weighted.filter((item) => !folded.has(item.id));
    const hidden = weighted.filter((item) => folded.has(item.id));
    scene = layoutPass(visible, hidden, width, height, options, ranks);
    const small = scene.tiles.filter((tile) => tooSmall(tile, options.minTile));
    if (small.length === 0 || small.length === scene.tiles.length) return scene;
    for (const tile of small) folded.add(tile.item.id);
  }
  // Still crowded after the passes: drop what does not fit rather than draw slivers.
  const finalScene = scene!;
  const small = finalScene.tiles.filter((tile) => tooSmall(tile, options.minTile));
  if (small.length === 0 || small.length === finalScene.tiles.length) return finalScene;
  return {
    ...finalScene,
    tiles: finalScene.tiles.filter((tile) => !tooSmall(tile, options.minTile)),
    other: finalScene.other
      ? { ...finalScene.other, items: [...finalScene.other.items, ...small.map((tile) => tile.item)] }
      : null,
  };
}
