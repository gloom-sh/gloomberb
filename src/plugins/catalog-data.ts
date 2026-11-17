import type { GloomPlugin } from "../types/plugin";
import type { LoadedExternalPlugin } from "./loader";
import { gloomberbCloudPlugin } from "./builtin/cloud";

/**
 * The built-in plugins that contribute an `asset-data` or `news` capability, which is all a command that reads
 * market data needs from the plugins it runs with. Naming them here keeps such a command from loading every
 * other plugin's panes; `catalog-data.test.ts` fails when a plugin outside this list declares one.
 */
export const builtinDataPlugins: GloomPlugin[] = [gloomberbCloudPlugin];

/** `builtinDataPlugins` and the installed plugins that loaded, which may carry data capabilities of their own. */
export function getLoadableDataPlugins(externalPlugins: LoadedExternalPlugin[] = []): GloomPlugin[] {
  return [
    ...builtinDataPlugins,
    ...externalPlugins
      .filter((entry) => !entry.needsRestart && !entry.error && !entry.unsupportedTarget)
      .map((entry) => entry.plugin),
  ];
}
