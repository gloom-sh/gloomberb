import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { installerFolderScript, regExportValue, updaterAppFolder, WINDOWS_INSTALLER_APP_ID } from "./installer-folder";

// What these decide is whether the app quits at its start to move itself, and
// what the script it leaves moves. The move itself runs on a real install in
// the Windows verification (scripts/verify-windows-update.ps1).
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
      afterExit: { pids: [4120, 0, 3996], taskName: "GloomInstallerFolder-1" },
    });
    expect(script).toContain("$Target = 'C:\\Users\\O''Brien\\AppData\\Local\\Programs\\Gloom'\n");
    expect(script).toContain("$Sources = @('C:\\Users\\O''Brien\\AppData\\Local\\com.vincelwt.gloomberb\\stable\\app')\n");
    expect(script).toContain("$AppPids = @(4120, 3996)\n");
  });
});
