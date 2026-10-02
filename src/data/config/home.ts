import { lstatSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join } from "path";

/**
 * Where Gloomberb keeps everything local: the global config that records the
 * data directory, the data directory itself unless that record says
 * otherwise, installed plugins, and the plugin bundle cache.
 *
 * `~/.gloomberb` by default. `GLOOMBERB_HOME` moves the whole folder (#728):
 * editing `dataDir` in config.json alone could never do that, because the
 * file holding the edit lives in the folder being moved, and a launch that
 * did not find it there started a fresh `~/.gloomberb`.
 *
 * On Linux a new install follows the XDG Base Directory spec instead (#1267):
 * config.json in `$XDG_CONFIG_HOME/gloomberb`, the data directory, plugins
 * and the terminal media pid file in `$XDG_DATA_HOME/gloomberb`, the plugin
 * cache in `$XDG_CACHE_HOME/gloomberb`. An existing `~/.gloomberb` keeps
 * winning, so no install moves. Once an XDG config.json exists it wins over
 * a `~/.gloomberb` created later (an older version, a stray `mkdir`), so the
 * choice cannot flip and leave the data behind.
 *
 * Every caller goes through `getGloomberbDirs`, so the terminal, the desktop
 * app and the CLI resolve the same folders from the same environment.
 */
const GLOOMBERB_HOME_ENV = "GLOOMBERB_HOME";
const XDG_FOLDER = "gloomberb";

export interface GloomberbDirs {
  /**
   * `override`: everything under `GLOOMBERB_HOME`. `home`: everything under
   * `~/.gloomberb`. `xdg`: split across the XDG base directories.
   */
  kind: "override" | "home" | "xdg";
  /** The global config.json, which records the data directory. */
  configFile: string;
  /** The data directory used when config.json records none. */
  data: string;
  /** Installed plugins. */
  plugins: string;
  /** Host-owned scratch space for plugins: bundles, update state. */
  pluginCache: string;
}

function getUserHome(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
}

/** Expands a leading `~` the way a shell would, so `GLOOMBERB_HOME=~/gloom` works from any launcher. */
export function expandUserHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path === "~") return getUserHome(env);
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(getUserHome(env), path.slice(2));
  return path;
}

/** Any entry counts, a dangling symlink included: an unmounted drive behind `~/.gloomberb` is still an install. */
function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** One folder for everything, as on every platform before #1267. */
function singleFolder(kind: "override" | "home", home: string): GloomberbDirs {
  return {
    kind,
    configFile: join(home, "config.json"),
    data: home,
    plugins: join(home, "plugins"),
    pluginCache: join(home, "plugin-cache"),
  };
}

/** An XDG base directory: the variable when it holds an absolute path, the spec's default otherwise. */
function xdgBase(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
  const value = env[variable];
  return value && isAbsolute(value) ? value : join(getUserHome(env), fallback);
}

function xdgFolders(env: NodeJS.ProcessEnv): GloomberbDirs {
  const data = join(xdgBase(env, "XDG_DATA_HOME", join(".local", "share")), XDG_FOLDER);
  return {
    kind: "xdg",
    configFile: join(xdgBase(env, "XDG_CONFIG_HOME", ".config"), XDG_FOLDER, "config.json"),
    data,
    plugins: join(data, "plugins"),
    pluginCache: join(xdgBase(env, "XDG_CACHE_HOME", ".cache"), XDG_FOLDER, "plugin-cache"),
  };
}

/**
 * The folders this launch uses. Resolved per call rather than cached, so a
 * test can point `HOME` or `GLOOMBERB_HOME` at a scratch directory.
 */
export function getGloomberbDirs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): GloomberbDirs {
  const override = env[GLOOMBERB_HOME_ENV]?.trim();
  if (override) return singleFolder("override", expandUserHome(override, env));

  const legacyHome = join(getUserHome(env), ".gloomberb");
  if (platform !== "linux") return singleFolder("home", legacyHome);

  const xdg = xdgFolders(env);
  if (pathExists(xdg.configFile)) return xdg;
  if (pathExists(legacyHome)) return singleFolder("home", legacyHome);
  return xdg;
}
