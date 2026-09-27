import type { DesktopExternalPluginBundle } from "../shared/protocol";
import { installPluginHostModules } from "../../../plugins/host-modules";
import type { LoadedExternalPlugin } from "../../../plugins/loader";
import { pluginFromModule } from "../../../plugins/plugin-export";
import type { GloomPlugin } from "../../../types/plugin";
import { reportCrash } from "../../../telemetry/crash-reports";
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
export async function loadDesktopExternalPlugin(bundle: DesktopExternalPluginBundle): Promise<LoadedExternalPlugin> {
  await installPluginHostModules();

  const base = {
    path: bundle.path,
    directory: bundle.directory,
    ...(bundle.commit ? { commit: bundle.commit } : {}),
    ...(bundle.linked ? { linked: true } : {}),
  };
  const fallback = {
    ...base,
    plugin: {
      id: bundle.id,
      name: bundle.name,
      version: bundle.version,
      ...(bundle.targets ? { targets: bundle.targets } : {}),
    } as GloomPlugin,
  };

  if (bundle.needsRestart) return { ...fallback, needsRestart: true };
  if (bundle.unsupportedTarget) {
    return { ...fallback, unsupportedTarget: bundle.unsupportedTarget };
  }
  if (bundle.error || !bundle.code) {
    return {
      ...fallback,
      error: bundle.error ?? "Plugin produced no bundle.",
      ...(bundle.needsGloomberb ? { needsGloomberb: bundle.needsGloomberb } : {}),
    };
  }

  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(new Blob([bundle.code], { type: "text/javascript" }));
    const plugin = pluginFromModule(await import(/* @vite-ignore */ objectUrl));
    if (!plugin) {
      const error = "Bundle did not export a valid GloomPlugin.";
      reportCrash(error, { kind: "plugin", plugin: bundle.id });
      return { ...fallback, error };
    }
    log.info(`Loaded external plugin: ${plugin.id} v${plugin.version ?? "0.0.0"}`);
    return { ...base, plugin };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Evaluating ${bundle.id} failed: ${message}`);
    // A compile failure was already reported by the Bun process; this is the
    // view's own evaluation of a bundle that compiled.
    reportCrash(error, { kind: "plugin", plugin: bundle.id });
    return { ...fallback, error: message };
  } finally {
    // The module graph keeps its own reference once imported, so the URL can
    // be released immediately; leaving it would leak for the session.
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

export async function loadDesktopExternalPlugins(
  bundles: readonly DesktopExternalPluginBundle[],
): Promise<LoadedExternalPlugin[]> {
  if (bundles.length === 0) return [];

  const loaded: LoadedExternalPlugin[] = [];
  for (const bundle of bundles) loaded.push(await loadDesktopExternalPlugin(bundle));
  return loaded;
}
