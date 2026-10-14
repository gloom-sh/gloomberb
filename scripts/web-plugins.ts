import { existsSync } from "fs";
import { basename, join, relative } from "path";

import { bundleExternalPlugin } from "../src/plugins/bundle";
import { installPluginHostModules } from "../src/plugins/host-modules";
import { pluginFromModule, pluginSupportsTarget } from "../src/plugins/plugin-export";
import { WEB_BUNDLED_PLUGIN_PACKAGES } from "../src/plugins/web-bundled";
import type { GloomPlugin } from "../src/types/plugin";

/**
 * Compiles the plugins that ship inside the hosted web app.
 *
 * Each one is a devDependency installed from its own repository, so it is
 * compiled the same way the desktop compiles a plugin from disk: `gloomberb/*`
 * and `react` are rewritten to read the host's instances at runtime, and
 * everything else the plugin owns is bundled in (see `plugins/bundle.ts`).
 *
 * The compiled module is then imported here to read the plugin's own
 * declaration. That is deliberately not a second copy of the metadata in this
 * repo: the hosts the worker proxies and the targets the plugin supports are
 * whatever the plugin says they are, read from the artifact that will actually
 * be served.
 */

export interface CompiledWebPlugin {
  packageName: string;
  plugin: GloomPlugin;
  /** Emitted module, relative to the directory it was compiled into. */
  file: string;
}

function pluginPackageDir(packageName: string): string {
  const dir = join(process.cwd(), "node_modules", packageName);
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(
      `${packageName} is not installed. It is a devDependency of the web build; run "bun install".`,
    );
  }
  return dir;
}

async function readCompiledPlugin(outputPath: string, packageName: string, requireWeb = true): Promise<GloomPlugin> {
  let mod: unknown;
  try {
    mod = await import(outputPath);
  } catch (error) {
    // Module scope reached for something only a browser has. The host reads
    // every plugin's metadata in Bun (the desktop does it before compiling,
    // this build after), so a plugin has to be inert until it renders.
    throw new Error(`${packageName} could not be evaluated to read its metadata: ${error}`);
  }
  const plugin = pluginFromModule(mod);
  if (!plugin) {
    throw new Error(`${packageName} does not export a valid GloomPlugin.`);
  }
  if (requireWeb && !pluginSupportsTarget(plugin, "web")) {
    throw new Error(
      `${packageName} does not declare the "web" target, so it cannot ship in the web build. `
        + "Remove it from WEB_BUNDLED_PLUGIN_PACKAGES.",
    );
  }
  return plugin;
}

/**
 * Compiles every web-bundled plugin into `outDir`, one directory per package.
 *
 * The per-package directory keeps the entry name the plugin chose, so nothing
 * here has to guess whether it compiled `index.tsx` or something else.
 * `minify: false` keeps the components' names for the UI audit.
 */
export async function compileWebBundledPlugins(outDir: string, { minify = true }: { minify?: boolean } = {}): Promise<CompiledWebPlugin[]> {
  await installPluginHostModules();

  const compiled: CompiledWebPlugin[] = [];
  for (const packageName of WEB_BUNDLED_PLUGIN_PACKAGES) {
    compiled.push(await compileOne(pluginPackageDir(packageName), outDir, packageName, minify, true));
  }
  return compiled;
}

/**
 * Compiles plugins checked out elsewhere (the registry's, for the UI audit) the
 * same way, without holding them to the web target: the audit draws every
 * plugin's panes, and one that cannot run in a browser shows that. One that
 * does not compile is left out with a warning.
 */
export async function compileExtraWebPlugins(outDir: string, dirs: readonly string[], { minify = true }: { minify?: boolean } = {}): Promise<CompiledWebPlugin[]> {
  await installPluginHostModules();
  const compiled: CompiledWebPlugin[] = [];
  for (const dir of dirs) {
    try {
      compiled.push(await compileOne(dir, outDir, basename(dir), minify, false));
    } catch (error) {
      console.warn(`Left out ${basename(dir)}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
    }
  }
  return compiled;
}

async function compileOne(dir: string, outDir: string, packageName: string, minify: boolean, requireWeb: boolean): Promise<CompiledWebPlugin> {
  const result = await bundleExternalPlugin(dir, join(outDir, packageName), {
    minify,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return {
    packageName,
    plugin: await readCompiledPlugin(result.outputPath, packageName, requireWeb),
    file: relative(outDir, result.outputPath).replaceAll("\\", "/"),
  };
}
