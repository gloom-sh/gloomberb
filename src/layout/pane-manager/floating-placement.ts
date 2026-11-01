import type { LayoutConfig } from "../../types/config";
import { getDockLeafLayouts, type LayoutBounds } from "./dock-tree";
import { clampFloatingRect, MIN_FLOAT_HEIGHT, MIN_FLOAT_WIDTH, NARROW_FLOAT_AREA_WIDTH, type FloatingRect } from "./floating";

/** What a new floating pane keeps clear of beyond the other floating panes. */
export interface FloatingPlacementOptions {
  /** The pane being worked in: a new window never covers all of it. */
  focusedPaneId?: string | null;
}

/** How far each window of a cascade sits from the one before it, in cells: past its header and its left edge. */
const CASCADE_STEP = { x: 2, y: 1 };
/** A free spot has to hold at least this share of the window's size on each axis to be worth shrinking into. */
const MIN_FREE_SHARE = 0.5;
/** Past this many windows to keep clear of, the free spots are slivers: cascade instead of searching them. */
const MAX_FREE_SEARCH_OBSTACLES = 12;

function overlaps(a: LayoutBounds, b: LayoutBounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function contains(outer: LayoutBounds, inner: LayoutBounds): boolean {
  return outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}

/**
 * Every rectangle of `area` that touches none of `obstacles` and runs between
 * the lines their edges and the area's draw. Every largest empty rectangle
 * lies on those lines, so the largest are among them; fine for the few
 * windows a layout floats.
 */
function forEachFreeRect(area: LayoutBounds, obstacles: readonly LayoutBounds[], visit: (rect: LayoutBounds) => void): void {
  const clip = (value: number, start: number, length: number) => Math.max(start, Math.min(start + length, value));
  const xs = [...new Set([area.x, area.x + area.width, ...obstacles.flatMap((rect) => [rect.x, rect.x + rect.width].map((x) => clip(x, area.x, area.width)))])].sort((a, b) => a - b);
  const ys = [...new Set([area.y, area.y + area.height, ...obstacles.flatMap((rect) => [rect.y, rect.y + rect.height].map((y) => clip(y, area.y, area.height)))])].sort((a, b) => a - b);
  for (let left = 0; left < xs.length; left += 1) {
    for (let right = left + 1; right < xs.length; right += 1) {
      for (let top = 0; top < ys.length; top += 1) {
        for (let bottom = top + 1; bottom < ys.length; bottom += 1) {
          const rect = { x: xs[left]!, y: ys[top]!, width: xs[right]! - xs[left]!, height: ys[bottom]! - ys[top]! };
          // Taller ones from this corner only overlap more.
          if (obstacles.some((obstacle) => overlaps(rect, obstacle))) break;
          visit(rect);
        }
      }
    }
  }
}

/** Where a pane sits on screen: its floating rect, or its docked one laid out over `area`. */
function screenRect(layout: LayoutConfig, instanceId: string, area: LayoutBounds): LayoutBounds | null {
  const floating = layout.floating.find((entry) => entry.instanceId === instanceId);
  if (floating) return floating;
  return getDockLeafLayouts(layout, area).find((leaf) => leaf.instanceId === instanceId)?.rect ?? null;
}

/**
 * The rect a new floating window of `size` opens at in a `termWidth` by
 * `termHeight` area: in the largest spot clear of the other floating windows
 * and of the focused pane, shrunk to it when it is a little small, and centred
 * in it; otherwise one step down and right of the frontmost window, a cascade.
 * It never lands exactly on another window, and never covers all of the
 * focused pane when there is any other way. An area narrower than
 * NARROW_FLOAT_AREA_WIDTH is never searched for a narrower spot: the window
 * spans it and cascades down.
 */
export function placeFloatingRect(
  layout: LayoutConfig,
  instanceId: string,
  size: { width: number; height: number },
  termWidth: number,
  termHeight: number,
  options: FloatingPlacementOptions = {},
): FloatingRect {
  const area = { x: 0, y: 0, width: Math.max(1, termWidth), height: Math.max(1, termHeight) };
  const others = layout.floating.filter((entry) => entry.instanceId !== instanceId);
  const focusedId = options.focusedPaneId && options.focusedPaneId !== instanceId ? options.focusedPaneId : null;
  const focused = focusedId ? screenRect(layout, focusedId, area) : null;
  const obstacles: LayoutBounds[] = [...others];
  if (focused && !others.some((entry) => entry.instanceId === focusedId)) obstacles.push(focused);
  const narrow = area.width < NARROW_FLOAT_AREA_WIDTH;
  const width = narrow ? area.width : Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);

  if (!narrow && obstacles.length <= MAX_FREE_SEARCH_OBSTACLES) {
    const spot = bestFreeSpot(area, obstacles, width, height);
    if (spot) return clampFloatingRect(spot, termWidth, termHeight);
  }
  return cascadeRect(area, others, focused, width, height, termWidth, termHeight);
}

/** The free rect that holds the most of a `width` by `height` window, with the window centred in it; null when none holds enough. */
function bestFreeSpot(area: LayoutBounds, obstacles: readonly LayoutBounds[], width: number, height: number): FloatingRect | null {
  const minWidth = Math.max(Math.min(MIN_FLOAT_WIDTH, width), Math.ceil(width * MIN_FREE_SHARE));
  const minHeight = Math.max(Math.min(MIN_FLOAT_HEIGHT, height), Math.ceil(height * MIN_FREE_SHARE));
  const found: { best: { rect: LayoutBounds; fit: number } | null } = { best: null };
  forEachFreeRect(area, obstacles, (rect) => {
    const fitWidth = Math.min(width, rect.width);
    const fitHeight = Math.min(height, rect.height);
    if (fitWidth < minWidth || fitHeight < minHeight) return;
    const fit = fitWidth * fitHeight;
    const best = found.best;
    const room = rect.width * rect.height;
    const bestRoom = best ? best.rect.width * best.rect.height : 0;
    // Ties go to the roomier spot, then to the right and to the top, where a new window reads as new.
    if (!best || fit > best.fit
      || (fit === best.fit && (room > bestRoom
        || (room === bestRoom && (rect.x > best.rect.x || (rect.x === best.rect.x && rect.y < best.rect.y)))))) {
      found.best = { rect, fit };
    }
  });
  const best = found.best;
  if (!best) return null;
  const fitWidth = Math.min(width, best.rect.width);
  const fitHeight = Math.min(height, best.rect.height);
  return {
    x: Math.floor(best.rect.x + (best.rect.width - fitWidth) / 2),
    y: Math.floor(best.rect.y + (best.rect.height - fitHeight) / 2),
    width: Math.floor(fitWidth),
    height: Math.floor(fitHeight),
  };
}

/**
 * One step down and right of the frontmost window (or centred, with no
 * window to follow), wrapping to the top left when it runs off the area, and
 * stepping on while it would sit exactly on another window or cover all of
 * the focused pane.
 */
function cascadeRect(
  area: LayoutBounds,
  others: readonly { x: number; y: number; width: number; height: number; zIndex?: number }[],
  focused: LayoutBounds | null,
  width: number,
  height: number,
  termWidth: number,
  termHeight: number,
): FloatingRect {
  const front = others.reduce<(typeof others)[number] | null>(
    (top, entry) => (!top || (entry.zIndex ?? 0) >= (top.zIndex ?? 0) ? entry : top),
    null,
  );
  const maxX = Math.max(0, area.width - width);
  const maxY = Math.max(0, area.height - height);
  let x = front ? front.x + CASCADE_STEP.x : Math.floor(maxX / 2);
  let y = front ? front.y + CASCADE_STEP.y : Math.floor(maxY / 2);
  const taken = (left: number, top: number) => others.some((entry) => Math.round(entry.x) === left && Math.round(entry.y) === top);
  const coversFocus = (left: number, top: number) => !!focused && contains({ x: left, y: top, width, height }, focused);
  const attempts = Math.max(1, Math.ceil(Math.max(maxX / CASCADE_STEP.x, maxY / CASCADE_STEP.y)) + others.length + 1);
  let fallback: { x: number; y: number } | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (x > maxX || y > maxY) {
      // Off the edge: start a new run from the top left, a step in.
      x = Math.min(maxX, CASCADE_STEP.x * (attempt % 4));
      y = 0;
    }
    x = Math.round(x);
    y = Math.round(y);
    if (!taken(x, y)) {
      if (!coversFocus(x, y)) return clampFloatingRect({ x, y, width, height }, termWidth, termHeight);
      fallback ??= { x, y };
    }
    x += CASCADE_STEP.x;
    y += CASCADE_STEP.y;
  }
  const at = fallback ?? { x: Math.min(maxX, x), y: Math.min(maxY, y) };
  return clampFloatingRect({ ...at, width, height }, termWidth, termHeight);
}

/**
 * A remembered or chosen rect moved off any window it would sit exactly on:
 * stepped down and right until it lands on no other window's corner.
 */
export function avoidStackedRect(layout: LayoutConfig, instanceId: string, rect: FloatingRect, termWidth: number, termHeight: number): FloatingRect {
  const others = layout.floating.filter((entry) => entry.instanceId !== instanceId);
  let next = rect;
  for (let attempt = 0; attempt < others.length + 1; attempt += 1) {
    const stacked = others.some((entry) => Math.round(entry.x) === Math.round(next.x) && Math.round(entry.y) === Math.round(next.y));
    if (!stacked) return next;
    const moved = clampFloatingRect({ ...next, x: next.x + CASCADE_STEP.x, y: next.y + CASCADE_STEP.y }, termWidth, termHeight);
    if (moved.x === next.x && moved.y === next.y) {
      // Against the far corner: start again from the top left.
      next = clampFloatingRect({ ...next, x: 0, y: 0 }, termWidth, termHeight);
    } else {
      next = moved;
    }
  }
  return next;
}
