import { ConnectionHealthRegistry } from "../../core/connection-health";
import type {
  GloomPlugin,
  GloomPluginContext,
  PaneDef,
  PaneTemplateDef,
  PluginPersistence,
} from "../../types/plugin";
import type { PersistedResourceValue } from "../../types/persistence";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";

export async function createPaneCatalog(context: MarketContext, plugins: GloomPlugin[]): Promise<PaneFunctionCatalog> {
  const panes = new Map<string, PaneDef>();
  const paneTemplates = new Map<string, PaneTemplateDef>();
  const setupPlugins: GloomPlugin[] = [];
  const fakePersistence = createDiscoveryPluginPersistence();
  // Collect setup-registered panes without booting the real plugin runtime or polling engines.
  // Keep this object exhaustively typed so additions to GloomPluginContext fail at
  // compile time instead of crashing `gloomberb catalog` at runtime.
  const discoveryContext: GloomPluginContext = {
    registerPane: (pane: PaneDef) => panes.set(pane.id, pane),
    registerPaneTemplate: (template: PaneTemplateDef) => paneTemplates.set(template.id, template),
    registerCommand: () => {},
    registerColumn: () => {},
    registerBroker: () => {},
    registerCapability: () => {},
    registerTickerResearchTab: () => {},
    registerShortcut: () => {},
    registerTickerAction: () => {},
    registerContextMenuProvider: () => {},
    registerSyncContributor: () => () => {},
    registerSyncTransport: () => () => {},
    watchNewsQuery: () => () => {},
    getData: () => null,
    getTicker: () => null,
    getConfig: () => context.config,
    getPaneDef: (paneId: string) => panes.get(paneId),
    marketData: context.dataProvider,
    connectionHealth: new ConnectionHealthRegistry(),
    tickerRepository: context.store,
    persistence: fakePersistence,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    resume: {
      getState: () => null,
      setState: () => {},
      deleteState: () => {},
      getPaneState: () => null,
      setPaneState: () => {},
      deletePaneState: () => {},
    },
    configState: {
      get: () => null,
      set: async () => {},
      delete: async () => {},
      keys: () => [],
    },
    paneSettings: {
      get: () => null,
      set: async () => {},
      delete: async () => {},
    },
    createBrokerInstance: async () => {
      throw new Error("Broker creation is unavailable during CLI pane discovery.");
    },
    updateBrokerInstance: async () => {},
    syncBrokerInstance: async () => {},
    removeBrokerInstance: async () => {},
    selectTicker: () => {},
    switchPanel: () => {},
    switchTab: () => {},
    openCommandBar: () => {},
    showPane: () => {},
    createPaneFromTemplate: () => {},
    hidePane: () => {},
    focusPane: () => {},
    pinTicker: () => {},
    navigateTicker: () => {},
    openPaneSettings: () => {},
    on: () => () => {},
    emit: () => {},
    notify: () => {},
  };

  for (const plugin of plugins) {
    for (const pane of plugin.panes ?? []) panes.set(pane.id, pane);
    for (const template of plugin.paneTemplates ?? []) paneTemplates.set(template.id, template);
    if (plugin.setup) {
      setupPlugins.push(plugin);
      await plugin.setup(discoveryContext);
    }
  }

  return {
    panes,
    paneTemplates,
    destroy() {
      for (const plugin of setupPlugins.reverse()) {
        plugin.dispose?.();
      }
    },
  };
}

function createDiscoveryPluginPersistence(): PluginPersistence {
  const resources = new Map<string, PersistedResourceValue<unknown>>();
  return {
    getState: () => null,
    setState: () => {},
    deleteState: () => {},
    getResource: <T = unknown>(kind: string, key: string) => (
      resources.get(`${kind}:${key}`) as PersistedResourceValue<T> | undefined
    ) ?? null,
    setResource: <T = unknown>(
      kind: string,
      key: string,
      value: T,
      options: Parameters<PluginPersistence["setResource"]>[3],
    ) => {
      const fetchedAt = Date.now();
      const entry: PersistedResourceValue<T> = {
        value,
        fetchedAt,
        staleAt: fetchedAt + options.cachePolicy.staleMs,
        expiresAt: fetchedAt + options.cachePolicy.expireMs,
        sourceKey: options.sourceKey ?? "",
        schemaVersion: options.schemaVersion ?? 1,
        provenance: options.provenance ?? null,
      };
      resources.set(`${kind}:${key}`, entry);
      return entry;
    },
    deleteResource: (kind: string, key: string) => {
      resources.delete(`${kind}:${key}`);
    },
  };
}
