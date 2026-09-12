import { PLUGIN_HOST_GLOBAL, SHARED_SPECIFIERS } from "./host-contract";
import { importAllPluginHostModules } from "./host-module-imports";

/**
 * Publishes the host's shared modules for compiled plugin bundles to read.
 *
 * Browser-context renderers load plugins as separate ES modules, so the bundler
 * rewrites their `react` and `gloomberb/*` imports to read from this registry
 * (see `bundle.ts`). This must run before any plugin bundle is imported, and
 * the modules here must be the same instances the app itself uses — importing
 * them normally is what guarantees that.
 */
export async function installPluginHostModules(): Promise<void> {
  const globals = globalThis as Record<string, unknown>;
  if (globals[PLUGIN_HOST_GLOBAL]) return;

  const registry = await importAllPluginHostModules();

  for (const specifier of SHARED_SPECIFIERS) {
    if (!registry[specifier]) throw new Error(`Plugin host registry is missing "${specifier}"`);
  }

  globals[PLUGIN_HOST_GLOBAL] = registry;
}
