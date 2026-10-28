import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { legacyWindowsApp, moveLegacyAppIdentifierFolders, windowsIdentifierMoveScript } from "./app-identifier";

// The Mac move runs in this process, so these check what is on disk after it.
// The Windows one is a script the Windows verification runs for real
// (scripts/verify-windows-desktop.ps1); here, what decides how it runs.
let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "gloom-app-identifier-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const support = () => join(home, "Library", "Application Support");

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function mac() {
  return moveLegacyAppIdentifierFolders({ platform: "darwin", execPath: "/Applications/Gloom.app/Contents/MacOS/bun", homeDir: home, pid: 1, ppid: 1 });
}

describe("on a Mac", () => {
  test("the old folder becomes the new one, with the update the old build downloaded", async () => {
    write(join(support(), "com.vincelwt.gloomberb", "stable", "self-extraction", "abc123.tar"), "the build now running");

    expect(await mac()).toEqual({ kind: "moved" });

    expect(readdirSync(support())).toEqual(["sh.gloom.desktop"]);
    expect(readFileSync(join(support(), "sh.gloom.desktop", "stable", "self-extraction", "abc123.tar"), "utf8")).toBe("the build now running");
  });

  test("beside a folder this build already made, what it lacks moves in and what it has stays", async () => {
    write(join(support(), "com.vincelwt.gloomberb", "stable", "self-extraction", "old.tar"), "old");
    write(join(support(), "com.vincelwt.gloomberb", "stable", "notes", "kept.txt"), "moved");
    write(join(support(), "sh.gloom.desktop", "stable", "self-extraction", "new.tar"), "new");

    expect(await mac()).toEqual({ kind: "moved" });

    const current = join(support(), "sh.gloom.desktop", "stable");
    expect(readdirSync(support())).toEqual(["sh.gloom.desktop"]);
    expect(readdirSync(join(current, "self-extraction"))).toEqual(["new.tar"]);
    expect(readFileSync(join(current, "notes", "kept.txt"), "utf8")).toBe("moved");
  });

  test("with nothing under the old identifier, nothing is written", async () => {
    expect(await mac()).toEqual({ kind: "none" });
    expect(existsSync(support())).toBe(false);
  });
});

describe("on Windows", () => {
  const legacy = "C:\\Users\\O'Brien\\AppData\\Local\\com.vincelwt.gloomberb";

  test("finds the app running from the old folder, whatever the case of its path", () => {
    expect(legacyWindowsApp(`${legacy}\\stable\\app\\bin\\bun.exe`, legacy)).toEqual({
      folder: `${legacy}\\stable\\app`,
      launcher: "stable\\app\\bin\\launcher.exe",
    });
    expect(legacyWindowsApp("c:\\users\\o'brien\\appdata\\local\\COM.VINCELWT.GLOOMBERB\\stable\\app\\bin\\bun.exe", legacy)?.launcher)
      .toBe("stable\\app\\bin\\launcher.exe");
    // The installer's folder, and a folder that only starts like the old one.
    expect(legacyWindowsApp("C:\\Users\\O'Brien\\AppData\\Local\\Programs\\Gloom\\bin\\bun.exe", legacy)).toBeNull();
    expect(legacyWindowsApp(`${legacy}-other\\stable\\app\\bin\\bun.exe`, legacy)).toBeNull();
  });

  test("the script carries a path with a quote in it as one PowerShell string", () => {
    const script = windowsIdentifierMoveScript({
      legacy,
      current: "C:\\Users\\O'Brien\\AppData\\Local\\sh.gloom.desktop",
      afterExit: { pids: [4120, 0, 3996], folder: `${legacy}\\stable\\app`, launcher: "stable\\app\\bin\\launcher.exe", taskName: "GloomIdentifierMove-1" },
    });
    expect(script).toContain("$Legacy = 'C:\\Users\\O''Brien\\AppData\\Local\\com.vincelwt.gloomberb'\r\n");
    expect(script).toContain("$AppPids = @(4120, 3996)\r\n");
    expect(script).toContain("$OldWins = $true\r\n");
    expect(script).not.toMatch(/[^\r]\n/);
  });
});
