import type { MarketplaceHost, PluginManager } from "./store";

export type PluginActivation =
  | { ok: true; pluginId: string; name: string; restart?: boolean }
  | { ok: false; error: string; name?: string };

/**
 * Brings a freshly installed or updated checkout into this session. What
 * cannot be activated is still recorded, with its error, so the row says
 * `failed` and the detail says why rather than the plugin simply not
 * appearing until a restart. The Plugins pane and the automatic updater both
 * come through here, so an update lands the same way whichever of them ran it.
 */
export async function activateInstalledPlugin(
  directory: string,
  host: MarketplaceHost,
  manager: PluginManager,
): Promise<PluginActivation> {
  const loaded = await manager.load(directory);
  if (!loaded) return { ok: false, error: "The plugin has no entry file." };
  const name = loaded.plugin.name;
  // Registering it here, or where data calls run, would mix the new files
  // with modules this process already imported; the host keeps what runs.
  if (loaded.needsRestart) {
    await host.activate(loaded).catch(() => {});
    return { ok: true, pluginId: loaded.plugin.id, name, restart: true };
  }
  if (loaded.error) {
    await host.activate(loaded).catch(() => {});
    return { ok: false, error: loaded.error, name };
  }
  // Where data calls execute first, so a pane that renders can also fetch.
  if (manager.activate && !loaded.unsupportedTarget) {
    const backend = await manager.activate(directory);
    if (!backend.ok) {
      await host.activate({ ...loaded, error: backend.error }).catch(() => {});
      return { ok: false, error: backend.error, name };
    }
  }
  try {
    await host.activate(loaded);
    return { ok: true, pluginId: loaded.plugin.id, name };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), name };
  }
}

/**
 * Brings a fresh install into this session, the sibling plugins it brought
 * along first: IBKR Gateway, for one, registers against Interactive Brokers.
 * A sibling that only finishes after a restart holds the plugin to the same.
 */
export async function activateInstall(
  installed: { directory: string; peers?: readonly string[] },
  host: MarketplaceHost,
  manager: PluginManager,
): Promise<PluginActivation> {
  let restart = false;
  for (const peer of installed.peers ?? []) {
    const activated = await activateInstalledPlugin(peer, host, manager);
    if (activated.ok && activated.restart) restart = true;
  }
  const activated = await activateInstalledPlugin(installed.directory, host, manager);
  return activated.ok && restart ? { ...activated, restart: true } : activated;
}

/**
 * Brings plugins the automatic updater moved into this session, exactly as
 * the pane does after an update, and says so in one toast rather than one per
 * plugin. A plugin split across files keeps running its old modules until a
 * restart, so most updates finish there.
 */
export async function activateUpdatedPlugins(
  directories: readonly string[],
  host: MarketplaceHost,
  manager: PluginManager,
): Promise<void> {
  if (directories.length === 0) return;
  let restart = false;
  const failed: string[] = [];
  for (const directory of directories) {
    const activated = await activateInstalledPlugin(directory, host, manager);
    if (!activated.ok) failed.push(activated.name ?? directory);
    else if (activated.restart) restart = true;
  }
  if (restart) host.notify({ body: "Plugins updated. Restart to finish.", type: "info" });
  else if (failed.length > 0) host.notify({ body: `Plugins updated, but ${failed.join(", ")} did not load.`, type: "error" });
  else host.notify({ body: "Plugins updated.", type: "success" });
}
