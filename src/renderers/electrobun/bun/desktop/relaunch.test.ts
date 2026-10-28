import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { desktopRelaunchCommand, scheduleDesktopRelaunch } from "./relaunch";

// The launcher starts the app inside `Gloomberb.app/Contents/MacOS`, and the
// rename to Gloom.app takes that folder away. Spawning the relaunch script
// from there failed as `ENOENT, posix_spawn 'sh'`, so the app quit and never
// opened again. These run the relaunch the same way: from a folder that is
// gone, with a PATH that has no shell.
describe("desktop relaunch", () => {
  test.skipIf(process.platform === "win32")("opens the app again from a folder that was renamed away, without PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "gloom-relaunch-"));
    const startedIn = join(root, "Gloomberb.app", "Contents", "MacOS");
    const marker = join(root, "relaunched");
    const app = join(root, "app");
    writeFileSync(app, `#!/bin/sh\nprintf '%s|' "$@" > '${marker}'\n`);
    chmodSync(app, 0o755);
    mkdirSync(startedIn, { recursive: true });
    const previousCwd = process.cwd();
    const previousPath = process.env.PATH;
    const running = Bun.spawn(["sleep", "0.3"]);
    try {
      process.chdir(startedIn);
      renameSync(join(root, "Gloomberb.app"), join(root, "Gloom.app"));
      process.env.PATH = join(root, "no-tools-here");
      scheduleDesktopRelaunch(undefined, {
        platform: "linux",
        pid: running.pid,
        execPath: app,
        args: ["--window", "it's main"],
        cwd: startedIn,
        pathEnv: "",
      });
    } finally {
      process.env.PATH = previousPath;
      process.chdir(previousCwd);
    }
    try {
      for (let attempt = 0; attempt < 100 && !existsSync(marker); attempt += 1) await Bun.sleep(50);
      // Only once the running process is gone.
      expect(running.exitCode).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("--window|it's main|");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("on Windows, starts the app from its launcher once this process has exited", () => {
    const command = desktopRelaunchCommand({
      platform: "win32",
      pid: 42,
      execPath: "C:\\Users\\Ann O'Neil\\Gloom\\bin\\bun.exe",
      args: ["C:\\Users\\Ann O'Neil\\Gloom\\Resources\\main.js"],
      cwd: "C:\\Users\\Ann O'Neil\\Gloom\\bin",
      pathEnv: "",
    });
    expect(command.cmd.slice(0, -1)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command"]);
    expect(command.cmd.at(-1)).toBe(
      "Wait-Process -Id 42 -ErrorAction SilentlyContinue; "
      + "Start-Process -FilePath 'C:\\Users\\Ann O''Neil\\Gloom\\bin\\launcher.exe' -WorkingDirectory 'C:\\Users\\Ann O''Neil\\Gloom\\bin'",
    );
  });

  test("on a Mac, opens the bundle by the full path of open, from /", () => {
    const context = { platform: "darwin", pid: 42, execPath: "/Applications/Gloomberb.app/Contents/MacOS/bun", args: [], cwd: "/Applications/Gloomberb.app/Contents/MacOS", pathEnv: "" };
    const renamed = desktopRelaunchCommand(context, "/Applications/Gloom.app");
    expect(renamed.cmd.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(renamed.cmd[2]).toEndWith("/usr/bin/open '/Applications/Gloom.app'");
    expect(renamed.cwd).toBe("/");
    expect(renamed.pathEnv).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    // Without a bundle it opens the one it runs from.
    expect(desktopRelaunchCommand(context).cmd[2]).toEndWith("/usr/bin/open '/Applications/Gloomberb.app'");
  });
});
