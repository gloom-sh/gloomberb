import type { LayoutBounds } from "../../../../layout/pane-manager";
import { pointInRect } from "./index";

/**
 * Where a pane on the move can land, as targets in sight, the same on the
 * desktop, the web and in the terminal. Over any pane, in the layout or
 * floating, a small target shows on that pane: its centre stacks the moving
 * pane there as a tab, its four sides split that pane on that side. Thin
 * strips along the window's outer edges put it along that whole edge of the
 * layout. Anywhere else it floats where it is let go. Nothing waits on time:
 * the target under the pointer is what a release does.
 */

export type DropZoneSide = "center" | "left" | "right" | "top" | "bottom";
export type DropStripEdge = "left" | "right" | "top" | "bottom";

/** A pane a moving pane is over: the one its target is drawn on. */
export interface DropZoneHost {
  /** The pane the target acts on: a stack's shown tab, or another tab of the moving pane's own stack. */
  id: string;
  rect: LayoutBounds;
  /** In the layout (a split or tab there); otherwise a floating window. */
  docked: boolean;
}

/** What the pointer is over, and so what a release does. */
export interface DropZoneState {
  host: DropZoneHost | null;
  /** The square of the host's target under the pointer, if any. */
  side: DropZoneSide | null;
  /** The strip along the window's edge under the pointer, if any. */
  edge: DropStripEdge | null;
}

/** The size of the targets, in shell cells. */
export interface DropZoneMetrics {
  /** One square of a pane's target. */
  square: { width: number; height: number };
  /** Between two squares. */
  gap: { x: number; y: number };
  /** How far a strip reaches in from the window's edge. */
  strip: { x: number; y: number };
  /** The terminal: squares sit on whole cells. */
  wholeCells: boolean;
}

/** Desktop and web, in px: a square of the target, the gap between two, a strip's depth. */
const SQUARE_PX = 36;
const GAP_PX = 6;
const STRIP_PX = 12;

/** The desktop's targets for cells of `cell` px. */
export function desktopDropZoneMetrics(cell: { width: number; height: number }): DropZoneMetrics {
  return {
    square: { width: SQUARE_PX / cell.width, height: SQUARE_PX / cell.height },
    gap: { x: GAP_PX / cell.width, y: GAP_PX / cell.height },
    strip: { x: STRIP_PX / cell.width, y: STRIP_PX / cell.height },
    wholeCells: false,
  };
}

/**
 * The terminal's: a square is three cells by one row (a cell is about half
 * as wide as it is tall), a cell apart across and touching up and down; a
 * strip is the outermost cell.
 */
export const TERMINAL_DROP_ZONE_METRICS: DropZoneMetrics = {
  square: { width: 3, height: 1 },
  gap: { x: 1, y: 0 },
  strip: { x: 1, y: 1 },
  wholeCells: true,
};

const SIDES: readonly DropZoneSide[] = ["center", "left", "right", "top", "bottom"];

/** Each square of the target drawn on a pane at `rect`, around its middle. */
export function dropZoneSquares(rect: LayoutBounds, metrics: DropZoneMetrics): Record<DropZoneSide, LayoutBounds> {
  const { width, height } = metrics.square;
  const stepX = width + metrics.gap.x;
  const stepY = height + metrics.gap.y;
  const place = (value: number) => (metrics.wholeCells ? Math.floor(value) : value);
  const cx = place(rect.x + (rect.width - width) / 2);
  const cy = place(rect.y + (rect.height - height) / 2);
  const at = (dx: number, dy: number) => ({ x: cx + dx * stepX, y: cy + dy * stepY, width, height });
  return {
    center: at(0, 0),
    left: at(-1, 0),
    right: at(1, 0),
    top: at(0, -1),
    bottom: at(0, 1),
  };
}

/** The strip along each edge of `area`. */
export function dropStrips(area: LayoutBounds, metrics: DropZoneMetrics): Record<DropStripEdge, LayoutBounds> {
  const { x: across, y: down } = metrics.strip;
  return {
    left: { x: area.x, y: area.y, width: across, height: area.height },
    right: { x: area.x + area.width - across, y: area.y, width: across, height: area.height },
    top: { x: area.x, y: area.y, width: area.width, height: down },
    bottom: { x: area.x, y: area.y + area.height - down, width: area.width, height: down },
  };
}

const NO_DROP_ZONE: DropZoneState = { host: null, side: null, edge: null };

/**
 * What the pointer at (`x`, `y`), in shell cells, is over. A strip first: the
 * pointer past the window's edge (over the header or the status bar) is in
 * its strip, and in a corner the nearer edge wins. Then the first of `hosts`
 * (front to back) under the pointer, and the square of its target there.
 */
export function resolveDropZone({
  x,
  y,
  hosts,
  area,
  metrics,
}: {
  x: number;
  y: number;
  hosts: readonly DropZoneHost[];
  area: LayoutBounds;
  metrics: DropZoneMetrics;
}): DropZoneState {
  // How far into each strip the pointer is, in strip depths: under 1 is in it.
  const { strip } = metrics;
  const depths: Array<[DropStripEdge, number]> = [
    ["left", (x - area.x) / strip.x],
    ["right", (area.x + area.width - x) / strip.x],
    ["top", (y - area.y) / strip.y],
    ["bottom", (area.y + area.height - y) / strip.y],
  ];
  let edge: DropStripEdge | null = null;
  let nearest = 1;
  for (const [candidate, depth] of depths) {
    // The terminal's pointer is a cell: its far side is a cell on.
    const reach = metrics.wholeCells && (candidate === "right" || candidate === "bottom") ? depth - 1 : depth;
    if (reach < nearest) {
      edge = candidate;
      nearest = reach;
    }
  }
  if (edge) return { host: null, side: null, edge };
  const host = hosts.find((candidate) => pointInRect(candidate.rect, x, y)) ?? null;
  if (!host) return NO_DROP_ZONE;
  const squares = dropZoneSquares(host.rect, metrics);
  const side = SIDES.find((candidate) => pointInRect(squares[candidate], x, y)) ?? null;
  return { host, side, edge: null };
}

function sameBounds(a: LayoutBounds, b: LayoutBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function sameDropZone(a: DropZoneState | null, b: DropZoneState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.side !== b.side || a.edge !== b.edge) return false;
  if (!a.host || !b.host) return a.host === b.host;
  return a.host.id === b.host.id && a.host.docked === b.host.docked && sameBounds(a.host.rect, b.host.rect);
}
