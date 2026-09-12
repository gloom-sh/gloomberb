import { existsSync } from "fs";
import { join, relative } from "path";

import { bundleExternalPlugin } from "../src/plugins/bundle";
import { installPluginHostModules } from "../src/plugins/host-modules";
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

async function readCompiledPlugin(outputPath: string, packageName: string): Promise<GloomPlugin> {
  let mod: { default?: GloomPlugin; plugin?: GloomPlugin };
  try {
    mod = await import(outputPath);
  } catch (error) {
    // Module scope reached for something only a browser has. The host reads
    // every plugin's metadata in Bun (the desktop does it before compiling,
    // this build after), so a plugin has to be inert until it renders.
    throw new Error(`${packageName} could not be evaluated to read its metadata: ${error}`);
  }
  const plugin = mod.default ?? mod.plugin;
  if (!plugin?.id || !plugin?.name) {
    throw new Error(`${packageName} does not export a valid GloomPlugin.`);
  }
  if (plugin.targets && !plugin.targets.includes("web")) {
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
 */
export async function compileWebBundledPlugins(outDir: string): Promise<CompiledWebPlugin[]> {
  await installPluginHostModules();

  const compiled: CompiledWebPlugin[] = [];
  for (const packageName of WEB_BUNDLED_PLUGIN_PACKAGES) {
    const result = await bundleExternalPlugin(pluginPackageDir(packageName), join(outDir, packageName), {
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
    });
    compiled.push({
      packageName,
      plugin: await readCompiledPlugin(result.outputPath, packageName),
      file: relative(outDir, result.outputPath).replaceAll("\\", "/"),
    });
  }
  return compiled;
}
