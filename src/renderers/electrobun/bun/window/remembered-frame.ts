import { readFileSync } from "fs";
import { dirname, join } from "path";
import { getGloomberbDirs } from "../../../../data/config/home";
import type { WindowFrame } from "./frame";

/**
 * Where builds before the window setup (desktop/screen-setup.ts) kept the
 * main window's last frame. Read once, for the first launch after the
 * update, when the setup has nothing for the main window yet.
 */
const FILE_NAME = "desktop-window.json";

export interface RememberedDesktopWindow {
  frame: WindowFrame;
  maximized: boolean;
  fullscreen: boolean;
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
