import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "path";
import { logFailure } from "../utils/log-failure";
import { readPluginManifest } from "./compat";

/**
 * A plugin's logo as the desktop and the web draw it: the file its gloom.json
 * names as `icon` (PLUGINS.md), or the `icon.svg`, `icon.webp` or `icon.png`
 * a checkout without one ships beside its entry, read into a `data:` URL. The
 * view has no filesystem, so the Bun process that reads the plugins folder
 * hands the image over with the plugin's bundle.
 */

const ICON_TYPES: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const CONVENTIONAL_ICONS = ["icon.svg", "icon.webp", "icon.png"];

/** A logo is drawn at most a few dozen pixels wide; anything larger is not one. */
const MAX_ICON_BYTES = 256 * 1024;

/**
 * The icon `name` names inside `pluginDir`, typed by the name the plugin gave
 * it, or null for a path that leaves the checkout or is not a small image.
 */
function iconFile(pluginDir: string, name: string): { path: string; type: string } | null {
  const type = ICON_TYPES[extname(name).toLowerCase()];
  if (!type) return null;
  const root = realpathSync(pluginDir);
  const path = resolve(root, name);
  if (!existsSync(path)) return null;
  // A link that points out of the checkout is not the plugin's to show.
  const real = realpathSync(path);
  const inside = relative(root, real);
  if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return null;
  const info = statSync(real);
  return info.isFile() && info.size > 0 && info.size <= MAX_ICON_BYTES ? { path: real, type } : null;
}

/** The plugin's logo as a `data:` URL; a declared icon that is missing or unusable falls back to the conventional names. */
export function readPluginIcon(pluginDir: string): string | null {
  try {
    const declared = readPluginManifest(pluginDir).icon;
    for (const name of declared ? [declared, ...CONVENTIONAL_ICONS] : CONVENTIONAL_ICONS) {
      const icon = iconFile(pluginDir, name);
      if (icon) return `data:${icon.type};base64,${readFileSync(icon.path).toString("base64")}`;
    }
    return null;
  } catch (error) {
    logFailure("plugin-icon", `Reading the icon of ${basename(pluginDir)} failed`)(error);
    return null;
  }
}
