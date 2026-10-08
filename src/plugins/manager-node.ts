import { join } from "path";
import type { PluginManager, PluginOperationResult } from "./builtin/plugin-marketplace/store";
import { getPluginsDir, loadExternalPlugin } from "./loader";
import type { PluginTarget } from "../types/plugin";

/**
 * The plugin manager for a process that can run git and bun: the terminal,
 * and the desktop's Bun side on behalf of its view. Wraps the installer so
 * the marketplace and `gloomberb install` do exactly the same thing, and
 * turns its failures into results the pane can show next to the row.
 */

/** A manager that can run git, so it always answers `remoteHeads`. */
export type NodePluginManager = PluginManager & Required<Pick<PluginManager, "remoteHeads">>;

export interface NodePluginManagerHooks {
  /** A plugin folder was installed, updated or removed. Receives its path. */
  onChanged?(pluginDir: string): void;
}

// Loaded on first use: nothing on the startup path installs anything.
const installer = () => import("./installer");

export function createNodePluginManager(target: PluginTarget, hooks: NodePluginManagerHooks = {}): NodePluginManager {
  async function attempt(
    run: () => Promise<{ directory: string; kept?: string; changed?: boolean; peers?: string[] }>,
  ): Promise<PluginOperationResult> {
    try {
      const { directory, kept, changed, peers } = await run();
      for (const changedDirectory of [...(peers ?? []), directory]) hooks.onChanged?.(join(getPluginsDir(), changedDirectory));
      return {
        ok: true,
        directory,
        ...(kept ? { kept } : {}),
        ...(changed !== undefined ? { changed } : {}),
        ...(peers?.length ? { peers } : {}),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    // Through the registry, like `gloomberb install`: a plugin that builds on
    // another brings it along instead of failing to load without it.
    install: (repo, pin) => attempt(async () => (await installer()).installListedPlugin(repo, { quiet: true, ...(pin ? { pin } : {}) })),
    update: (directory, pin) => attempt(async () => (await installer()).updatePlugin(directory, { quiet: true, pin })),
    remove: (directory) => attempt(async () => {
      await (await installer()).removePlugin(directory, { quiet: true });
      return { directory };
    }),
    load: (directory) => loadExternalPlugin(join(getPluginsDir(), directory), target, { fresh: true }),
    remoteHeads: async (directories) => (await installer()).readPluginRemoteHeads(directories),
  };
}
