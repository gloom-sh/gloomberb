import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, expect, test } from "bun:test";
import { MAX_BOOT_FRAME_CHARS, type BootFrame } from "../../../dom/boot-frame-page";
import { DESKTOP_BOOT_FRAME_GLOBAL } from "../../shared/boot-frame";
import {
  desktopBootFramePreload,
  readDesktopBootFrame,
  removeDesktopBootFrame,
  saveDesktopBootFrame,
} from "./boot-frame";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function framePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "gloom-boot-frame-"));
  directories.push(directory);
  return join(directory, "config", "desktop-boot-frame.json");
}

const FRAME: BootFrame = {
  build: "b",
  width: 1440,
  height: 900,
  rootStyle: "--gloom-bg: #000;",
  bodyStyle: "font-size: 12px;",
  html: '<div data-gloom-role="status-bar">Home</div>',
};
const MAIN_WINDOW = { mainWindow: true, session: true };

test("only the main window's frame is kept, while a session is up, and only within the limits", () => {
  const path = framePath();
  expect(saveDesktopBootFrame(path, FRAME, { mainWindow: false, session: true })).toBe(false);
  expect(saveDesktopBootFrame(path, { ...FRAME, html: "x".repeat(MAX_BOOT_FRAME_CHARS + 1) }, MAIN_WINDOW)).toBe(false);
  expect(saveDesktopBootFrame(path, { ...FRAME, width: Number.NaN }, MAIN_WINDOW)).toBe(false);
  expect(existsSync(path)).toBe(false);

  expect(saveDesktopBootFrame(path, FRAME, MAIN_WINDOW)).toBe(true);
  expect(readDesktopBootFrame(path)).toEqual(FRAME);
});

test("a reset leaves no frame, and drops the one the closing window sends after it", () => {
  const path = framePath();
  saveDesktopBootFrame(path, FRAME, MAIN_WINDOW);
  removeDesktopBootFrame(path);
  expect(saveDesktopBootFrame(path, FRAME, { mainWindow: true, session: false })).toBe(false);
  expect(existsSync(path)).toBe(false);
  // Nothing to remove is fine too.
  removeDesktopBootFrame(path);
});

test("a broken or oversized file reads as no frame, and the preload stays inside its script", () => {
  const path = framePath();
  saveDesktopBootFrame(path, FRAME, MAIN_WINDOW);
  writeFileSync(path, "{not json");
  expect(readDesktopBootFrame(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ ...FRAME, html: "x".repeat(MAX_BOOT_FRAME_CHARS + 1) }));
  expect(readDesktopBootFrame(path)).toBeNull();

  const preload = desktopBootFramePreload({ ...FRAME, html: "</script><script>steal()</script>" });
  expect(preload).not.toContain("</script>");
  const window: Record<string, unknown> = {};
  new Function("window", preload)(window);
  expect((window[DESKTOP_BOOT_FRAME_GLOBAL] as BootFrame).html).toBe("</script><script>steal()</script>");
  // Set even with no frame: that is how the page tells the main window from a popped-out pane's.
  new Function("window", desktopBootFramePreload(null))(window);
  expect(window[DESKTOP_BOOT_FRAME_GLOBAL]).toBeNull();
});
