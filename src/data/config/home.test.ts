import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { getGloomberbDirs } from "./home";
import { getDataDir, initDataDir, resetAllData, saveConfig } from "./store/node";

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * #728: the only way to relocate `~/.gloomberb` used to be editing `dataDir`
 * in config.json, and that file lives in the folder being moved, so the next
 * launch started a fresh `~/.gloomberb`. `GLOOMBERB_HOME` moves the folder.
 * #1267: a new Linux install follows XDG; an existing `~/.gloomberb` stays put.
 */
describe("getGloomberbDirs", () => {
  test("GLOOMBERB_HOME holds everything on every platform, with a leading ~ expanded", () => {
    const home = tempDir("gloom-user-");
    mkdirSync(join(home, ".config", "gloomberb"), { recursive: true });
    writeFileSync(join(home, ".config", "gloomberb", "config.json"), "{}");

    for (const platform of ["linux", "darwin", "win32"] as const) {
      const dirs = getGloomberbDirs({ HOME: home, GLOOMBERB_HOME: "~/gloom" }, platform);
      expect(dirs).toEqual({
        kind: "override",
        configFile: join(home, "gloom", "config.json"),
        data: join(home, "gloom"),
        plugins: join(home, "gloom", "plugins"),
        pluginCache: join(home, "gloom", "plugin-cache"),
      });
    }
  });

  test("a blank GLOOMBERB_HOME is unset", () => {
    const home = tempDir("gloom-user-");
    expect(getGloomberbDirs({ HOME: home, GLOOMBERB_HOME: "   " }, "darwin").data).toBe(join(home, ".gloomberb"));
  });

  test("macOS and Windows keep ~/.gloomberb even when it does not exist yet", () => {
    const home = tempDir("gloom-user-");
    for (const platform of ["darwin", "win32"] as const) {
      const dirs = getGloomberbDirs({ HOME: home, XDG_CONFIG_HOME: join(home, "cfg") }, platform);
      expect(dirs.kind).toBe("home");
      expect(dirs.configFile).toBe(join(home, ".gloomberb", "config.json"));
      expect(dirs.pluginCache).toBe(join(home, ".gloomberb", "plugin-cache"));
    }
  });

  test("Linux keeps an existing ~/.gloomberb, even a symlink to a drive that is not mounted", () => {
    const home = tempDir("gloom-user-");
    mkdirSync(join(home, ".gloomberb"));
    expect(getGloomberbDirs({ HOME: home }, "linux").kind).toBe("home");

    const unmounted = tempDir("gloom-user-");
    symlinkSync(join(unmounted, "missing-drive"), join(unmounted, ".gloomberb"));
    expect(getGloomberbDirs({ HOME: unmounted }, "linux")).toMatchObject({ kind: "home", data: join(unmounted, ".gloomberb") });
  });

  test("a new Linux install splits config, data and cache across the XDG defaults", () => {
    const home = tempDir("gloom-user-");
    expect(getGloomberbDirs({ HOME: home }, "linux")).toEqual({
      kind: "xdg",
      configFile: join(home, ".config", "gloomberb", "config.json"),
      data: join(home, ".local", "share", "gloomberb"),
      plugins: join(home, ".local", "share", "gloomberb", "plugins"),
      pluginCache: join(home, ".cache", "gloomberb", "plugin-cache"),
    });
  });

  test("XDG variables count only when they hold an absolute path", () => {
    const home = tempDir("gloom-user-");
    const env = { HOME: home, XDG_CONFIG_HOME: join(home, "cfg"), XDG_DATA_HOME: "", XDG_CACHE_HOME: "relative/cache" };
    const dirs = getGloomberbDirs(env, "linux");
    expect(dirs.configFile).toBe(join(home, "cfg", "gloomberb", "config.json"));
    expect(dirs.data).toBe(join(home, ".local", "share", "gloomberb"));
    expect(dirs.pluginCache).toBe(join(home, ".cache", "gloomberb", "plugin-cache"));
  });

  test("once an XDG config.json exists, a ~/.gloomberb created later does not take over", () => {
    const home = tempDir("gloom-user-");
    mkdirSync(join(home, ".config", "gloomberb"), { recursive: true });
    writeFileSync(join(home, ".config", "gloomberb", "config.json"), "{}");
    mkdirSync(join(home, ".gloomberb"));
    expect(getGloomberbDirs({ HOME: home }, "linux").kind).toBe("xdg");
  });
});

describe("config store", () => {
  const keys = ["HOME", "GLOOMBERB_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  /** Clears the override and XDG variables, so the developer's own cannot leak in. */
  function useEnv(env: Partial<Record<(typeof keys)[number], string>>): void {
    for (const key of keys) {
      if (env[key] !== undefined) process.env[key] = env[key];
      else if (key !== "HOME") delete process.env[key];
    }
  }

  function readJson(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf-8"));
  }

  describe("under GLOOMBERB_HOME", () => {
    function home(config: Record<string, unknown>): string {
      const dir = tempDir("gloom-home-");
      writeFileSync(join(dir, "config.json"), JSON.stringify(config));
      useEnv({ GLOOMBERB_HOME: dir });
      return dir;
    }

    test("reads the global config from the overridden home", async () => {
      const elsewhere = tempDir("gloom-data-");
      home({ dataDir: elsewhere });
      expect(await getDataDir()).toBe(elsewhere);
    });

    test("a moved folder whose config still names the old, now missing, data directory lands in the new home", async () => {
      const dir = home({ dataDir: "/nonexistent/old/.gloomberb" });

      expect(await getDataDir()).toBe(dir);

      // The first launch records the new location, so later launches do not
      // depend on the old path staying absent.
      const config = await initDataDir(dir);
      expect(config.dataDir).toBe(dir);
      expect(readJson(join(dir, "config.json")).dataDir).toBe(dir);
    });
  });

  // getDataDir and friends read process.platform, so the XDG cases run where CI does.
  describe.skipIf(process.platform !== "linux")("on Linux", () => {
    function xdgPaths(home: string) {
      return {
        configFile: join(home, ".config", "gloomberb", "config.json"),
        data: join(home, ".local", "share", "gloomberb"),
        legacy: join(home, ".gloomberb"),
      };
    }

    test("a first launch keeps config.json in the config dir, the data in the data dir, and never creates ~/.gloomberb", async () => {
      const home = tempDir("gloom-user-");
      useEnv({ HOME: home });
      const paths = xdgPaths(home);

      // The terminal and the desktop app both start this way.
      const dataDir = await getDataDir() ?? getGloomberbDirs().data;
      expect(dataDir).toBe(paths.data);
      const config = await initDataDir(dataDir);

      expect(config.dataDir).toBe(paths.data);
      expect(readJson(paths.configFile).dataDir).toBe(paths.data);
      expect(existsSync(join(paths.data, "config.json"))).toBe(false);
      expect(existsSync(paths.legacy)).toBe(false);

      // The next launch finds the same folders and settings, also after a
      // ~/.gloomberb appears.
      await saveConfig({ ...config, onboardingComplete: true });
      expect(await getDataDir()).toBe(paths.data);
      mkdirSync(paths.legacy);
      expect(getGloomberbDirs().kind).toBe("xdg");
      expect(await getDataDir()).toBe(paths.data);
      expect((await initDataDir(paths.data)).onboardingComplete).toBe(true);
    });

    test("an XDG config.json that still names a missing ~/.gloomberb lands in the XDG data dir", async () => {
      const home = tempDir("gloom-user-");
      useEnv({ HOME: home });
      const paths = xdgPaths(home);
      mkdirSync(join(home, ".config", "gloomberb"), { recursive: true });
      writeFileSync(paths.configFile, JSON.stringify({ dataDir: paths.legacy, onboardingComplete: true }));

      expect(await getDataDir()).toBe(paths.data);
      const config = await initDataDir(paths.data);
      expect(config.onboardingComplete).toBe(true);
      expect(readJson(paths.configFile).dataDir).toBe(paths.data);
      expect(existsSync(paths.legacy)).toBe(false);
    });

    test("a data directory chosen in config.json carries its own config, and the XDG file only points at it", async () => {
      const home = tempDir("gloom-user-");
      const chosen = tempDir("gloom-data-");
      useEnv({ HOME: home });
      const paths = xdgPaths(home);
      mkdirSync(join(home, ".config", "gloomberb"), { recursive: true });
      writeFileSync(paths.configFile, JSON.stringify({ dataDir: chosen }));

      expect(await getDataDir()).toBe(chosen);
      await initDataDir(chosen);
      expect(readJson(join(chosen, "config.json")).dataDir).toBe(chosen);
      expect(readJson(paths.configFile)).toEqual({ dataDir: chosen });
    });

    test("resetting all data also removes the XDG config.json, so the setup wizard runs again", async () => {
      const home = tempDir("gloom-user-");
      useEnv({ HOME: home });
      const paths = xdgPaths(home);
      await initDataDir(paths.data);

      await resetAllData(paths.data);
      expect(existsSync(paths.configFile)).toBe(false);
      expect(existsSync(paths.data)).toBe(false);
      expect(await getDataDir()).toBeNull();
    });

    test("an existing ~/.gloomberb keeps its config.json and gets no XDG folders", async () => {
      const home = tempDir("gloom-user-");
      useEnv({ HOME: home });
      const paths = xdgPaths(home);
      mkdirSync(paths.legacy);

      const dataDir = await getDataDir() ?? getGloomberbDirs().data;
      expect(dataDir).toBe(paths.legacy);
      await initDataDir(dataDir);
      expect(readJson(join(paths.legacy, "config.json")).dataDir).toBe(paths.legacy);
      expect(existsSync(join(home, ".config"))).toBe(false);
      expect(existsSync(join(home, ".local"))).toBe(false);
    });
  });
});
