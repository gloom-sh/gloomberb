import type { DesktopExternalPluginBundle } from "../shared/protocol";
import { installPluginHostModules } from "../../../plugins/host-modules";
import type { LoadedExternalPlugin } from "../../../plugins/loader";
import type { GloomPlugin } from "../../../types/plugin";
import { debugLog } from "../../../utils/debug-log";

const log = debugLog.createLogger("desktop-plugins");

/**
 * Evaluates the plugin bundles the Bun process compiled for this view.
 *
 * The host's shared modules have to be published before any bundle is imported:
 * a compiled plugin's `react` and `gloomberb/*` imports read from that registry
 * rather than carrying their own copies (see `plugins/bundle.ts`).
 *
 * Bundles are imported from blob URLs. The desktop view has no origin to fetch
 * from and no filesystem, and writing them to a served directory would mean
 * managing a cache the renderer cannot clean up reliably.
 */
export async function loadDesktopExternalPlugins(
  bundles: readonly DesktopExternalPluginBundle[],
): Promise<LoadedExternalPlugin[]> {
  if (bundles.length === 0) return [];

  await installPluginHostModules();

  const loaded: LoadedExternalPlugin[] = [];

  for (const bundle of bundles) {
    const fallback = {
      plugin: { id: bundle.id, name: bundle.name, version: bundle.version } as GloomPlugin,
      path: bundle.path,
    };

    if (bundle.error || !bundle.code) {
      loaded.push({ ...fallback, error: bundle.error ?? "Plugin produced no bundle." });
      continue;
    }

    let objectUrl: string | null = null;
    try {
      objectUrl = URL.createObjectURL(new Blob([bundle.code], { type: "text/javascript" }));
      const mod = await import(/* @vite-ignore */ objectUrl);
      const plugin: GloomPlugin = mod.default ?? mod.plugin;
      if (!plugin?.id || !plugin?.name) {
        loaded.push({ ...fallback, error: "Bundle did not export a valid GloomPlugin." });
        continue;
      }
      log.info(`Loaded external plugin: ${plugin.id} v${plugin.version ?? "0.0.0"}`);
      loaded.push({ plugin, path: bundle.path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Evaluating ${bundle.id} failed: ${message}`);
      loaded.push({ ...fallback, error: message });
    } finally {
      // The module graph keeps its own reference once imported, so the URL can
      // be released immediately; leaving it would leak for the session.
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  return loaded;
}
