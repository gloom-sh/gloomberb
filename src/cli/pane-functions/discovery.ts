import { ConnectionHealthRegistry } from "../../core/connection-health";
import type { AppConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type {
  GloomPlugin,
  GloomPluginContext,
  PaneDef,
  PaneTemplateDef,
  PluginPersistence,
} from "../../types/plugin";
import type { PersistedResourceValue } from "../../types/persistence";
import type { TickerRepository } from "../../data/ticker-repository";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";

export interface PaneDiscoveryOptions {
  getConfig: () => AppConfig;
  marketData?: DataProvider;
  tickerRepository?: TickerRepository;
  panes?: Map<string, PaneDef>;
  paneTemplates?: Map<string, PaneTemplateDef>;
}

/** Throws only if a plugin actually reaches for a dependency discovery has no answer for. */
function unavailable<T>(name: string): T {
  return new Proxy({}, {
    get() {
      throw new Error(`${name} is unavailable during pane discovery.`);
    },
  }) as T;
}

/**
 * Context that collects `setup()`-registered panes and templates without
 * booting the real plugin runtime or its polling engines. Keep this object
 * exhaustively typed so additions to GloomPluginContext fail at compile time
 * instead of crashing `gloomberb catalog` at runtime.
 */
export function createPaneDiscoveryContext(options: PaneDiscoveryOptions): GloomPluginContext & {
  panes: Map<string, PaneDef>;
  paneTemplates: Map<string, PaneTemplateDef>;
} {
  const panes = options.panes ?? new Map<string, PaneDef>();
  const paneTemplates = options.paneTemplates ?? new Map<string, PaneTemplateDef>();
  return {
    ...buildDiscoveryContext({
      panes,
      paneTemplates,
      getConfig: options.getConfig,
      marketData: options.marketData ?? unavailable<DataProvider>("Market data"),
      tickerRepository: options.tickerRepository ?? unavailable<TickerRepository>("The ticker repository"),
      connectionHealth: new ConnectionHealthRegistry(),
    }),
    panes,
    paneTemplates,
  };
}

function buildDiscoveryContext({
  panes,
  paneTemplates,
  getConfig,
  marketData,
  tickerRepository,
  connectionHealth,
}: {
  panes: Map<string, PaneDef>;
  paneTemplates: Map<string, PaneTemplateDef>;
  getConfig: () => AppConfig;
  marketData: DataProvider;
  tickerRepository: TickerRepository;
  connectionHealth: ConnectionHealthRegistry;
}): GloomPluginContext {
  const fakePersistence = createDiscoveryPluginPersistence();
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
    getConfig,
    getPaneDef: (paneId: string) => panes.get(paneId),
    marketData,
    connectionHealth,
    tickerRepository,
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
  return discoveryContext;
}

export async function createPaneCatalog(context: MarketContext, plugins: GloomPlugin[]): Promise<PaneFunctionCatalog> {
  const setupPlugins: GloomPlugin[] = [];
  const { panes, paneTemplates, ...discoveryContext } = createPaneDiscoveryContext({
    getConfig: () => context.config,
    marketData: context.dataProvider,
    tickerRepository: context.store,
  });

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
