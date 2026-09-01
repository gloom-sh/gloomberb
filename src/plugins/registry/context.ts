import type { AppPersistencePort, AppTickerRepositoryPort } from "../../core/app-service-ports";
import type { ConnectionHealthRegistry } from "../../core/connection-health";
import type { BrokerInstanceConfig, LayoutConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import type { TickerRecord } from "../../types/ticker";
import type { PluginCapability } from "../../capabilities";
import type {
  AppNotificationDelivery,
  AppNotificationRequest,
  BrokerInstanceUpdateOptions,
  GloomPluginContext,
  PaneTemplateCreateOptions,
  PinTickerOptions,
} from "../../types/plugin";
import type { PaneRuntimeState } from "../../core/state/app/state";
import type { NewsQuery, NewsQueryState } from "../../types/news-source";
import type { SyncContributor, SyncTransport } from "../../sync/types";
import { debugLog } from "../../utils/debug-log";
import { createPluginPersistence } from "../plugin-persistence";
import type { PluginEvents } from "../event-bus";
import type { PluginItems, RegistryContributions } from "./contributions";
import {
  createPluginPaneSettingsState,
  createPluginResumeState,
} from "./plugin-state";

export interface RegistryPluginContextOptions {
  pluginId: string;
  items: PluginItems;
  contributions: RegistryContributions;
  enableCapabilityHandlers: boolean;
  marketData: DataProvider;
  connectionHealth: ConnectionHealthRegistry;
  tickerRepository: AppTickerRepositoryPort;
  persistence: AppPersistencePort;
  getLayout: () => LayoutConfig;
  updateLayout: (layout: LayoutConfig) => void;
  resolvePaneTarget: (paneId: string) => string | undefined;
  registerCapabilityForPlugin: (pluginId: string, capability: PluginCapability, items: PluginItems) => void;
  registerSyncContributorForPlugin: (pluginId: string, contributor: SyncContributor) => () => void;
  registerSyncTransportForPlugin: (pluginId: string, transport: SyncTransport) => () => void;
  watchNewsQuery: (query: NewsQuery, listener: (state: NewsQueryState) => void) => () => void;
  getData: (ticker: string) => TickerFinancials | null;
  getTicker: (symbol: string) => TickerRecord | null;
  getConfig: () => import("../../types/config").AppConfig;
  getResumeState: <T = unknown>(key: string, schemaVersion?: number) => T | null;
  setResumeState: (key: string, value: unknown, schemaVersion?: number) => void;
  deleteResumeState: (key: string) => void;
  getPaneRuntimeState: (paneId: string) => PaneRuntimeState | null;
  updatePaneRuntimeState: (paneId: string, patch: Partial<PaneRuntimeState>) => void;
  getConfigState: <T = unknown>(key: string) => T | null;
  setConfigState: (key: string, value: unknown) => Promise<void>;
  deleteConfigState: (key: string) => Promise<void>;
  getConfigStateKeys: () => string[];
  createBrokerInstance: (brokerType: string, label: string, values: Record<string, unknown>) => Promise<BrokerInstanceConfig>;
  updateBrokerInstance: (instanceId: string, values: Record<string, unknown>, options?: BrokerInstanceUpdateOptions) => Promise<void>;
  syncBrokerInstance: (instanceId: string) => Promise<void>;
  removeBrokerInstance: (instanceId: string) => Promise<void>;
  selectTicker: (symbol: string, paneId?: string) => void;
  switchPanel: (panel: "left" | "right") => void;
  switchTab: (tabId: string, paneId?: string) => void;
  openCommandBar: (query?: string) => void;
  showPane: (paneId: string) => void;
  createPaneFromTemplate: (templateId: string, options?: PaneTemplateCreateOptions) => void;
  hidePane: (paneId: string) => void;
  focusPane: (paneId: string) => void;
  pinTicker: (symbol: string, options?: PinTickerOptions) => void;
  navigateTicker: (symbol: string, options?: { sourcePaneId?: string | null }) => void;
  openPaneSettings: (paneId?: string) => void;
  events: {
    on: <K extends keyof PluginEvents>(event: K, handler: (payload: PluginEvents[K]) => void) => () => void;
    emit: <K extends keyof PluginEvents>(event: K, payload: PluginEvents[K]) => void;
  };
  notify: (notification: AppNotificationRequest) => AppNotificationDelivery | void;
}

export function createRegistryPluginContext({
  pluginId,
  items,
  contributions,
  enableCapabilityHandlers,
  marketData,
  connectionHealth,
  tickerRepository,
  persistence,
  getLayout,
  updateLayout,
  resolvePaneTarget,
  registerCapabilityForPlugin,
  registerSyncContributorForPlugin,
  registerSyncTransportForPlugin,
  watchNewsQuery,
  getData,
  getTicker,
  getConfig,
  getResumeState,
  setResumeState,
  deleteResumeState,
  getPaneRuntimeState,
  updatePaneRuntimeState,
  getConfigState,
  setConfigState,
  deleteConfigState,
  getConfigStateKeys,
  createBrokerInstance,
  updateBrokerInstance,
  syncBrokerInstance,
  removeBrokerInstance,
  selectTicker,
  switchPanel,
  switchTab,
  openCommandBar,
  showPane,
  createPaneFromTemplate,
  hidePane,
  focusPane,
  pinTicker,
  navigateTicker,
  openPaneSettings,
  events,
  notify,
}: RegistryPluginContextOptions): GloomPluginContext {
  const pluginNamespace = `plugin:${pluginId}`;
  const pluginPersistence = createPluginPersistence(persistence.pluginState, persistence.resources, pluginNamespace, pluginId);
  const log = debugLog.createLogger(pluginId);
  const resume = createPluginResumeState({
    pluginId,
    getResumeState,
    setResumeState,
    deleteResumeState,
    getPaneRuntimeState,
    updatePaneRuntimeState,
  });
  const paneSettings = createPluginPaneSettingsState({
    getLayout,
    resolvePaneTarget,
    updateLayout,
  });

  return {
    registerPane: (pane) => contributions.registerPane(pluginId, pane, items),
    registerPaneTemplate: (template) => contributions.registerPaneTemplate(pluginId, template, items),
    registerCommand: (command) => contributions.registerCommand(pluginId, command, items),
    registerCommandBarSearchProvider: (provider) => (
      contributions.registerCommandBarSearchProvider(pluginId, provider, items)
    ),
    registerColumn: (column) => contributions.registerColumn(pluginId, column, items),
    registerBroker: (broker) => contributions.registerBroker(pluginId, broker, items),
    registerCapability: (capability) => {
      if (enableCapabilityHandlers) registerCapabilityForPlugin(pluginId, capability, items);
    },
    registerTickerResearchTab: (tab) => contributions.registerTickerResearchTab(pluginId, tab, items),
    registerShortcut: (shortcut) => contributions.registerShortcut(pluginId, shortcut, items),
    registerTickerAction: (action) => contributions.registerTickerAction(pluginId, action, items),
    registerContextMenuProvider: (provider) => contributions.registerContextMenuProvider(pluginId, provider, items),
    registerSyncContributor: (contributor) => {
      const dispose = registerSyncContributorForPlugin(pluginId, contributor);
      items.eventDisposers.push(dispose);
      return dispose;
    },
    registerSyncTransport: (transport) => {
      const dispose = registerSyncTransportForPlugin(pluginId, transport);
      items.eventDisposers.push(dispose);
      return dispose;
    },
    watchNewsQuery: (query, listener) => {
      const dispose = watchNewsQuery(query, listener);
      items.newsQueryWatchDisposers.push(dispose);
      return dispose;
    },

    getData,
    getTicker,
    getConfig,
    getPaneDef: (paneId) => contributions.panesMap.get(paneId),

    marketData,
    connectionHealth,
    tickerRepository,
    persistence: pluginPersistence,
    log,
    resume,
    paneSettings,
    configState: {
      get: getConfigState,
      set: setConfigState,
      delete: deleteConfigState,
      keys: getConfigStateKeys,
    },

    createBrokerInstance,
    updateBrokerInstance,
    syncBrokerInstance,
    removeBrokerInstance,

    selectTicker,
    switchPanel,
    switchTab,
    openCommandBar,
    showPane,
    createPaneFromTemplate,
    hidePane,
    focusPane,
    pinTicker,
    navigateTicker,
    openPaneSettings,

    on: (event, handler) => {
      const dispose = events.on(event, handler);
      items.eventDisposers.push(dispose);
      return dispose;
    },
    emit: (event, payload) => events.emit(event, payload),

    notify,
  };
}
