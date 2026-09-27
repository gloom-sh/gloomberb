import { existsSync, readFileSync, readdirSync, realpathSync } from "fs";
import { join, resolve } from "path";

import { compareSemver, parseSemver, requiredGloomberb } from "../utils/semver";
import { VERSION } from "../version";
import { hostPublicModules } from "./host-link";

/**
 * Whether a plugin checkout can run on this Gloomberb, decided before any of
 * its code is imported, and a precise reason when it cannot.
 *
 * The host updates itself; official plugins follow on their own schedule
 * (auto-update.ts) and the rest move only when the user updates them. A
 * checkout can therefore be older than the host (it imports something the
 * host has since removed) or newer (it needs something this host does not
 * have yet). Either way the plugin fails at import with Bun's generic
 * message, so the host names the export and says which side to update.
 * The policy for deprecating and removing host exports is in PLUGINS.md.
 */

/** Keyed by the specifier plugins import (`gloomberb/components`), then by export name. */
export type HostExportTable<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

export interface RemovedHostExport {
  /** The first Gloomberb release without it. */
  removedIn: string;
  /** What a plugin should import instead. */
  use: string;
}

export interface DeprecatedHostExport {
  deprecatedIn: string;
  use: string;
}

/**
 * Runtime exports that were removed from the public API. A stale checkout that
 * still imports one gets "uses X, removed in Z; update the plugin" instead of
 * a generic import failure, and `plugin doctor` flags it before publishing.
 */
export const REMOVED_HOST_EXPORTS: HostExportTable<RemovedHostExport> = {};

/** Still exported and working; `plugin doctor` warns so authors migrate before removal. */
export const DEPRECATED_HOST_EXPORTS: HostExportTable<DeprecatedHostExport> = {};

export interface KnownBrokenPlugin {
  /**
   * Checkouts that declare a minimum Gloomberb below this (or none at all) are
   * refused. Official plugins bump `minGloom` with every release that needs
   * the host, so it tells an old checkout from a fixed one where their
   * `version` often does not.
   */
  declaredMinGloomBelow: string;
  /** Shown as the load error; say what to do. */
  reason: string;
}

/**
 * Plugin versions that load cleanly but misbehave on this host, keyed by the
 * id in their gloom.json. For behavior a host change broke without an import
 * error, such as a field the plugin reads that is no longer set.
 */
export const KNOWN_BROKEN_PLUGINS: Readonly<Record<string, KnownBrokenPlugin>> = {};

export interface PluginManifest {
  /** From gloom.json; the registry's id. */
  id: string | null;
  /** The oldest Gloomberb the checkout says it runs on. */
  minGloomberb: string | null;
}

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function versionField(value: unknown): string | null {
  return typeof value === "string" && parseSemver(value) ? value.trim() : null;
}

/** `>=0.15.0` gives `0.15.0`; any other range says nothing this check can use. */
function peerRangeMinimum(range: unknown): string | null {
  if (typeof range !== "string") return null;
  const match = /^\s*>=\s*(v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\s*$/.exec(range);
  return match ? match[1]! : null;
}

/**
 * What a checkout declares about itself: gloom.json `minGloom` (or
 * `minGloomberb`), else a `>=x.y.z` peer range on `gloomberb` in
 * package.json. Values that do not parse are ignored.
 */
export function readPluginManifest(pluginDir: string): PluginManifest {
  const gloom = readJson(join(pluginDir, "gloom.json"));
  const pkg = readJson(join(pluginDir, "package.json"));
  const peers = pkg?.peerDependencies as Record<string, unknown> | undefined;
  return {
    id: typeof gloom?.id === "string" && gloom.id ? gloom.id : null,
    minGloomberb: versionField(gloom?.minGloom)
      ?? versionField(gloom?.minGloomberb)
      ?? peerRangeMinimum(peers?.gloomberb),
  };
}

export interface PluginIncompatibility {
  error: string;
  /** Set when the checkout declares a newer Gloomberb than this one. */
  needsGloomberb?: string;
}

/**
 * Why this host will not import the plugin in `pluginDir`, or null when it
 * may. Reads only gloom.json and package.json, so nothing the plugin ships
 * runs before the answer is known.
 */
export function checkPluginCompatibility(pluginDir: string, hostVersion: string = VERSION): PluginIncompatibility | null {
  const manifest = readPluginManifest(pluginDir);
  const needs = requiredGloomberb(manifest.minGloomberb, hostVersion);
  if (needs) return { error: `Needs Gloomberb ${needs}, this is ${hostVersion}.`, needsGloomberb: needs };
  const broken = manifest.id ? KNOWN_BROKEN_PLUGINS[manifest.id] : undefined;
  if (broken && (compareSemver(manifest.minGloomberb, broken.declaredMinGloomBelow) ?? -1) < 0) {
    return { error: broken.reason };
  }
  return null;
}

export interface MissingHostExport {
  /** The public specifier, such as `gloomberb/components`. */
  specifier: string;
  name: string;
}

// Bun's wording, pinned by tests: the first from a native import (the module
// is a file path, or the specifier when the packaged host serves it), the
// second from the bundler the desktop and web builds use.
const NATIVE_MISSING_EXPORT = /Export named '([^']+)' not found in module '([^']+)'/;
const BUNDLED_MISSING_EXPORT = /No matching export in "([^"]+)" for import "([^"]+)"/;

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The public specifier a module in an error names, or null when it is not one of the host's. */
function hostSpecifierFor(module: string): string | null {
  const bare = module.replace(/^gloom-host:/, "");
  if (/^gloomberb(?:\/|$)/.test(bare)) return bare;
  // Bun reports the module's real path; the bundler reports it relative to
  // the working directory.
  const path = realPath(resolve(bare));
  for (const [specifier, file] of hostPublicModules()) {
    if (realPath(file) === path) return specifier;
  }
  return null;
}

/** The host export an import error is about, or null for any other failure. */
export function findMissingHostExport(message: string): MissingHostExport | null {
  const native = NATIVE_MISSING_EXPORT.exec(message);
  const bundled = native ? null : BUNDLED_MISSING_EXPORT.exec(message);
  const name = native?.[1] ?? bundled?.[2];
  const module = native?.[2] ?? bundled?.[1];
  if (!name || !module) return null;
  const specifier = hostSpecifierFor(module);
  return specifier ? { specifier, name } : null;
}

/**
 * The load error to show for `message`: which host export is missing and what
 * to update when that is the failure, the message unchanged otherwise.
 */
export function explainPluginLoadError(message: string, hostVersion: string = VERSION): string {
  const missing = findMissingHostExport(message);
  if (!missing) return message;
  const { specifier, name } = missing;
  const removed = REMOVED_HOST_EXPORTS[specifier]?.[name];
  if (removed) return `Uses ${name} from ${specifier}, removed in Gloomberb ${removed.removedIn}. Update the plugin.`;
  return `Uses ${name} from ${specifier}, which Gloomberb ${hostVersion} does not have. Update the plugin, or Gloomberb if the plugin is newer.`;
}

/** The plugin's own source files, without tests, dependencies or build output. */
export function pluginSourceFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pluginSourceFiles(full, out, depth + 1);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const HOST_IMPORT = /\b(?:import|export)\s+(type\s+)?\{([^}]*)\}\s*from\s*["'](gloomberb(?:\/[^"']*)?)["']/g;

/** Value names a source file imports or re-exports from `gloomberb/*`; type-only imports are dropped at load and cannot break it. */
export function findHostImports(source: string): MissingHostExport[] {
  const imports: MissingHostExport[] = [];
  for (const match of source.matchAll(HOST_IMPORT)) {
    if (match[1]) continue;
    for (const part of match[2]!.split(",")) {
      const binding = part.trim();
      if (!binding || /^type\s/.test(binding)) continue;
      const name = binding.split(/\s+as\s+/)[0]!.trim();
      if (name) imports.push({ specifier: match[3]!, name });
    }
  }
  return imports;
}
