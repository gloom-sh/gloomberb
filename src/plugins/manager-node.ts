import { join } from "path";
import type { PluginManager, PluginOperationResult } from "./builtin/plugin-marketplace/store";
import { getPluginsDir, loadExternalPlugin, type LoadedExternalPlugin } from "./loader";
import type { PluginTarget } from "../types/plugin";

/**
 * The plugin manager for a process that can run git and bun: the terminal,
 * and the desktop's Bun side on behalf of its view. Wraps the CLI commands so
 * the marketplace and `gloomberb install` do exactly the same thing, and
 * turns their failures into results the pane can show next to the row.
 */

async function attempt(run: () => Promise<{ directory: string }>): Promise<PluginOperationResult> {
  try {
    const { directory } = await run();
    return { ok: true, directory };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function createNodePluginManager(target: PluginTarget): PluginManager {
  return {
    install: (repo, pin) => attempt(async () => {
      const { installPlugin } = await import("../cli/commands/plugins");
      return installPlugin(repo, { quiet: true, pin });
    }),
    update: (directory, pin) => attempt(async () => {
      const { updatePlugin } = await import("../cli/commands/plugins");
      return updatePlugin(directory, { quiet: true, pin });
    }),
    remove: (directory) => attempt(async () => {
      const { removePlugin } = await import("../cli/commands/plugins");
      await removePlugin(directory, { quiet: true });
      return { directory };
    }),
    load: (directory): Promise<LoadedExternalPlugin | null> => (
      loadExternalPlugin(join(getPluginsDir(), directory), target, { fresh: true })
    ),
    remoteHeads: async (directories) => {
      const { readPluginRemoteHeads } = await import("../cli/commands/plugins");
      return readPluginRemoteHeads(directories);
    },
  };
}
