import { installPluginHostModules } from "../../plugins/host-modules";
import type { LoadedExternalPlugin } from "../../plugins/loader";
import type { WebBundledPluginDescriptor } from "../../plugins/web-bundled";
import type { GloomPlugin } from "../../types/plugin";
import { debugLog } from "../../utils/debug-log";

const log = debugLog.createLogger("web-plugins");

/**
 * Loads the plugins compiled into this build (`scripts/web-plugins.ts`).
 *
 * They are served from this origin as separate ES modules rather than inlined
 * into the app bundle, so the browser caches and revalidates them on their own
 * and a plugin release does not invalidate the whole app. The host's shared
 * modules have to be published first: a compiled plugin's `react` and
 * `gloomberb/*` imports read from that registry instead of carrying their own
 * copies, which would throw on the plugin's first hook.
 *
 * A plugin that fails to load is reported rather than thrown: the app runs on
 * its built-in catalog, and the marketplace shows the error against the plugin.
 */
declare const __GLOOM_WEB_PLUGINS__: readonly WebBundledPluginDescriptor[] | undefined;

function bundledDescriptors(): readonly WebBundledPluginDescriptor[] {
  // Injected at build time, so it is absent in a test run or any other build.
  return typeof __GLOOM_WEB_PLUGINS__ === "undefined" ? [] : __GLOOM_WEB_PLUGINS__;
}

export async function loadWebBundledPlugins(
  descriptors: readonly WebBundledPluginDescriptor[] = bundledDescriptors(),
): Promise<LoadedExternalPlugin[]> {
  if (descriptors.length === 0) return [];

  await installPluginHostModules();

  const loaded = await Promise.all(descriptors.map(async (descriptor): Promise<LoadedExternalPlugin> => {
    const fallback = {
      plugin: { id: descriptor.id, name: descriptor.name, version: descriptor.version } as GloomPlugin,
      path: descriptor.url,
    };
    try {
      const mod = await import(/* @vite-ignore */ descriptor.url) as {
        default?: GloomPlugin;
        plugin?: GloomPlugin;
      };
      const plugin = mod.default ?? mod.plugin;
      if (!plugin?.id || !plugin?.name) {
        return { ...fallback, error: "Bundle did not export a valid GloomPlugin." };
      }
      log.info(`Loaded bundled plugin: ${plugin.id} v${plugin.version ?? "0.0.0"}`);
      return { plugin, path: descriptor.url };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Loading ${descriptor.id} failed: ${message}`);
      return { ...fallback, error: message };
    }
  }));

  return loaded;
}
