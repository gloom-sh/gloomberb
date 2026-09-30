import { installPluginHostModules } from "../../plugins/host-modules";
import type { LoadedExternalPlugin } from "../../plugins/loader";
import { pluginFromModule } from "../../plugins/plugin-export";
import type { WebBundledPluginDescriptor } from "../../plugins/web-bundled";
import type { GloomPlugin } from "../../types/plugin";
import { reportCrash } from "../../telemetry/crash-reports";
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

/**
 * What each browser says when the module file itself could not be fetched,
 * as opposed to a module that loaded and threw.
 */
const MODULE_FETCH_FAILURE = /dynamically imported module|importing a module script failed/i;
const RETRY_DELAY_MS = 1_000;

type ModuleImporter = (url: string) => Promise<unknown>;

const importModule: ModuleImporter = (url) => import(/* @vite-ignore */ url);

/**
 * A plugin fetch can fail for a moment, during a deploy or on a flaky
 * network, and the web terminal then ran the whole session without that
 * plugin (about 30 visitors on one deploy day). Browsers remember a failed
 * module URL, so the one retry asks for a fresh copy under a new query.
 */
async function importWithRetry(url: string, load: ModuleImporter, delayMs: number): Promise<unknown> {
  try {
    return await load(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!MODULE_FETCH_FAILURE.test(message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return load(`${url}${url.includes("?") ? "&" : "?"}retry=${Date.now()}`);
  }
}

export async function loadWebBundledPlugins(
  descriptors: readonly WebBundledPluginDescriptor[] = bundledDescriptors(),
  load: ModuleImporter = importModule,
  retryDelayMs = RETRY_DELAY_MS,
): Promise<LoadedExternalPlugin[]> {
  if (descriptors.length === 0) return [];

  await installPluginHostModules();

  const loaded = await Promise.all(descriptors.map(async (descriptor): Promise<LoadedExternalPlugin> => {
    const fallback = {
      plugin: { id: descriptor.id, name: descriptor.name, version: descriptor.version } as GloomPlugin,
      path: descriptor.url,
    };
    try {
      const plugin = pluginFromModule(await importWithRetry(descriptor.url, load, retryDelayMs));
      if (!plugin) {
        const error = "Bundle did not export a valid GloomPlugin.";
        reportCrash(error, { kind: "plugin", plugin: descriptor.id });
        return { ...fallback, error };
      }
      log.info(`Loaded bundled plugin: ${plugin.id} v${plugin.version ?? "0.0.0"}`);
      return { plugin, path: descriptor.url };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Loading ${descriptor.id} failed: ${message}`);
      reportCrash(error, { kind: "plugin", plugin: descriptor.id });
      return { ...fallback, error: message };
    }
  }));

  return loaded;
}
