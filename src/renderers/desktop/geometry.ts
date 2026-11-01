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
 * Puts a frame on a connected display. A window that is still on one stays
 * put, pulled in just enough that its title bar can be reached. One left on
 * a display that is gone moves onto the display it overlaps most, or the
 * primary display, at that display's left edge, keeping its vertical place.
 */
export function fitFrameToDisplays(frame: Rect, displays: readonly DesktopDisplay[]): Rect {
  const usable = usableDisplays(displays);
  if (usable.length === 0) return frame;
  const display = displayForFrame(frame, usable) ?? usable[0]!;
  const area = display.workArea;
  const width = Math.min(frame.width, area.width);
  const height = Math.min(frame.height, area.height);
  if (overlapArea(frame, area) === 0) {
    const maxY = area.y + area.height - height;
    return { x: area.x, y: clamp(frame.y, area.y, Math.max(area.y, maxY)), width, height };
  }
  const marginX = Math.min(48, width);
  const marginY = Math.min(48, height);
  const minX = area.x + marginX - width;
  const maxX = area.x + area.width - marginX;
  const maxY = area.y + area.height - marginY;
  return {
    x: width === area.width ? area.x : clamp(frame.x, minX, Math.max(minX, maxX)),
    // Never above the work area: the title bar is how the window is moved.
    y: height === area.height ? area.y : clamp(frame.y, area.y, Math.max(area.y, maxY)),
    width,
    height,
  };
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
  return fits ? { x, y, width, height } : { x: area.x + step, y: area.y + step, width, height };
}
