import { homedir } from "os";
import { join } from "path";

/**
 * Where Gloomberb keeps everything local: the global config that records the
 * data directory, the data directory itself unless that record says
 * otherwise, installed plugins, and the plugin bundle cache.
 *
 * `~/.gloomberb` by default. `GLOOMBERB_HOME` moves the whole folder (#728):
 * editing `dataDir` in config.json alone could never do that, because the
 * file holding the edit lives in the folder being moved, and a launch that
 * did not find it there started a fresh `~/.gloomberb`.
 */
const GLOOMBERB_HOME_ENV = "GLOOMBERB_HOME";

function getUserHome(env: NodeJS.ProcessEnv): string {
  return env.HOME || homedir();
}

/** Expands a leading `~` the way a shell would, so `GLOOMBERB_HOME=~/gloom` works from any launcher. */
export function expandUserHome(path: string, env: NodeJS.ProcessEnv = process.env): string {
  if (path === "~") return getUserHome(env);
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(getUserHome(env), path.slice(2));
  return path;
}

/** The default location, ignoring any override. */
export function getDefaultGloomberbHome(env: NodeJS.ProcessEnv = process.env): string {
  return join(getUserHome(env), ".gloomberb");
}

/** The active location: the override when set, `~/.gloomberb` otherwise. */
export function getGloomberbHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[GLOOMBERB_HOME_ENV]?.trim();
  return override ? expandUserHome(override, env) : getDefaultGloomberbHome(env);
}

/** True when the location comes from `GLOOMBERB_HOME`. */
export function isGloomberbHomeOverridden(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env[GLOOMBERB_HOME_ENV]?.trim();
}
