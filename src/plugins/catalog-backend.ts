import type { GloomPlugin } from "../types/plugin";
import { withoutRendererOnlyModules } from "./builtin/plugin-module";
import { getLoadablePlugins } from "./catalog";
import { loadExternalPlugins, type LoadedExternalPlugin } from "./loader";

/**
 * Every loadable plugin, in the same order and under the same ids as the
 * renderer's, so toggles and state line up; built-ins leave out the modules
 * they mark renderer-only.
 */
export function getDesktopBackendPlugins(
  externalPlugins: LoadedExternalPlugin[] = [],
): GloomPlugin[] {
  return getLoadablePlugins(externalPlugins).map(withoutRendererOnlyModules);
}

export interface DesktopBackendPlugins {
  plugins: GloomPlugin[];
  /**
   * The external entries behind `plugins`, handed to the runtime so a plugin
   * that fails to register is marked failed rather than failing the launch.
   */
  externalPlugins: LoadedExternalPlugin[];
}

export async function loadDesktopBackendPlugins(): Promise<DesktopBackendPlugins> {
  const externalPlugins = await loadExternalPlugins("desktop");
  return { plugins: getDesktopBackendPlugins(externalPlugins), externalPlugins };
}
