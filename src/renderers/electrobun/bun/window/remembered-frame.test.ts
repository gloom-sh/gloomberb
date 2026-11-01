import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  parseRememberedDesktopWindow,
  readRememberedDesktopWindow,
  rememberedDesktopWindowPath,
} from "./remembered-frame";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("remembered desktop window", () => {
  test("reads a saved frame and ignores a broken file", () => {
    const saved = {
      frame: { x: 120, y: 80, width: 1100, height: 700 },
      maximized: true,
      fullscreen: false,
    };
    expect(parseRememberedDesktopWindow(saved)).toEqual(saved);
    expect(parseRememberedDesktopWindow({ frame: { x: 1, y: 2, width: 0, height: 10 } })).toBeNull();
    expect(parseRememberedDesktopWindow({ x: 1 })).toBeNull();
    expect(parseRememberedDesktopWindow(null)).toBeNull();

    const directory = mkdtempSync(join(tmpdir(), "gloomberb-window-"));
    directories.push(directory);
    const path = join(directory, "desktop-window.json");
    expect(readRememberedDesktopWindow(path)).toBeNull();
    writeFileSync(path, JSON.stringify(saved));
    expect(readRememberedDesktopWindow(path)).toEqual(saved);
    expect(rememberedDesktopWindowPath({ GLOOMBERB_HOME: directory, HOME: directory })).toBe(path);
  });
});
