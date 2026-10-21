import { readdirSync, readFileSync, type Dirent } from "fs";
import { dirname, extname, isAbsolute, join, relative } from "path";

/**
 * A second import of a plugin whose first one failed on a sibling plugin it
 * imports (IBKR Gateway imports Interactive Brokers), that really looks again.
 *
 * Bun keeps both halves of that failure for the rest of the process. Its
 * resolver remembers each folder it read, so `node_modules` stays without the
 * sibling after the link is made. And the module that failed stays failed
 * under its path, so importing the entry again, even under a fresh query,
 * reaches the same error through the entry's own `./plugin` import. Until
 * now only a restart cleared it, which is why the gateway failed on a launch
 * and worked on the next one.
 *
 * The retry undoes both. It makes Bun read the plugin's folders again (a
 * lookup that misses in a folder Bun had read drops that folder from its
 * cache), and it imports every file of the plugin under a new module key, so
 * nothing from the failed attempt is reused. Imports that leave the plugin,
 * the sibling's files included, resolve to the same modules as always, so the
 * plugin shares the sibling's state as on a normal load.
 */

/** The query that gives a plugin's files their new module keys. */
const RETRY_PARAM = "gloom-plugin-retry";
const RETRY_QUERY = new RegExp(`[?&]${RETRY_PARAM}=(\\d+)(?:&|$)`);
const SOURCE_LOADERS: Readonly<Record<string, "ts" | "tsx" | "js" | "jsx">> = {
  ".ts": "ts",
  ".mts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".jsx": "jsx",
};
/** A file name that is never there: looking it up is what clears a folder. */
const MISSING_FILE = "./.gloom-resolver-refresh";
const SKIPPED_FOLDERS = new Set(["node_modules", ".git", "dist"]);

/**
 * `text` without the retry query Bun puts in the paths of a retried import's
 * errors, so the retry's error reads like the first import's.
 */
export function withoutRetryQuery(text: string): string {
  return text.replace(new RegExp(`[?&]${RETRY_PARAM}=\\d+`, "g"), "");
}

/** The plugin folder each retry imports from, by retry number. */
const retryRoots = new Map<number, string>();
let retries = 0;
let installed = false;

function isInside(root: string, path: string): boolean {
  const inside = relative(root, path);
  return !!inside && !inside.startsWith("..") && !isAbsolute(inside);
}

/** The plugin's own folders, without dependencies or build output. */
function sourceFolders(dir: string, out: string[] = [], depth = 0): string[] {
  out.push(dir);
  if (depth > 8) return out;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // Intentional ignore: a folder that cannot be listed has nothing Bun could have cached.
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !SKIPPED_FOLDERS.has(entry.name)) sourceFolders(join(dir, entry.name), out, depth + 1);
  }
  return out;
}

/**
 * Makes Bun read the plugin's folders and its links to `peers` from disk
 * again. Bun drops a folder from its resolver cache when a lookup in it
 * misses, so this looks up a file that is not there in each one. The
 * bundler shares the cache, which is why the desktop's compile of the same
 * plugin failed in the same session too.
 */
export function refreshResolverFolders(pluginDir: string, peers: readonly string[]): void {
  const modules = join(pluginDir, "node_modules");
  const folders = [...sourceFolders(pluginDir), modules];
  for (const peer of peers) {
    if (peer.startsWith("@")) folders.push(join(modules, peer.split("/")[0]!));
    folders.push(join(modules, peer));
  }
  for (const folder of folders) {
    try {
      Bun.resolveSync(MISSING_FILE, folder);
    } catch {
      // Intentional ignore: the miss is what drops the folder from the cache.
    }
  }
}

/**
 * The plugin's file at `path` (with the retry query), its relative imports
 * of other source files in the plugin given the same query, so they load
 * under new keys as well. Imports that leave the plugin keep their keys.
 */
function rekeyedSource(path: string): { contents: string; loader: "ts" | "tsx" | "js" | "jsx" } {
  const match = RETRY_QUERY.exec(path);
  const file = match ? path.slice(0, match.index) : path;
  const loader = SOURCE_LOADERS[extname(file).toLowerCase()] ?? "js";
  let contents = readFileSync(file, "utf8");
  const root = match ? retryRoots.get(Number(match[1])) : undefined;
  if (!match || !root) return { contents, loader };
  const retry = Number(match[1]);
  const specifiers = new Set(
    new Bun.Transpiler({ loader }).scanImports(contents)
      .map((entry) => entry.path)
      .filter((specifier) => (specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.includes("?")),
  );
  for (const specifier of specifiers) {
    let target: string;
    try {
      target = Bun.resolveSync(specifier, dirname(file));
    } catch {
      // Intentional ignore: left as written, the import fails the way it would have.
      continue;
    }
    if (!isInside(root, target) || !SOURCE_LOADERS[extname(target).toLowerCase()]) continue;
    const rekeyed = `${specifier}?${RETRY_PARAM}=${retry}`;
    for (const quote of ["\"", "'", "`"]) {
      contents = contents.split(`${quote}${specifier}${quote}`).join(`${quote}${rekeyed}${quote}`);
    }
  }
  return { contents, loader };
}

function installRekeyingLoader(): boolean {
  if (installed) return true;
  if (typeof Bun === "undefined" || typeof Bun.plugin !== "function") return false;
  Bun.plugin({
    name: "gloomberb-plugin-retry",
    setup(build) {
      build.onLoad({ filter: RETRY_QUERY }, (args) => rekeyedSource(args.path));
    },
  });
  installed = true;
  return true;
}

/**
 * The specifier that imports `entryFile` and the rest of its plugin under
 * new module keys, or null when this process cannot register the loader that
 * does it. The same specifier imports the same modules again.
 */
export function rekeyedEntry(entryFile: string, pluginDir: string): string | null {
  if (!installRekeyingLoader()) return null;
  retries += 1;
  retryRoots.set(retries, pluginDir);
  return `${entryFile}?${RETRY_PARAM}=${retries}`;
}
