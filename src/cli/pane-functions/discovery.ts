import { ConnectionHealthRegistry } from "../../core/connection-health";
import type { TickerRepository } from "../../data/ticker-repository";
import type { AppConfig } from "../../types/config";
import type { BrokerAdapter } from "../../types/broker";
import type { DataProvider } from "../../types/data-provider";
import type { PersistedResourceValue } from "../../types/persistence";
import type {
  GloomPlugin,
  GloomPluginContext,
  PaneDef,
  PaneTemplateDef,
  PluginPersistence,
} from "../../types/plugin";
import { createPluginTeamState } from "../../plugins/team-state";
import type { MarketContext } from "../types";
import type { PaneFunctionCatalog } from "./catalog";

export interface PaneDiscoveryOptions {
  getConfig: () => AppConfig;
  marketData?: DataProvider;
  tickerRepository?: TickerRepository;
  panes?: Map<string, PaneDef>;
  paneTemplates?: Map<string, PaneTemplateDef>;
  brokers?: Map<string, BrokerAdapter>;
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
  const brokers = options.brokers ?? new Map<string, BrokerAdapter>();
  return {
    ...buildDiscoveryContext({
      panes,
      paneTemplates,
      brokers,
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
  brokers,
  getConfig,
  marketData,
  tickerRepository,
  connectionHealth,
}: {
  panes: Map<string, PaneDef>;
  paneTemplates: Map<string, PaneTemplateDef>;
  brokers: Map<string, BrokerAdapter>;
  getConfig: () => AppConfig;
  marketData: DataProvider;
  tickerRepository: TickerRepository;
  connectionHealth: ConnectionHealthRegistry;
}): GloomPluginContext {
  const fakePersistence = createDiscoveryPluginPersistence();
  const discoveryContext: GloomPluginContext = {
    registerPane: (pane: PaneDef) => panes.set(pane.id, pane),
    registerPaneTemplate: (template: PaneTemplateDef) => {
      paneTemplates.set(template.id, template);
      return () => {
        if (paneTemplates.get(template.id) === template) paneTemplates.delete(template.id);
      };
    },
    registerCommand: () => {},
    registerCommandBarSearchProvider: () => () => {},
    registerColumn: () => {},
    registerBroker: (broker) => { brokers.set(broker.id, broker); },
    getBrokerAdapter: (brokerType) => brokers.get(brokerType) ?? null,
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
    teamState: createPluginTeamState("discovery"),
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
    sharePane: () => {},
    on: () => () => {},
    emit: () => {},
    notify: () => {},
  };
  return discoveryContext;
}

export async function createPaneCatalog(context: MarketContext, plugins: GloomPlugin[]): Promise<PaneFunctionCatalog> {
  const setupPlugins: GloomPlugin[] = [];
  const brokers = new Map<string, BrokerAdapter>();
  const previousResolver = context.resolveBroker;
  const resolveBroker = (brokerType: string) => brokers.get(brokerType) ?? null;
  context.resolveBroker = resolveBroker;
  const { panes, paneTemplates, ...discoveryContext } = createPaneDiscoveryContext({
    getConfig: () => context.config,
    marketData: context.dataProvider,
    tickerRepository: context.store,
    brokers,
  });

  const destroy = () => {
    let failure: unknown;
    for (const plugin of setupPlugins.splice(0).reverse()) {
      try { plugin.dispose?.(); } catch (error) { failure ??= error; }
    }
    brokers.clear();
    if (context.resolveBroker === resolveBroker) context.resolveBroker = previousResolver;
    if (failure) throw failure;
  };

  try {
    for (const plugin of plugins) {
      for (const pane of plugin.panes ?? []) panes.set(pane.id, pane);
      for (const template of plugin.paneTemplates ?? []) paneTemplates.set(template.id, template);
      if (plugin.setup) {
        setupPlugins.push(plugin);
        await plugin.setup(discoveryContext);
      }
    }
  } catch (error) {
    try { destroy(); } catch { /* Preserve the setup error after attempting every disposer. */ }
    throw error;
  }
  return { panes, paneTemplates, destroy };
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
