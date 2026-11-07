import { MIN_FLOAT_HEIGHT, MIN_FLOAT_WIDTH, type FloatingRect } from "../../../../layout/pane-manager";
import type { ResizeEdges } from "./index";

/**
 * Floating windows snapped edge to edge resize together: dragging the edge
 * one shares with its neighbours moves that line for all of them, so the
 * middle of two windows side by side resizes both, as a dock divider does.
 */

/** How close two edges are to count as one line, and how far two spans overlap to count as neighbours, in cells. */
const SAME_LINE = 0.05;
const NEIGHBOUR_OVERLAP = 0.5;

interface Member {
  id: string;
  rect: FloatingRect;
}

/** The windows on one line of one axis: `near` have the dragged edge's side on it, `far` the other. */
interface AxisGroup {
  axis: "x" | "y";
  /** The dragged edge: -1 the left or top one, 1 the right or bottom one. */
  edge: -1 | 1;
  line: number;
  near: Member[];
  far: Member[];
}

export interface SharedEdgeGroups {
  x: AxisGroup | null;
  y: AxisGroup | null;
  /** Every window that moves with the drag, the dragged one too. */
  ids: ReadonlySet<string>;
}

export const NO_SHARED_EDGES: SharedEdgeGroups = { x: null, y: null, ids: new Set() };

function startOf(rect: FloatingRect, axis: "x" | "y") {
  return axis === "x" ? rect.x : rect.y;
}

function lengthOf(rect: FloatingRect, axis: "x" | "y") {
  return axis === "x" ? rect.width : rect.height;
}

function edgeOf(rect: FloatingRect, axis: "x" | "y", edge: -1 | 1) {
  return edge === -1 ? startOf(rect, axis) : startOf(rect, axis) + lengthOf(rect, axis);
}

/** Whether two rects sit beside each other across `axis`: their spans on the other axis overlap. */
function neighbours(a: FloatingRect, b: FloatingRect, axis: "x" | "y") {
  const [aStart, aLength, bStart, bLength] = axis === "x"
    ? [a.y, a.height, b.y, b.height]
    : [a.x, a.width, b.x, b.width];
  return Math.min(aStart + aLength, bStart + bLength) - Math.max(aStart, bStart) > NEIGHBOUR_OVERLAP;
}

function groupOnAxis(windows: readonly Member[], dragged: Member, axis: "x" | "y", edge: -1 | 1): AxisGroup | null {
  const line = edgeOf(dragged.rect, axis, edge);
  const near: Member[] = [dragged];
  const far: Member[] = [];
  const placed = new Set([dragged.id]);
  // Grown out from the dragged window: a window across the line from one in
  // `near` is in `far`, and one on the near side of the line beside a window
  // in `far` is in `near`, so a row of windows along one line moves as one.
  for (let changed = true; changed;) {
    changed = false;
    for (const window of windows) {
      if (placed.has(window.id)) continue;
      const onFar = Math.abs(edgeOf(window.rect, axis, edge === 1 ? -1 : 1) - line) <= SAME_LINE;
      const onNear = Math.abs(edgeOf(window.rect, axis, edge) - line) <= SAME_LINE;
      if (onFar && near.some((member) => neighbours(member.rect, window.rect, axis))) {
        far.push(window);
      } else if (onNear && far.some((member) => neighbours(member.rect, window.rect, axis))) {
        near.push(window);
      } else {
        continue;
      }
      placed.add(window.id);
      changed = true;
    }
  }
  return far.length > 0 ? { axis, edge, line, near, far } : null;
}

/**
 * The windows a resize of `dragged` by `edges` moves with it: on each axis
 * it resizes, those whose edge lies on the line of the dragged edge and that
 * sit beside a window on the other side of it. None, when it is alone there.
 */
export function resolveSharedEdges(windows: readonly Member[], dragged: Member, edges: ResizeEdges): SharedEdgeGroups {
  const others = windows.filter((window) => window.id !== dragged.id);
  const x = edges.x === 0 ? null : groupOnAxis(others, dragged, "x", edges.x);
  const y = edges.y === 0 ? null : groupOnAxis(others, dragged, "y", edges.y);
  if (!x && !y) return NO_SHARED_EDGES;
  const ids = new Set<string>();
  for (const group of [x, y]) for (const member of [...(group?.near ?? []), ...(group?.far ?? [])]) ids.add(member.id);
  return { x, y, ids };
}

function minimumOf(axis: "x" | "y") {
  return axis === "x" ? MIN_FLOAT_WIDTH : MIN_FLOAT_HEIGHT;
}

/** One axis of `rect` with the edge `side` moved by `delta`. */
function moveEdge(rect: FloatingRect, axis: "x" | "y", side: -1 | 1, delta: number): FloatingRect {
  if (axis === "x") {
    return side === 1 ? { ...rect, width: rect.width + delta } : { ...rect, x: rect.x + delta, width: rect.width - delta };
  }
  return side === 1 ? { ...rect, height: rect.height + delta } : { ...rect, y: rect.y + delta, height: rect.height - delta };
}

/**
 * Where every window of the groups goes when the dragged one is resized to
 * `resized`: the shared line follows the dragged edge, held where any window
 * on it would go under its minimum size or past the area. `rects` has every
 * window that moves, the dragged one too (its rect on that axis set by the
 * line).
 */
export function applySharedEdges(
  groups: SharedEdgeGroups,
  draggedId: string,
  resized: FloatingRect,
  area: { width: number; height: number },
): Map<string, FloatingRect> {
  const rects = new Map<string, FloatingRect>();
  const rectOf = (member: Member) => rects.get(member.id) ?? member.rect;
  for (const group of [groups.x, groups.y]) {
    if (!group) continue;
    const { axis, edge, line } = group;
    const minimum = minimumOf(axis);
    let low = -line;
    let high = (axis === "x" ? area.width : area.height) - line;
    const hold = (side: -1 | 1, length: number) => {
      // The far edge grows with the line (delta >= minimum - length); the near one shrinks (delta <= length - minimum).
      if (side === 1) low = Math.max(low, minimum - length);
      else high = Math.min(high, length - minimum);
    };
    for (const member of group.near) hold(edge, lengthOf(member.rect, axis));
    for (const member of group.far) hold(edge === 1 ? -1 : 1, lengthOf(member.rect, axis));
    const wanted = edgeOf(resized, axis, edge) - line;
    const delta = low > high ? 0 : Math.max(low, Math.min(high, wanted));
    for (const member of group.near) rects.set(member.id, moveEdge(rectOf(member), axis, edge, delta));
    for (const member of group.far) rects.set(member.id, moveEdge(rectOf(member), axis, edge === 1 ? -1 : 1, delta));
  }
  // An axis the dragged window resizes alone takes the resize as it is.
  const dragged = rects.get(draggedId);
  if (dragged) {
    rects.set(draggedId, {
      ...dragged,
      ...(groups.x ? {} : { x: resized.x, width: resized.width }),
      ...(groups.y ? {} : { y: resized.y, height: resized.height }),
    });
  }
  return rects;
}
