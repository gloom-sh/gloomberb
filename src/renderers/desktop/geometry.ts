/**
 * Screens and window frames for the desktop app, in the coordinates the
 * shell reports them in: one virtual desktop where every display has its
 * place. Nothing here talks to a shell; the window host does (window-host.ts).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopDisplay {
  /** The shell's id. It can change when a display is plugged in again, so placements never key on it. */
  id: string;
  bounds: Rect;
  /** The bounds less the menu bar, Dock or task bar. */
  workArea: Rect;
  scaleFactor: number;
  primary: boolean;
}

/** How much of a title bar has to sit on a screen for a window to count as reachable: enough to grab and drag. */
const REACHABLE_STRIP_HEIGHT = 24;
const REACHABLE_STRIP_WIDTH = 96;
/**
 * How far past a screen's edge a frame may reach and still count as on it:
 * shadows and the invisible resize borders Windows counts in a frame.
 */
const EDGE_SLACK = 8;

function finite(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

export function sameRect(a: Rect | null | undefined, b: Rect | null | undefined): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function isUsableRect(rect: Rect | null | undefined): rect is Rect {
  return !!rect
    && [rect.x, rect.y, rect.width, rect.height].every((value) => typeof value === "number" && Number.isFinite(value))
    && rect.width >= 1
    && rect.height >= 1;
}

/** Displays the shell reported with a real size, primary first and then left to right, top to bottom. */
export function usableDisplays(displays: readonly DesktopDisplay[]): DesktopDisplay[] {
  return displays
    .filter((display) => isUsableRect(display.bounds) && isUsableRect(display.workArea))
    .sort((a, b) => (
      Number(b.primary) - Number(a.primary)
      || a.bounds.x - b.bounds.x
      || a.bounds.y - b.bounds.y
    ));
}

/**
 * One display, as placements remember it: where it sits, its size and its
 * scale. A display unplugged and plugged back in the same place gets the
 * same key, whatever id the shell gives it.
 */
export function displayKey(display: DesktopDisplay): string {
  const { x, y, width, height } = display.bounds;
  const scale = Math.round((display.scaleFactor || 1) * 100) / 100;
  return `${finite(x)},${finite(y)} ${finite(width)}x${finite(height)}@${scale}`;
}

/**
 * The monitor arrangement a screen setup is saved under: every display's
 * key, in a fixed order. Moving, adding or removing a display, or changing
 * its resolution or scale, makes another arrangement.
 */
export function arrangementKey(displays: readonly DesktopDisplay[]): string {
  const keys = usableDisplays(displays).map(displayKey).sort();
  return keys.length > 0 ? keys.join(" | ") : "none";
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The display a frame is on: the one holding its centre, else the one it overlaps most. Null when it is on none. */
export function displayForFrame(frame: Rect, displays: readonly DesktopDisplay[]): DesktopDisplay | null {
  const usable = usableDisplays(displays);
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  const containing = usable.find(({ bounds }) => (
    centerX >= bounds.x && centerX < bounds.x + bounds.width
    && centerY >= bounds.y && centerY < bounds.y + bounds.height
  ));
  if (containing) return containing;
  let best: DesktopDisplay | null = null;
  let bestArea = 0;
  for (const display of usable) {
    const area = overlapArea(frame, display.bounds);
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Whether a person can reach the window to move it: a stretch of its title
 * bar lies in some display's work area, not under the menu bar or off the
 * edge of every screen.
 */
export function isFrameReachable(frame: Rect, displays: readonly DesktopDisplay[]): boolean {
  const titleBar: Rect = { x: frame.x, y: frame.y, width: frame.width, height: REACHABLE_STRIP_HEIGHT };
  return usableDisplays(displays).some(({ workArea }) => {
    const width = Math.min(titleBar.x + titleBar.width, workArea.x + workArea.width) - Math.max(titleBar.x, workArea.x);
    const height = Math.min(titleBar.y + titleBar.height, workArea.y + workArea.height) - Math.max(titleBar.y, workArea.y);
    return width >= Math.min(REACHABLE_STRIP_WIDTH, frame.width) && height >= Math.min(REACHABLE_STRIP_HEIGHT, frame.height);
  });
}

/**
 * Whether a window is on screen: all of it lies on the connected displays
 * (across two of them counts), give or take its shadow, and its title bar
 * sits in a work area where it can be grabbed.
 */
export function isFrameVisible(frame: Rect, displays: readonly DesktopDisplay[]): boolean {
  const usable = usableDisplays(displays);
  const insetX = Math.min(EDGE_SLACK, Math.floor(frame.width / 4));
  const insetY = Math.min(EDGE_SLACK, Math.floor(frame.height / 4));
  const inner: Rect = {
    x: frame.x + insetX,
    y: frame.y + insetY,
    width: frame.width - insetX * 2,
    height: frame.height - insetY * 2,
  };
  // Mirrored displays share their bounds: count each place once.
  const places = new Set<string>();
  let covered = 0;
  for (const { bounds } of usable) {
    const place = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`;
    if (places.has(place)) continue;
    places.add(place);
    covered += overlapArea(inner, bounds);
  }
  return covered >= inner.width * inner.height - 1 && isFrameReachable(frame, usable);
}

/** The display closest to a frame on none: the shortest way from its centre to a work area. */
function nearestDisplay(frame: Rect, displays: readonly DesktopDisplay[]): DesktopDisplay | null {
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  let best: DesktopDisplay | null = null;
  let bestDistance = Infinity;
  for (const display of displays) {
    const area = display.workArea;
    const dx = Math.max(area.x - centerX, 0, centerX - (area.x + area.width));
    const dy = Math.max(area.y - centerY, 0, centerY - (area.y + area.height));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      best = display;
      bestDistance = distance;
    }
  }
  return best;
}

/** A frame inside a work area, moved as little as it takes and shrunk to it when bigger. */
function fitFrameInArea(frame: Rect, area: Rect): Rect {
  const width = Math.min(Math.round(frame.width), area.width);
  const height = Math.min(Math.round(frame.height), area.height);
  return {
    x: clamp(Math.round(frame.x), area.x, area.x + area.width - width),
    y: clamp(Math.round(frame.y), area.y, area.y + area.height - height),
    width,
    height,
  };
}

/**
 * Puts a window on a screen. One already on screen stays as it is. Any
 * other moves onto the display it is mostly on, or the nearest one, by as
 * little as it takes to lie in that display's work area, shrinking to it
 * when it is bigger. Shells do not do this themselves: asked to open a
 * window past a screen's edge, Electrobun leaves it there.
 */
export function clampFrameToScreens(frame: Rect, displays: readonly DesktopDisplay[]): Rect {
  const usable = usableDisplays(displays);
  if (usable.length === 0 || isFrameVisible(frame, usable)) return frame;
  const display = displayForFrame(frame, usable) ?? nearestDisplay(frame, usable) ?? usable[0]!;
  return fitFrameInArea(frame, display.workArea);
}

/** A display as `displayKey` wrote it, for a placement saved under screens that are not all connected now. */
export function displayFromKey(key: string): DesktopDisplay | null {
  const match = /^(-?\d+),(-?\d+) (\d+)x(\d+)@([\d.]+)$/.exec(key);
  if (!match) return null;
  const bounds = { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
  if (!isUsableRect(bounds)) return null;
  return { id: "", bounds, workArea: bounds, scaleFactor: Number(match[5]) || 1, primary: false };
}

/**
 * The connected display a display that is gone became: the one at the same
 * place (a new resolution keeps a screen's corner), else the one with its id.
 */
function sameScreen(display: DesktopDisplay, displays: readonly DesktopDisplay[]): DesktopDisplay | null {
  const { x, y } = display.bounds;
  return displays.find(({ bounds }) => bounds.x === x && bounds.y === y)
    ?? (display.id ? displays.find(({ id }) => id === display.id) : undefined)
    ?? null;
}

/**
 * Where a window that sat on `from` goes on the displays connected now,
 * always on screen. Its display still there: where it was. The same screen
 * at another resolution or place: the same place on it, in proportion.
 * Its display gone: the same place in proportion on `fallback`. On no
 * display at all: onto the nearest one.
 */
export function relocateFrame(
  frame: Rect,
  from: DesktopDisplay | null,
  displays: readonly DesktopDisplay[],
  fallback: DesktopDisplay,
): Rect {
  const usable = usableDisplays(displays);
  if (!from || usable.some((display) => displayKey(display) === displayKey(from))) {
    return clampFrameToScreens(frame, usable);
  }
  const target = sameScreen(from, usable) ?? fallback;
  return clampFrameToScreens(moveFrameToDisplay(frame, from, target), usable);
}

/**
 * A window moving from one display to another keeps its place on the screen
 * in proportion: a window on the right half of the old display lands on the
 * right half of the new one, at the same size where it fits.
 */
export function moveFrameToDisplay(frame: Rect, from: DesktopDisplay | null, to: DesktopDisplay): Rect {
  const area = to.workArea;
  const width = Math.min(frame.width, area.width);
  const height = Math.min(frame.height, area.height);
  if (!from) {
    return {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height,
    };
  }
  const source = from.workArea;
  const slackX = Math.max(0, source.width - frame.width);
  const slackY = Math.max(0, source.height - frame.height);
  const fractionX = slackX > 0 ? clamp((frame.x - source.x) / slackX, 0, 1) : 0.5;
  const fractionY = slackY > 0 ? clamp((frame.y - source.y) / slackY, 0, 1) : 0;
  return {
    x: area.x + Math.round((area.width - width) * fractionX),
    y: area.y + Math.round((area.height - height) * fractionY),
    width,
    height,
  };
}

/** A frame `step` points down and to the right of `frame`, wrapped back to the work area's corner when it would leave it. */
export function cascadeFrame(frame: Rect, display: DesktopDisplay, step = 32): Rect {
  const area = display.workArea;
  const width = Math.min(frame.width, area.width);
  const height = Math.min(frame.height, area.height);
  const x = frame.x + step;
  const y = frame.y + step;
  const fits = x + width <= area.x + area.width && y + height <= area.y + area.height;
  return fitFrameInArea(fits ? { x, y, width, height } : { x: area.x + step, y: area.y + step, width, height }, area);
}
