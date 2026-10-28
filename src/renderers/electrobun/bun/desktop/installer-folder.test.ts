import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { installerFolderScript, mayTryMove, noteMoveTry, regExportValue, updaterAppFolder, WINDOWS_INSTALLER_APP_ID } from "./installer-folder";

// What these decide is whether the app quits at its start to move itself, and
// what the script it leaves moves. The script runs in Windows PowerShell on
// folders made for it in scripts/verify-windows-installer-folder.test.ps1, and
// on a real install in scripts/verify-windows-update.ps1.
describe("the Windows installer's folder", () => {
  const local = "C:\\Users\\O'Brien\\AppData\\Local";

  test("finds the app in the updater's folder under either identifier, whatever the case of its path", () => {
    expect(updaterAppFolder(`${local}\\com.vincelwt.gloomberb\\stable\\app\\bin\\bun.exe`, local)).toEqual({
      folder: `${local}\\com.vincelwt.gloomberb\\stable\\app`,
      channel: "stable",
    });
    expect(updaterAppFolder(`${local.toLowerCase()}\\SH.GLOOM.DESKTOP\\stable\\APP\\Bin\\bun.exe`, local)?.channel).toBe("stable");
    // The installer's folder, another app's, and a copy deeper in the updater's.
    expect(updaterAppFolder(`${local}\\Programs\\Gloom\\bin\\bun.exe`, local)).toBeNull();
    expect(updaterAppFolder(`${local}\\com.other.app\\stable\\app\\bin\\bun.exe`, local)).toBeNull();
    expect(updaterAppFolder(`${local}\\com.vincelwt.gloomberb\\stable\\app\\x\\bin\\bun.exe`, local)).toBeNull();
    expect(updaterAppFolder(`D:\\com.vincelwt.gloomberb\\stable\\app\\bin\\bun.exe`, local)).toBeNull();
  });

  test("reads the installer's folder from its uninstall entry as reg export writes it", () => {
    const entry = [
      "Windows Registry Editor Version 5.00",
      "",
      `[HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${WINDOWS_INSTALLER_APP_ID}_is1]`,
      "\"Inno Setup: App Path\"=\"C:\\\\Users\\\\José \\\"J\\\"\\\\AppData\\\\Local\\\\Programs\\\\Gloom\"",
      "\"EstimatedSize\"=dword:00000400",
    ].join("\r\n");
    expect(regExportValue(entry, "Inno Setup: App Path")).toBe("C:\\Users\\José \"J\"\\AppData\\Local\\Programs\\Gloom");
    expect(regExportValue(entry, "EstimatedSize")).toBeNull();
    expect(regExportValue(entry, "InstallLocation")).toBeNull();
  });

  test("is the folder the installer records under its AppId", () => {
    const iss = readFileSync(join(import.meta.dir, "../../../../../scripts/windows-installer.iss"), "utf8");
    expect(iss).toContain(`AppId={${WINDOWS_INSTALLER_APP_ID}`);
  });

  test("the script carries paths with a quote in them as single PowerShell strings", () => {
    const script = installerFolderScript({
      target: `${local}\\Programs\\Gloom`,
      sources: [`${local}\\com.vincelwt.gloomberb\\stable\\app`],
      folder: `${local}\\com.vincelwt.gloomberb\\stable`,
      log: `${local}\\com.vincelwt.gloomberb\\stable\\installer-folder.log`,
      afterExit: { cancel: `${local}\\com.vincelwt.gloomberb\\stable\\installer-folder.cancel`, taskName: "GloomInstallerFolder-1" },
    });
    expect(script).toContain("$Target = 'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\Gloom'\n");
    expect(script).toContain("$Sources = @('C:\\Users\\O''Brien\\AppData\\Local\\com.vincelwt.gloomberb\\stable\\app')\n");
    expect(script).toContain("$AfterExit = $true\n");
    expect(installerFolderScript({ target: "C:\\Gloom", sources: [], folder: "C:\\x", log: "C:\\x\\log" })).toContain("$AfterExit = $false\n");
  });

  // A move that cannot happen must not make the app quit and open again at
  // every start: it waits between tries, and gives up on a build after three.
  test("tries to move a build three times at most, ten minutes apart", () => {
    const minute = 60_000;
    let tries = null as ReturnType<typeof noteMoveTry> | null;
    let now = 0;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(mayTryMove(tries, "0.19.0+abc", now)).toBe(true);
      tries = noteMoveTry(tries, "0.19.0+abc", now);
      expect(mayTryMove(tries, "0.19.0+abc", now + 9 * minute)).toBe(false);
      now += 10 * minute;
    }
    expect(mayTryMove(tries, "0.19.0+abc", now + 24 * 60 * minute)).toBe(false);
    // The next update starts over.
    expect(mayTryMove(tries, "0.19.1+def", now)).toBe(true);
    expect(noteMoveTry(tries, "0.19.1+def", now).failed).toBe(1);
  });

  test("waits, without giving up, while the installer's folder is in use", () => {
    let tries = noteMoveTry(null, "0.19.0+abc", 0);
    for (let start = 1; start <= 10; start += 1) {
      tries = noteMoveTry(tries, "0.19.0+abc", start * 600_000, false);
      expect(mayTryMove(tries, "0.19.0+abc", start * 600_000 + 1)).toBe(false);
    }
    expect(tries.failed).toBe(1);
    expect(mayTryMove(tries, "0.19.0+abc", 11 * 600_000)).toBe(true);
  });
});
