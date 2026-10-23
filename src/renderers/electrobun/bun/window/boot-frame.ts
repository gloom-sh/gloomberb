import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getGloomberbDirs } from "../../../../data/config/home";
import { isBootFrame, type BootFrame } from "../../../dom/boot-frame-page";
import { DESKTOP_BOOT_FRAME_GLOBAL } from "../../shared/boot-frame";

/**
 * The main window's launch frame lives beside the remembered window frame:
 * read before the config, and drawn for this machine's screen.
 */
const FILE_NAME = "desktop-boot-frame.json";

export function desktopBootFramePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(getGloomberbDirs(env).configFile), FILE_NAME);
}

export function readDesktopBootFrame(path: string): BootFrame | null {
  try {
    const frame: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isBootFrame(frame) ? frame : null;
  } catch {
    return null;
  }
}

export function writeDesktopBootFrame(path: string, frame: BootFrame): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(frame));
  renameSync(temporary, path);
}

/**
 * The main window's preload: the frame its page draws before its script
 * loads, or null for the bare shell. Set either way, which is how the page
 * tells the main window from a popped-out pane's.
 */
export function desktopBootFramePreload(frame: BootFrame | null): string {
  const json = JSON.stringify(frame)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return `window.${DESKTOP_BOOT_FRAME_GLOBAL} = ${json};`;
}
