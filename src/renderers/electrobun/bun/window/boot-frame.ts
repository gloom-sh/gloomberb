import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
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

interface BootFrameSender {
  /** The main window's view; a popped-out pane's draws no frame. */
  mainWindow: boolean;
  /** A session is up. After all data was reset there is none until the next launch. */
  session: boolean;
}

/**
 * Keeps the frame a view sent, if it may: from the main window, while a
 * session is up, and of the right shape and size. A closing window's last
 * frame, sent after a reset, is dropped. Returns whether it was written.
 */
export function saveDesktopBootFrame(path: string, frame: unknown, sender: BootFrameSender): boolean {
  if (!sender.mainWindow || !sender.session || !isBootFrame(frame)) return false;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(frame));
  renameSync(temporary, path);
  return true;
}

/**
 * Forgets the frame, with the rest of the data on a reset. It sits beside
 * the config, which a custom data folder is not, so removing the data folder
 * alone could leave it behind.
 */
export function removeDesktopBootFrame(path: string): void {
  rmSync(path, { force: true });
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
