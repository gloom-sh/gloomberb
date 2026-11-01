import type { FloatingRect, LayoutBounds } from "../../../../layout/pane-manager";

/**
 * Magnets: while a floating pane moves or resizes, an edge that comes within
 * `catch` of another pane's edge (floating or docked), or of the edge of the
 * area, jumps to it, and stays there until it is pulled more than `release`
 * away. Distances are in cells per axis (the desktop's 8px and 12px, one and
 * two cells in the terminal).
 */
export interface MagnetDistances {
  catchX: number;
  catchY: number;
  releaseX: number;
  releaseY: number;
}

type Side = "start" | "end";

/** The line one edge of the rect holds to on an axis: which edge, at what coordinate. */
interface AxisLatch {
  side: Side;
  line: number;
}

/** What a move or resize is holding to, kept from one pointer move to the next. */
export interface MagnetLatch {
  x: AxisLatch | null;
  y: AxisLatch | null;
}

export const NO_LATCH: MagnetLatch = { x: null, y: null };

/** Desktop magnets, in px: an edge this close jumps to a line, and lets go this far from it. */
const MAGNET_CATCH_PX = 8;
const MAGNET_RELEASE_PX = 12;
/** Terminal magnets, in cells: the next cell catches, two let go. */
const TERMINAL_MAGNETS: MagnetDistances = { catchX: 1, catchY: 1, releaseX: 2, releaseY: 2 };

/**
 * The magnets in cells: the desktop's px over its cell size (`cell`), or the
 * terminal's whole cells, also for a cell size not measured yet (zero), which
 * would otherwise catch at any distance.
 */
export function magnetDistancesFor(cell: { width: number; height: number } | null): MagnetDistances {
  if (!cell || !(cell.width > 0) || !(cell.height > 0) || !Number.isFinite(cell.width) || !Number.isFinite(cell.height)) {
    return TERMINAL_MAGNETS;
  }
  return {
    catchX: MAGNET_CATCH_PX / cell.width,
    catchY: MAGNET_CATCH_PX / cell.height,
    releaseX: MAGNET_RELEASE_PX / cell.width,
    releaseY: MAGNET_RELEASE_PX / cell.height,
  };
}

interface Span { start: number; end: number }

/** How close two spans across the axis must be for their edges to matter to each other. */
function near(a: Span, b: Span, slack: number): boolean {
  return a.start < b.end + slack && b.start < a.end + slack;
}

/**
 * The lines an edge can hold to on one axis: the area's two edges, and the
 * near and far edge of every target that sits beside the rect across the
 * axis (overlapping it there, or within the catch distance), so a pane lines
 * up with its neighbours, not with something across the screen.
 */
function axisLines(axis: "x" | "y", rect: LayoutBounds, targets: readonly LayoutBounds[], area: LayoutBounds, slack: number): number[] {
  const across: Span = axis === "x"
    ? { start: rect.y, end: rect.y + rect.height }
    : { start: rect.x, end: rect.x + rect.width };
  const lines = axis === "x" ? [area.x, area.x + area.width] : [area.y, area.y + area.height];
  for (const target of targets) {
    const span: Span = axis === "x"
      ? { start: target.y, end: target.y + target.height }
      : { start: target.x, end: target.x + target.width };
    if (!near(across, span, slack)) continue;
    if (axis === "x") lines.push(target.x, target.x + target.width);
    else lines.push(target.y, target.y + target.height);
  }
  return lines;
}

/**
 * Where one axis of the rect snaps: the latch it keeps or takes, or null.
 * `sides` are the edges allowed to move: both for a move, the dragged one for
 * a resize. A latch holds while its edge stays within `release` of a line
 * still there; otherwise the closest edge-to-line pair within `catch` wins.
 */
function resolveAxis(
  edges: Record<Side, number>,
  sides: readonly Side[],
  lines: readonly number[],
  latch: AxisLatch | null,
  catchDistance: number,
  releaseDistance: number,
): AxisLatch | null {
  if (latch && sides.includes(latch.side) && lines.some((line) => Math.abs(line - latch.line) < 1e-6)) {
    if (Math.abs(edges[latch.side] - latch.line) <= releaseDistance) return latch;
  }
  let best: AxisLatch | null = null;
  let bestDistance = catchDistance;
  for (const side of sides) {
    for (const line of lines) {
      const distance = Math.abs(edges[side] - line);
      if (distance <= bestDistance && (best === null || distance < bestDistance)) {
        best = { side, line };
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** A floating rect being moved, with its edges pulled onto the lines nearby. */
export function snapMovedRect(
  rect: FloatingRect,
  targets: readonly LayoutBounds[],
  area: LayoutBounds,
  distances: MagnetDistances,
  latch: MagnetLatch,
): { rect: FloatingRect; latch: MagnetLatch } {
  const xLatch = resolveAxis(
    { start: rect.x, end: rect.x + rect.width },
    ["start", "end"],
    axisLines("x", rect, targets, area, distances.catchY),
    latch.x,
    distances.catchX,
    distances.releaseX,
  );
  const yLatch = resolveAxis(
    { start: rect.y, end: rect.y + rect.height },
    ["start", "end"],
    axisLines("y", rect, targets, area, distances.catchX),
    latch.y,
    distances.catchY,
    distances.releaseY,
  );
  const x = xLatch ? (xLatch.side === "start" ? xLatch.line : xLatch.line - rect.width) : rect.x;
  const y = yLatch ? (yLatch.side === "start" ? yLatch.line : yLatch.line - rect.height) : rect.y;
  return {
    rect: { ...rect, x: clampStart(x, rect.width, area.x, area.width), y: clampStart(y, rect.height, area.y, area.height) },
    latch: { x: xLatch, y: yLatch },
  };
}

function clampStart(start: number, length: number, areaStart: number, areaLength: number): number {
  return Math.max(areaStart, Math.min(start, areaStart + Math.max(0, areaLength - length)));
}

/**
 * A floating rect being resized by the edges in `edges` (-1 the left or top
 * one, 1 the right or bottom one, 0 neither), with each of those pulled onto
 * the lines nearby. The other edges stay put, and neither axis goes under
 * its minimum.
 */
export function snapResizedRect(
  rect: FloatingRect,
  edges: { x: -1 | 0 | 1; y: -1 | 0 | 1 },
  minimum: { width: number; height: number },
  targets: readonly LayoutBounds[],
  area: LayoutBounds,
  distances: MagnetDistances,
  latch: MagnetLatch,
): { rect: FloatingRect; latch: MagnetLatch } {
  const sideOf = (edge: -1 | 0 | 1): Side[] => (edge === -1 ? ["start"] : edge === 1 ? ["end"] : []);
  const xLatch = resolveAxis(
    { start: rect.x, end: rect.x + rect.width },
    sideOf(edges.x),
    axisLines("x", rect, targets, area, distances.catchY),
    latch.x,
    distances.catchX,
    distances.releaseX,
  );
  const yLatch = resolveAxis(
    { start: rect.y, end: rect.y + rect.height },
    sideOf(edges.y),
    axisLines("y", rect, targets, area, distances.catchX),
    latch.y,
    distances.catchY,
    distances.releaseY,
  );
  const xs = resizeTo(rect.x, rect.width, xLatch, minimum.width);
  const ys = resizeTo(rect.y, rect.height, yLatch, minimum.height);
  return {
    rect: { ...rect, x: xs.start, y: ys.start, width: xs.length, height: ys.length },
    latch: { x: xs.latch, y: ys.latch },
  };
}

/** One axis resized so the latched edge sits on its line; no latch when that would go under the minimum. */
function resizeTo(start: number, length: number, latch: AxisLatch | null, minimum: number): { start: number; length: number; latch: AxisLatch | null } {
  const end = start + length;
  if (latch?.side === "end" && latch.line - start >= minimum) return { start, length: latch.line - start, latch };
  if (latch?.side === "start" && end - latch.line >= minimum) return { start: latch.line, length: end - latch.line, latch };
  return { start, length, latch: null };
}
