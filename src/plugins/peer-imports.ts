import { readFileSync, realpathSync } from "fs";
import { dirname, extname, isAbsolute, join, relative } from "path";
import type { BunPlugin } from "bun";

import { installedPeerPlugins } from "./host-link";

/**
 * A plugin's imports of a sibling plugin it declares as a peer (IBKR Gateway
 * imports `gloom-ibkr/gateway-bridge`), read from the sibling's own folder
 * instead of through the link in the plugin's `node_modules`.
 *
 * That link is a junction on Windows, and a process can be unable to follow
 * a junction at all. On the first launch after an update the gateway failed
 * with its link in place and pointing at Interactive Brokers: the loader wrote
 * it again four times, never saw it resolve, and an import that looked again
 * failed the same way, while Interactive Brokers itself loaded from its folder
 * in the same process. The next launch worked.
 *
 * So the host resolves those imports itself and hands Bun the sibling's file
 * by its absolute path: the file the link leads to, under the module key the
 * sibling's own imports give it, so the plugin still shares the sibling's
 * modules. The terminal and the desktop's Bun process rewrite the plugin's
 * source as Bun loads it; the desktop's compile for the view resolves them in
 * the bundler. The link stays, for editors, `tsc`, and older Gloom versions.
 */

type SourceLoader = "ts" | "tsx" | "js" | "jsx";

/** What Bun loads a plugin's own source files with, by extension. */
export const SOURCE_LOADERS: Readonly<Record<string, SourceLoader>> = {
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".jsx": "jsx",
};

export function sourceLoader(file: string): SourceLoader {
  return SOURCE_LOADERS[extname(file).toLowerCase()] ?? "js";
}

export function isInside(root: string, path: string): boolean {
  const inside = relative(root, path);
  return !!inside && !inside.startsWith("..") && !isAbsolute(inside);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Where a module is named: after `from`, `import` or `import(`, and in `require(`. */
const IMPORTED_AT = String.raw`(\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)`;

/**
 * `contents` with `specifier` replaced by `replacement` where it is imported.
 * The same text in a string anywhere else stays.
 */
export function replaceSpecifier(contents: string, specifier: string, replacement: string): string {
  const imported = new RegExp(`${IMPORTED_AT}(["'\`])${escapeRegExp(specifier)}\\2`, "g");
  return contents.replace(imported, (_match, at: string) => `${at}${JSON.stringify(replacement)}`);
}

function realFolder(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // Intentional ignore: a folder that cannot be resolved is matched as spelled.
    return path;
  }
}

/** Each registered plugin's real folder, with its siblings' folders by package name. */
const siblingsByPlugin = new Map<string, ReadonlyMap<string, string>>();
/** Real plugin folders whose source Bun loads through the hook below. */
const hookedFolders = new Set<string>();

/**
 * The installed siblings `pluginDir` declares, by package name, each with its
 * real folder. A sibling that maps its paths with `exports` is left out: only
 * a lookup through `node_modules` reads that map.
 */
function siblingFolders(pluginDir: string, pluginsDir: string = dirname(pluginDir)): Map<string, string> {
  const folders = new Map<string, string>();
  for (const { peer, directory } of installedPeerPlugins(pluginDir, pluginsDir)) {
    const folder = join(pluginsDir, directory);
    try {
      const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8")) as { exports?: unknown };
      if (pkg.exports !== undefined) continue;
    } catch {
      // Intentional ignore: a sibling without a readable package.json has no export map.
    }
    folders.set(peer, realFolder(folder));
  }
  return folders;
}

/** The file `specifier` names in the sibling `peer`, as Bun resolves it from inside its folder; null when there is none. */
function siblingModule(peer: string, peerDir: string, specifier: string): string | null {
  const subpath = specifier.slice(peer.length + 1);
  try {
    return Bun.resolveSync(subpath ? `./${subpath}` : ".", peerDir);
  } catch {
    // Intentional ignore: left as written, the import fails the way it always did.
    return null;
  }
}

/**
 * `contents` of `file` with its imports of the siblings its plugin declares
 * naming the siblings' files by absolute path. Anything else is left as
 * written: a file outside a registered plugin, and an import the sibling
 * cannot satisfy, which then fails the way it always did.
 */
export function withSiblingImports(file: string, contents: string): string {
  let siblings: ReadonlyMap<string, string> | undefined;
  for (const [root, folders] of siblingsByPlugin) {
    if (isInside(root, file)) siblings = folders;
  }
  if (!siblings) return contents;
  let next = contents;
  for (const [peer, peerDir] of siblings) {
    if (!next.includes(peer)) continue;
    const imported = new RegExp(`${IMPORTED_AT}(["'\`])(${escapeRegExp(peer)}(?:/[^"'\`\\s]*)?)\\2`, "g");
    next = next.replace(imported, (match, at: string, _quote: string, specifier: string) => {
      const target = siblingModule(peer, peerDir, specifier);
      return target ? `${at}${JSON.stringify(target)}` : match;
    });
  }
  return next;
}

function pathPattern(path: string): string {
  return path.split(/[\\/]+/).map(escapeRegExp).join("[\\\\/]+");
}

/**
 * The plugin's own source files, with an entry imported fresh (`?reload=`,
 * or the installer's `?validate=`); not its dependencies, and not a retried
 * import's files, which the retry's own hook loads the same way
 * (peer-retry.ts).
 */
function pluginSourceFilter(root: string): RegExp {
  return new RegExp(
    `^${pathPattern(root)}[\\\\/](?!(?:[^?]*[\\\\/])?node_modules[\\\\/])[^?]*\\.(?:tsx?|mts|jsx?|mjs)(?:\\?(?:reload|validate)=\\d+)?$`,
    process.platform === "win32" ? "i" : "",
  );
}

function hookPluginSource(root: string): boolean {
  if (hookedFolders.has(root)) return true;
  if (typeof Bun === "undefined" || typeof Bun.plugin !== "function") return false;
  Bun.plugin({
    name: "gloomberb-sibling-imports",
    setup(build) {
      build.onLoad({ filter: pluginSourceFilter(root) }, (args) => {
        const file = args.path.replace(/\?.*$/, "");
        return { contents: withSiblingImports(file, readFileSync(file, "utf8")), loader: sourceLoader(file) };
      });
    },
  });
  hookedFolders.add(root);
  return true;
}

/**
 * Makes this process import the siblings `pluginDir` declares from their own
 * folders, from the next import of the plugin on. Returns whether it does: a
 * plugin with no installed sibling, and a process without Bun's runtime
 * plugins, go through the links as before.
 */
export function importSiblingsFromTheirFolders(pluginDir: string, pluginsDir?: string): boolean {
  const siblings = siblingFolders(pluginDir, pluginsDir);
  const root = realFolder(pluginDir);
  if (siblings.size === 0) {
    siblingsByPlugin.delete(root);
    return false;
  }
  siblingsByPlugin.set(root, siblings);
  return hookPluginSource(root);
}

/**
 * The same for a bundle of `pluginDir`: a bundler plugin that resolves the
 * siblings it declares in their folders, or null when none is installed.
 */
export function siblingImportsBundlerPlugin(pluginDir: string, pluginsDir?: string): BunPlugin | null {
  const siblings = siblingFolders(pluginDir, pluginsDir);
  if (siblings.size === 0) return null;
  const filter = new RegExp(`^(?:${[...siblings.keys()].map(escapeRegExp).join("|")})(?:/.*)?$`);
  return {
    name: "gloomberb-sibling-imports",
    setup(build) {
      build.onResolve({ filter }, (args) => {
        const peer = [...siblings.keys()].find((name) => args.path === name || args.path.startsWith(`${name}/`));
        const path = peer ? siblingModule(peer, siblings.get(peer)!, args.path) : null;
        return path ? { path } : undefined;
      });
    },
  };
}
