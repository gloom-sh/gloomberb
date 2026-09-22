import type { LoadedExternalPlugin } from "../../loader";
import type { InstalledPlugin } from "./model";

/**
 * The marketplace pane needs two things no other pane does: the full plugin
 * catalog including entries that failed to load, and the ability to enable and
 * disable them. Neither is on the render-time plugin runtime, and widening the
 * public plugin API for a single built-in consumer would be the wrong trade.
 *
 * So the app binds a host here at startup, the same way the layout manager
 * receives its dispatch from `bindAppPanePluginRegistry`.
 */

export interface MarketplaceHost {
  listInstalled(): InstalledPlugin[];
  setPluginEnabled(pluginId: string, enabled: boolean): void;
  /**
   * Registers a plugin that was loaded after startup, so its panes and
   * commands exist in this session. Replaces a previous registration of the
   * same id (an update). Rejects with the setup error when the plugin cannot
   * be registered, in which case the entry is kept with that error attached.
   */
  activate(entry: LoadedExternalPlugin): Promise<void>;
  /**
   * Hides the plugin's panes and unregisters it, ahead of removing its files.
   * The folder identifies an install that never produced an id.
   */
  deactivate(pluginId: string, directory?: string): Promise<void>;
  /** What a registered plugin actually added, for "open what it added" and the detail view. */
  contributions(pluginId: string): PluginContributions;
}

export interface PluginContributions {
  panes: Array<{ id: string; name: string }>;
  templates: Array<{ id: string; label: string; prefix?: string }>;
  commands: Array<{ id: string; label: string }>;
  capabilities: number;
  broker: boolean;
}

let host: MarketplaceHost | null = null;

export function setMarketplaceHost(next: MarketplaceHost | null): void {
  host = next;
}

export function getMarketplaceHost(): MarketplaceHost | null {
  return host;
}

export interface PluginPin {
  ref?: string;
  commit?: string;
}

export type PluginOperationResult =
  | { ok: true; directory: string }
  | { ok: false; error: string };

/**
 * Installing a plugin means running git and bun, which only the Bun-hosted
 * renderers can do — and the desktop view has to ask its Bun process over RPC.
 * Rather than let this pane reach for a renderer API and break the
 * renderer-neutrality rule, each renderer installs its own implementation at
 * startup. A renderer that leaves it unset (the browser) gets the install
 * command shown instead of a button.
 */
export interface PluginManager {
  install(repo: string, pin?: PluginPin): Promise<PluginOperationResult>;
  update(directory: string, pin?: PluginPin): Promise<PluginOperationResult>;
  remove(directory: string): Promise<PluginOperationResult>;
  /**
   * Loads the plugin in `directory` into this renderer, fresh, so it can be
   * activated without a restart. Null when the directory has no plugin entry.
   */
  load(directory: string): Promise<LoadedExternalPlugin | null>;
  /**
   * Where each folder's remote default branch is now, keyed by folder. This is
   * how a plugin the registry does not list can report an update: there is no
   * reviewed commit to compare against, and `update` follows that branch.
   * Absent for a host that cannot run git, and silent about folders it could
   * not reach.
   */
  remoteHeads?(directories: readonly string[]): Promise<Record<string, string>>;
  /**
   * Registers the plugin wherever its capabilities and brokers execute when
   * that is not this renderer. The desktop view renders panes, but forwards
   * data calls to its Bun process, which keeps its own registry; without this
   * an installed plugin would draw its pane and fail on the first request.
   * The terminal is one process and leaves it out.
   */
  activate?(directory: string): Promise<{ ok: true } | { ok: false; error: string }>;
  deactivate?(pluginId: string): Promise<void>;
}

let manager: PluginManager | null = null;

export function setPluginManager(next: PluginManager | null): void {
  manager = next;
}

export function getPluginManager(): PluginManager | null {
  return manager;
}
