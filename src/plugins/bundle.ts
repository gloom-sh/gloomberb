import { mkdir } from "fs/promises";
import { join } from "path";

import { resolvePluginBrowserEntry } from "./loader";
import { PLUGIN_HOST_GLOBAL, SHARED_SPECIFIERS } from "./host-contract";

/**
 * Compiles an external plugin for a renderer that cannot read the filesystem.
 *
 * The terminal renderer runs in Bun and can `import()` a plugin directly from
 * `~/.gloomberb/plugins`. The desktop view and the hosted browser app cannot:
 * they are browser contexts running a sealed bundle, so plugin source has to be
 * compiled to an ES module they can fetch.
 *
 * The hard part is not compiling, it is *sharing*. A plugin bundle that carries
 * its own React would give the process a second React instance and throw on the
 * first hook, and it has no way to reach the host's `gloomberb/*` modules at
 * all. So those specifiers are not bundled — they are rewritten to read from a
 * registry the host publishes on `globalThis` before it loads any plugin. One
 * instance of every shared module, exactly as on the terminal side where the
 * host is symlinked in.
 */



/**
 * Source for a module that re-exports one shared specifier from the host
 * registry. Named exports have to be listed statically — `export *` cannot
 * forward from a runtime object — so the caller passes the names it found by
 * importing the real module.
 */
export function buildSharedModuleSource(specifier: string, exportNames: readonly string[]): string {
  const lines = [
    `const mod = globalThis[${JSON.stringify(PLUGIN_HOST_GLOBAL)}]?.[${JSON.stringify(specifier)}];`,
    `if (!mod) throw new Error(${JSON.stringify(`Gloomberb host module "${specifier}" is unavailable. The plugin host was not installed before this plugin loaded.`)});`,
    "export default mod;",
  ];
  for (const name of exportNames) {
    if (name === "default") continue;
    // Not `export const`: a getter keeps live bindings working and avoids
    // capturing a value the host may replace on a theme or locale change.
    lines.push(`export const ${name} = mod[${JSON.stringify(name)}];`);
  }
  return lines.join("\n");
}

export interface BundlePluginResult {
  /** Absolute path of the emitted ES module. */
  outputPath: string;
  /** Shared specifiers this plugin actually imported. */
  shared: string[];
  warnings: string[];
}

/**
 * Bun plugin that redirects the shared specifiers to generated modules.
 *
 * `exportNamesFor` is injected so this stays testable and so the caller decides
 * how names are discovered — the bundler runs in Bun and can simply import the
 * real module, but a test should not have to.
 */
export function createSharedModuleResolver(
  exportNamesFor: (specifier: string) => Promise<readonly string[]>,
  onShared?: (specifier: string) => void,
): import("bun").BunPlugin {
  const namespace = "gloom-host";
  const shared = new Set<string>(SHARED_SPECIFIERS);

  return {
    name: "gloomberb-host-modules",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!shared.has(args.path)) return undefined;
        onShared?.(args.path);
        return { path: args.path, namespace };
      });

      build.onLoad({ filter: /.*/, namespace }, async (args) => ({
        contents: buildSharedModuleSource(args.path, await exportNamesFor(args.path)),
        loader: "js",
      }));
    },
  };
}

async function hostExportNames(specifier: string): Promise<readonly string[]> {
  const mod = await import(specifier);
  return Object.keys(mod).sort();
}

/**
 * Bundles one plugin directory to `outDir`, returning the emitted module path.
 * Throws on a compile error so the caller can surface it against the plugin
 * rather than failing the whole renderer.
 */
export async function bundleExternalPlugin(
  pluginDir: string,
  outDir: string,
  options: { exportNamesFor?: (specifier: string) => Promise<readonly string[]> } = {},
): Promise<BundlePluginResult> {
  // The browser entry when the plugin ships one, so a plugin with a native
  // half can still present its UI and metadata in the view.
  const entry = await resolvePluginBrowserEntry(pluginDir);
  if (!entry) throw new Error(`No plugin entry file in ${pluginDir}`);

  await mkdir(outDir, { recursive: true });

  const shared = new Set<string>();
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: outDir,
    target: "browser",
    format: "esm",
    splitting: false,
    minify: false,
    sourcemap: "none",
    plugins: [
      createSharedModuleResolver(
        options.exportNamesFor ?? hostExportNames,
        (specifier) => shared.add(specifier),
      ),
    ],
  });

  if (!result.success) {
    throw new Error(result.logs.map((log) => log.message).join("\n"));
  }

  const output = result.outputs.find((entryOutput) => entryOutput.kind === "entry-point");
  if (!output) throw new Error(`Bundling ${pluginDir} produced no entry point`);

  return {
    outputPath: output.path,
    shared: [...shared].sort(),
    warnings: result.logs.filter((log) => log.level === "warning").map((log) => log.message),
  };
}

export function pluginBundleCacheDir(baseDir: string): string {
  return join(baseDir, "bundles");
}
