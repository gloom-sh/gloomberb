import type { DockLayoutNode, LayoutConfig } from "../../types/config";
import { getDockLeafLayouts, type LayoutBounds } from "./dock-tree";

export interface GridlockRect {
  instanceId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function rectsOverlap(left: LayoutBounds, right: LayoutBounds): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

export function boundsForRects(rects: GridlockRect[]): LayoutBounds {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function buildGridDockTree(instanceIds: string[], depth = 0): DockLayoutNode | null {
  if (instanceIds.length === 0) return null;
  if (instanceIds.length === 1) return { kind: "pane", instanceId: instanceIds[0]! };
  const splitIndex = Math.ceil(instanceIds.length / 2);
  return {
    kind: "split",
    axis: depth % 2 === 0 ? "horizontal" : "vertical",
    ratio: splitIndex / instanceIds.length,
    first: buildGridDockTree(instanceIds.slice(0, splitIndex), depth + 1)!,
    second: buildGridDockTree(instanceIds.slice(splitIndex), depth + 1)!,
  };
}

function clampGridlockRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0.1, Math.min(0.9, value));
}

function inferSplitCandidate(
  rects: GridlockRect[],
  axis: "horizontal" | "vertical",
  bounds: LayoutBounds,
): { axis: "horizontal" | "vertical"; ratio: number; first: GridlockRect[]; second: GridlockRect[] } | null {
  const tolerance = 1;
  const candidates = new Set<number>();

  for (const rect of rects) {
    if (axis === "horizontal") {
      candidates.add(rect.y);
      candidates.add(rect.y + rect.height);
    } else {
      candidates.add(rect.x);
      candidates.add(rect.x + rect.width);
    }
  }

  const minBound = axis === "horizontal" ? bounds.y : bounds.x;
  const maxBound = axis === "horizontal" ? bounds.y + bounds.height : bounds.x + bounds.width;

  let best: { ratio: number; first: GridlockRect[]; second: GridlockRect[]; score: number } | null = null;
  for (const candidate of candidates) {
    if (candidate <= minBound + tolerance || candidate >= maxBound - tolerance) continue;

    const first: GridlockRect[] = [];
    const second: GridlockRect[] = [];
    let valid = true;

    for (const rect of rects) {
      const start = axis === "horizontal" ? rect.y : rect.x;
      const end = axis === "horizontal" ? rect.y + rect.height : rect.x + rect.width;

      if (end <= candidate + tolerance) {
        first.push(rect);
      } else if (start >= candidate - tolerance) {
        second.push(rect);
      } else {
        valid = false;
        break;
      }
    }

    if (!valid || first.length === 0 || second.length === 0) continue;

    const ratio = axis === "horizontal"
      ? clampGridlockRatio((candidate - bounds.y) / Math.max(1, bounds.height))
      : clampGridlockRatio((candidate - bounds.x) / Math.max(1, bounds.width));
    const balance = Math.abs(first.length - second.length);
    const centerBias = Math.abs(ratio - 0.5);
    const score = balance * 10 + centerBias;

    if (!best || score < best.score) {
      best = { ratio, first, second, score };
    }
  }

  return best ? { axis, ratio: best.ratio, first: best.first, second: best.second } : null;
}

export function inferDockTreeFromRects(rects: GridlockRect[], bounds?: LayoutBounds): DockLayoutNode | null {
  if (rects.length === 0) return null;
  if (rects.length === 1) return { kind: "pane", instanceId: rects[0]!.instanceId };

  const rectBounds = bounds ?? boundsForRects(rects);
  const preferredAxis = rectBounds.width >= rectBounds.height ? "vertical" : "horizontal";
  const primary = inferSplitCandidate(rects, preferredAxis, rectBounds);
  const secondary = inferSplitCandidate(rects, preferredAxis === "vertical" ? "horizontal" : "vertical", rectBounds);
  const chosen = primary ?? secondary;

  if (!chosen) {
    return buildGridDockTree(
      [...rects].sort((a, b) => a.y - b.y || a.x - b.x).map((rect) => rect.instanceId),
    );
  }

  return {
    kind: "split",
    axis: chosen.axis === "vertical" ? "horizontal" : "vertical",
    ratio: chosen.ratio,
    first: inferDockTreeFromRects(chosen.first, boundsForRects(chosen.first))!,
    second: inferDockTreeFromRects(chosen.second, boundsForRects(chosen.second))!,
  };
}

export function inferCompactedDockTree(
  layout: LayoutConfig,
  draggedInstanceId: string,
  targetRect: LayoutBounds,
  bounds: LayoutBounds,
): DockLayoutNode | null {
  const siblingLeaves = getDockLeafLayouts(layout, bounds)
    .filter((leaf) => leaf.instanceId !== draggedInstanceId);
  if (siblingLeaves.some((leaf) => rectsOverlap(targetRect, leaf.rect))) {
    return null;
  }

  let replacedDraggedPane = false;
  const rects: GridlockRect[] = getDockLeafLayouts(layout, bounds).map((leaf) => {
    if (leaf.instanceId !== draggedInstanceId) {
      return { instanceId: leaf.instanceId, ...leaf.rect };
    }
    replacedDraggedPane = true;
    return { instanceId: draggedInstanceId, ...targetRect };
  });

  if (!replacedDraggedPane) {
    rects.push({ instanceId: draggedInstanceId, ...targetRect });
  }

  return inferDockTreeFromRects(rects, bounds);
}
