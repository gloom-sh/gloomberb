import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getGloomberbDirs } from "../../../../data/config/home";
import type { WindowFrame } from "./frame";

/**
 * The main window's last frame lives beside the config, not in it. Launch
 * reads it before config is loaded, and a frame is this machine's screen,
 * so it stays out of the synced config.
 */
const FILE_NAME = "desktop-window.json";

export interface RememberedDesktopWindow {
  frame: WindowFrame;
  maximized: boolean;
  fullscreen: boolean;
}

export interface DisplayWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
  primary?: boolean;
}

export function rememberedDesktopWindowPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(getGloomberbDirs(env).configFile), FILE_NAME);
}

export function parseRememberedDesktopWindow(raw: unknown): RememberedDesktopWindow | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const frame = record.frame;
  if (!frame || typeof frame !== "object") return null;
  const { x, y, width, height } = frame as Record<string, unknown>;
  if (![x, y, width, height].every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if ((width as number) < 1 || (height as number) < 1) return null;
  return {
    frame: { x: x as number, y: y as number, width: width as number, height: height as number },
    maximized: record.maximized === true,
    fullscreen: record.fullscreen === true,
  };
}

export function readRememberedDesktopWindow(path: string): RememberedDesktopWindow | null {
  try {
    return parseRememberedDesktopWindow(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

export function writeRememberedDesktopWindow(path: string, value: RememberedDesktopWindow): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value));
  renameSync(temporary, path);
}

function overlapArea(frame: WindowFrame, display: DisplayWorkArea): number {
  const width = Math.min(frame.x + frame.width, display.x + display.width) - Math.max(frame.x, display.x);
  const height = Math.min(frame.y + frame.height, display.y + display.height) - Math.max(frame.y, display.y);
  return width > 0 && height > 0 ? width * height : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Puts a saved frame on a connected display. A window that still intersects
 * one stays put. One left on a display that is gone moves onto the display
 * with the most overlap, or the primary display.
 */
export function fitWindowFrameToDisplays(
  frame: WindowFrame,
  displays: readonly DisplayWorkArea[],
): WindowFrame {
  const usable = displays.filter((display) => display.width >= 1 && display.height >= 1);
  if (usable.length === 0) return frame;
  const centerX = frame.x + frame.width / 2;
  const centerY = frame.y + frame.height / 2;
  const containing = usable.find((display) => (
    centerX >= display.x && centerX < display.x + display.width
    && centerY >= display.y && centerY < display.y + display.height
  ));
  let display = containing;
  if (!display) {
    let best = usable[0]!;
    let bestArea = overlapArea(frame, best);
    for (const candidate of usable.slice(1)) {
      const area = overlapArea(frame, candidate);
      if (area > bestArea) {
        best = candidate;
        bestArea = area;
      }
    }
    display = bestArea > 0 ? best : usable.find((candidate) => candidate.primary) ?? usable[0]!;
  }
  const width = Math.min(frame.width, display.width);
  const height = Math.min(frame.height, display.height);
  // A window left on a display that is no longer connected comes back on the
  // one that remains, at that display's left edge, keeping its vertical place.
  if (overlapArea(frame, display) === 0) {
    const minY = display.y;
    const maxY = display.y + display.height - height;
    return { x: display.x, y: clamp(frame.y, minY, Math.max(minY, maxY)), width, height };
  }
  const marginX = Math.min(48, width);
  const marginY = Math.min(48, height);
  const minX = display.x + marginX - width;
  const maxX = display.x + display.width - marginX;
  const minY = display.y;
  const maxY = display.y + display.height - marginY;
  return {
    x: width === display.width ? display.x : clamp(frame.x, minX, Math.max(minX, maxX)),
    y: height === display.height ? display.y : clamp(frame.y, minY, Math.max(minY, maxY)),
    width,
    height,
  };
}
