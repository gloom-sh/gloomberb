import type { ReactNode } from "react";
import {
  CapabilityRegistry,
  type CapabilityManifest,
  type NewsCapability,
  type PluginCapability,
} from "../../capabilities";
import type { AppPersistencePort, AppTickerRepositoryPort } from "../../core/app-service-ports";
import {
  connectionHealth as sharedConnectionHealth,
  type ConnectionHealthRegistry,
} from "../../core/connection-health";
import type { PaneRuntimeState } from "../../core/state/app/state";
import type { LayoutMarketplacePayload } from "../../layout-marketplace/payload";
import { cloudSyncController } from "../../sync/controller";
import type {
  RegisteredSyncContributor,
  RegisteredSyncTransport,
  SyncContributor,
  SyncTransport,
} from "../../sync/types";
import type { BrokerAdapter } from "../../types/broker";
import type { BrokerInstanceConfig, LayoutConfig } from "../../types/config";
import { resolvePaneInstance } from "../../types/config";
import type { ContextMenuContext, ContextMenuItem } from "../../types/context-menu";
import type { DataProvider } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import type {
  AppNotificationDelivery,
  AppNotificationRequest,
  BrokerInstanceUpdateOptions,
  CommandBarSearchProvider,
  CommandDef,
  CustomColumnDef,
  GloomPlugin,
  GloomPluginContext,
  GloomSlots,
  KeyboardShortcut,
  PaneDef,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
  PinTickerOptions,
  TickerAction,
  TickerResearchTabDef,
} from "../../types/plugin";
import type { TickerRecord } from "../../types/ticker";
import { debugLog } from "../../utils/debug-log";
import { EventBus } from "../event-bus";
import { isReservedBuiltinPluginId } from "../ownership";
import { createPluginPersistence } from "../plugin-persistence";
import {
  wrapPaneDefWithRuntime,
  wrapTickerResearchTabDefWithRuntime,
  type PluginRuntimeAccess,
} from "../runtime";
import { resolveRegistryContextMenuItems } from "./context-menu";
import { RegistryContributions, type PluginItems } from "./contributions";
import {
  resolveRegistryPaneQuickSettings,
  resolveRegistryPaneSettings,
  type ResolvedRegistryPaneQuickSetting,
  type ResolvedRegistryPaneSettings,
} from "./pane-settings";
import { RegistryResumeStateListeners, createPluginPaneSettingsState, createPluginResumeState } from "./plugin-state";
import {
  bindSharedRegistry,
  releaseSharedRegistry,
} from "./shared";
import { RegistrySlots } from "./slots";

interface PluginRegistryOptions {
  enableCapabilityHandlers?: boolean;
  wrapBrokerAdapter?: (broker: BrokerAdapter, pluginId: string) => BrokerAdapter;
  connectionHealth?: ConnectionHealthRegistry;
  remoteCapabilityManifests?: () => CapabilityManifest[];
  remoteCapabilityInvoke?: <T>(
    capabilityId: string,
    operationId: string,
    payload: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<T>;
}

export type WindowEditMode = "move" | "resize";
export {
  getSharedMarketData,
  getSharedRegistry,
  setSharedMarketDataForTests,
  setSharedRegistryForTests
} from "./shared";

export class PluginRegistry implements PluginRuntimeAccess {
  private slots = new RegistrySlots();
  private readonly contributions: RegistryContributions;
  private plugins = new Map<string, GloomPlugin>();
  private readonly resumeStateListeners = new RegistryResumeStateListeners();

  readonly events: EventBus;
  readonly capabilities: CapabilityRegistry;
  readonly connectionHealth: ConnectionHealthRegistry;
  readonly marketData: DataProvider;
  readonly tickerRepository: AppTickerRepositoryPort;
  readonly persistence: AppPersistencePort;
  private readonly enableCapabilityHandlers: boolean;
  private readonly wrapBrokerAdapter?: (broker: BrokerAdapter, pluginId: string) => BrokerAdapter;
  private readonly remoteCapabilityManifests?: () => CapabilityManifest[];
  private readonly remoteCapabilityInvoke?: <T>(
    capabilityId: string,
    operationId: string,
    payload: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<T>;

  getTickerFn: ((symbol: string) => TickerRecord | null) = () => null;
  getDataFn: ((symbol: string) => TickerFinancials | null) = () => null;
  getConfigFn: (() => import("../../types/config").AppConfig) = () => { throw new Error("getConfigFn not set"); };
  createBrokerInstanceFn: ((brokerType: string, label: string, values: Record<string, unknown>) => Promise<BrokerInstanceConfig>) = async () => {
    throw new Error("createBrokerInstanceFn not set");
  };
  connectBrokerInstanceFn: ((instanceId: string) => Promise<void>) = async () => {};
  updateBrokerInstanceFn: ((instanceId: string, values: Record<string, unknown>, options?: BrokerInstanceUpdateOptions) => Promise<void>) = async () => {};
  syncBrokerInstanceFn: ((instanceId: string) => Promise<void>) = async () => {};
  removeBrokerInstanceFn: ((instanceId: string) => Promise<void>) = async () => {};

  selectTickerFn: ((symbol: string, paneId?: string) => void) = () => {};
  switchPanelFn: ((panel: "left" | "right") => void) = () => {};
  switchTabFn: ((tabId: string, paneId?: string) => void) = () => {};
  openCommandBarFn: ((query?: string) => void) = () => {};
  openPluginCommandWorkflowFn: ((commandId: string) => void) = () => {};
  openPaneSettingsFn: ((paneId?: string) => void) = () => {};
  openWindowModeFn: ((paneId?: string, mode?: WindowEditMode) => void) = () => {};
  showPaneFn: ((paneId: string) => void) = () => {};
  createPaneFromTemplateFn: ((templateId: string, options?: PaneTemplateCreateOptions) => void) = () => {};
  createPaneFromTemplateAsyncFn: ((templateId: string, options?: PaneTemplateCreateOptions) => Promise<void>) = async () => {};
  openPortablePaneShareAsyncFn: ((layout: LayoutMarketplacePayload) => Promise<void>) = async () => {};
  hidePaneFn: ((paneId: string) => void) = () => {};
  focusPaneFn: ((paneId: string) => void) = () => {};
  pinTickerFn: ((symbol: string, options?: PinTickerOptions) => void) = () => {};
  navigateTickerFn: ((symbol: string, options?: { sourcePaneId?: string | null }) => void) = () => {};
  getMarketData = () => this.marketData;
  getConnectionHealth = () => this.connectionHealth;
  getCapability = (capabilityId: string) => this.capabilities.get(capabilityId)?.capability ?? null;
  capabilityManifests = (kind?: string) => (this.remoteCapabilityManifests?.() ?? this.capabilities.manifests({ rendererOnly: true }))
    .filter((manifest) => !kind || manifest.kind === kind);
  invokeCapability = <T = unknown>(
    capabilityId: string,
    operationId: string,
    payload: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> => (
    this.remoteCapabilityInvoke
      ? this.remoteCapabilityInvoke<T>(capabilityId, operationId, payload, options)
      : this.capabilities.invoke<T>(capabilityId, operationId, payload, { renderer: true, signal: options.signal })
  );
  getBrokerAdapter = (brokerType: string) => this.contributions.brokersMap.get(brokerType) ?? null;
  connectBrokerInstance = (instanceId: string) => this.connectBrokerInstanceFn(instanceId);
  updateBrokerInstance = (instanceId: string, values: Record<string, unknown>, options?: BrokerInstanceUpdateOptions) => (
    this.updateBrokerInstanceFn(instanceId, values, options)
  );
  syncBrokerInstance = (instanceId: string) => this.syncBrokerInstanceFn(instanceId);
  removeBrokerInstance = (instanceId: string) => this.removeBrokerInstanceFn(instanceId);
  pinTicker = (symbol: string, options?: PinTickerOptions) => {
    this.pinTickerFn(symbol, options);
  };
  navigateTicker = (symbol: string, options?: { sourcePaneId?: string | null }) => {
    this.navigateTickerFn(symbol, options);
  };
  selectTicker = (symbol: string, paneId?: string) => {
    this.selectTickerFn(symbol, paneId);
  };
  switchPanel = (panel: "left" | "right") => {
    this.switchPanelFn(panel);
  };
  switchTab = (tabId: string, paneId?: string) => {
    this.switchTabFn(tabId, paneId);
  };
  openCommandBar = (query?: string) => {
    this.openCommandBarFn(query);
  };
  openPaneSettings = (paneId?: string) => {
    this.openPaneSettingsFn(paneId);
  };
  openWindowMode = (paneId?: string, mode?: WindowEditMode) => {
    this.openWindowModeFn(paneId, mode);
  };
  openPluginCommandWorkflow = (commandId: string) => {
    this.openPluginCommandWorkflowFn(commandId);
  };
  showPane = (paneId: string) => {
    this.showPaneFn(paneId);
  };
  createPaneFromTemplate = (templateId: string, options?: PaneTemplateCreateOptions) => {
    this.createPaneFromTemplateFn(templateId, options);
  };
  hidePane = (paneId: string) => {
    this.hidePaneFn(paneId);
  };
  focusPane = (paneId: string) => {
    this.focusPaneFn(paneId);
  };

  getLayoutFn: (() => LayoutConfig) = () => ({ dockRoot: null, instances: [], floating: [], detached: [] });
  updateLayoutFn: ((layout: LayoutConfig) => void) = () => {};
  getTermSizeFn: (() => { width: number; height: number }) = () => ({ width: 120, height: 40 });

  registerNewsCapabilityFn: ((capability: NewsCapability) => () => void) = () => () => {};
  watchNewsQueryFn: ((
    query: import("../../types/news-source").NewsQuery,
    listener: (state: import("../../types/news-source").NewsQueryState) => void,
  ) => () => void) = () => () => {};

  notifyFn: ((notification: AppNotificationRequest) => AppNotificationDelivery | void) = () => {};
  getPaneRuntimeStateFn: ((paneId: string) => PaneRuntimeState | null) = () => null;
  updatePaneRuntimeStateFn: ((paneId: string, patch: Partial<PaneRuntimeState>) => void) = () => {};
  applyPaneSettingValueFn: ((paneId: string, field: import("../../types/plugin").PaneSettingField, value: unknown) => Promise<void>) = async () => {};
  getPluginConfigValueFn: (<T = unknown>(pluginId: string, key: string) => T | null) = <T = unknown>(pluginId: string, key: string): T | null => (
    (this.getConfigFn().pluginConfig[pluginId]?.[key] as T | undefined) ?? null
  );
  setPluginConfigValueFn: ((pluginId: string, key: string, value: unknown) => Promise<void>) = async () => {};
  setPluginConfigValuesFn: ((pluginId: string, values: Record<string, unknown>) => Promise<void>) = async () => {};
  deletePluginConfigValueFn: ((pluginId: string, key: string) => Promise<void>) = async () => {};

  constructor(
    marketData: DataProvider,
    tickerRepository: AppTickerRepositoryPort,
    persistence: AppPersistencePort,
    options: PluginRegistryOptions = {},
  ) {
    this.marketData = marketData;
    this.connectionHealth = options.connectionHealth ?? sharedConnectionHealth;
    this.tickerRepository = tickerRepository;
    this.persistence = persistence;
    this.enableCapabilityHandlers = options.enableCapabilityHandlers ?? true;
    this.wrapBrokerAdapter = options.wrapBrokerAdapter;
    this.remoteCapabilityManifests = options.remoteCapabilityManifests;
    this.remoteCapabilityInvoke = options.remoteCapabilityInvoke;
    this.events = new EventBus();
    this.contributions = new RegistryContributions({
      wrapPaneDef: (pluginId, pane) => wrapPaneDefWithRuntime(pluginId, pane, this),
      wrapTickerResearchTabDef: (pluginId, tab) => wrapTickerResearchTabDefWithRuntime(pluginId, tab, this),
      wrapBrokerAdapter: this.wrapBrokerAdapter,
    });

    bindSharedRegistry(this, marketData);
    this.capabilities = new CapabilityRegistry({
      isPluginEnabled: (pluginId) => !this.getConfigFn().disabledPlugins.includes(pluginId),
      isCapabilityEnabled: (capability, pluginId) => {
        const disabledSources = this.getConfigFn().disabledSources ?? [];
        return !disabledSources.includes(capability.sourceId ?? capability.id) && !this.getConfigFn().disabledPlugins.includes(pluginId);
      },
      connectionHealth: this.connectionHealth,
    });
  }

  get panes(): ReadonlyMap<string, PaneDef> { return this.contributions.panesMap; }
  get paneTemplates(): ReadonlyMap<string, PaneTemplateDef> { return this.contributions.paneTemplatesMap; }
  get commands(): ReadonlyMap<string, CommandDef> { return this.contributions.commandsMap; }
  get commandBarSearchProviders(): ReadonlyMap<string, CommandBarSearchProvider> {
    return this.contributions.commandBarSearchProvidersMap;
  }
  get columns(): ReadonlyMap<string, CustomColumnDef> { return this.contributions.columnsMap; }
  get brokers(): ReadonlyMap<string, BrokerAdapter> { return this.contributions.brokersMap; }
  get tickerResearchTabs(): ReadonlyMap<string, TickerResearchTabDef> { return this.contributions.tickerResearchTabsMap; }
  get shortcuts(): ReadonlyMap<string, KeyboardShortcut> { return this.contributions.shortcutsMap; }
  get tickerActions(): ReadonlyMap<string, TickerAction> { return this.contributions.tickerActionsMap; }
  get allPlugins(): ReadonlyMap<string, GloomPlugin> { return this.plugins; }

  registerSyncContributorForPlugin(pluginId: string, contributor: SyncContributor): () => void {
    return cloudSyncController.registerContributor(pluginId, contributor);
  }

  registerSyncTransportForPlugin(pluginId: string, transport: SyncTransport): () => void {
    return cloudSyncController.registerTransport(pluginId, transport);
  }

  getEnabledSyncContributors(): RegisteredSyncContributor[] {
    const disabledPlugins = new Set(this.getConfigFn().disabledPlugins ?? []);
    return cloudSyncController
      .getRegisteredContributors()
      .filter((entry) => !disabledPlugins.has(entry.pluginId));
  }

  getActiveSyncTransport(): RegisteredSyncTransport | null {
    const disabledPlugins = new Set(this.getConfigFn().disabledPlugins ?? []);
    return cloudSyncController
      .getRegisteredTransports()
      .find((entry) => !disabledPlugins.has(entry.pluginId) && entry.transport.isAvailable()) ?? null;
  }

  getContextMenuItems(context: ContextMenuContext): ContextMenuItem[] {
    return resolveRegistryContextMenuItems({
      context,
      disabledPlugins: new Set(this.getConfigFn().disabledPlugins ?? []),
      providers: this.contributions.contextMenuProvidersMap.entries(),
      onProviderError: (entry, error) => {
        this.registryLog.error("Context menu provider failed", {
          pluginId: entry.pluginId,
          providerId: entry.provider.id,
          context: context.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
  }

  getCapabilityPluginId(capabilityId: string): string | undefined {
    return this.contributions.capabilityOwners.get(capabilityId);
  }

  getEnabledCapabilities(kind?: string): PluginCapability[] {
    return this.capabilities.list(kind).map((entry) => entry.capability);
  }

  getPluginPaneIds(pluginId: string): string[] {
    return this.contributions.panesMap.ids(pluginId);
  }

  getPluginPaneTemplateIds(pluginId: string): string[] {
    return this.contributions.paneTemplatesMap.ids(pluginId);
  }

  getEnabledTickerActions(): TickerAction[] {
    const disabled = this.getConfigFn().disabledPlugins;
    return [...this.contributions.tickerActionsMap].filter(([id]) => (
      !disabled.includes(this.contributions.tickerActionsMap.owners.get(id)!)
    )).map(([, action]) => action);
  }

  notify = (notification: AppNotificationRequest): AppNotificationDelivery | void => this.notifyFn(notification);

  renderSlot<K extends keyof GloomSlots>(name: K, props: GloomSlots[K]): ReactNode {
    return this.slots.render(name, props);
  }

  private registerCapabilityForPlugin(pluginId: string, capability: PluginCapability, items: PluginItems): void {
    const ownedCapability: PluginCapability = {
      ...capability,
      isEnabled: () => {
        const config = this.getConfigFn();
        const disabledPlugin = config.disabledPlugins.includes(pluginId);
        const disabledSource = config.disabledSources?.includes(capability.sourceId ?? capability.id) ?? false;
        return !disabledPlugin && !disabledSource && (capability.isEnabled?.() ?? true);
      },
    };
    const disposeCapability = this.capabilities.register(pluginId, ownedCapability);
    this.contributions.registerCapability(pluginId, capability.id);
    items.capabilityDisposers.push(disposeCapability);
    if (ownedCapability.kind === "asset-data" || ownedCapability.kind === "news") {
      items.capabilityDisposers.push(this.connectionHealth.registerSource({
        id: ownedCapability.id,
        name: `${ownedCapability.name} ${ownedCapability.kind === "news" ? "News" : "Market Data"}`,
        kind: ownedCapability.kind,
        ownerId: pluginId,
        priority: ownedCapability.priority,
        detail: ownedCapability.sourceId,
      }));
    }

    if (ownedCapability.kind === "news") {
      const dispose = this.registerNewsCapabilityFn(ownedCapability as NewsCapability);
      items.capabilityDisposers.push(dispose);
    }
  }

  subscribeResumeState(pluginId: string, key: string, listener: () => void): () => void {
    return this.resumeStateListeners.subscribe(pluginId, key, listener);
  }

  getResumeState<T = unknown>(pluginId: string, key: string, schemaVersion?: number): T | null {
    return this.persistence.pluginState.get<T>(pluginId, `resume:${key}`, schemaVersion)?.value ?? null;
  }

  setResumeState(pluginId: string, key: string, value: unknown, schemaVersion?: number): void {
    this.persistence.pluginState.set(pluginId, `resume:${key}`, value, schemaVersion);
    this.resumeStateListeners.emit(pluginId, key);
  }

  deleteResumeState(pluginId: string, key: string): void {
    this.persistence.pluginState.delete(pluginId, `resume:${key}`);
    this.resumeStateListeners.emit(pluginId, key);
  }

  getConfigState<T = unknown>(pluginId: string, key: string): T | null {
    return this.getPluginConfigValueFn<T>(pluginId, key);
  }

  setConfigState(pluginId: string, key: string, value: unknown): Promise<void> {
    return this.setPluginConfigValueFn(pluginId, key, value);
  }

  setConfigStates(pluginId: string, values: Record<string, unknown>): Promise<void> {
    return this.setPluginConfigValuesFn(pluginId, values);
  }

  deleteConfigState(pluginId: string, key: string): Promise<void> {
    return this.deletePluginConfigValueFn(pluginId, key);
  }

  getConfigStateKeys(pluginId: string): string[] {
    return Object.keys(this.getConfigFn().pluginConfig[pluginId] ?? {}).sort();
  }

  private resolvePaneTarget(paneId: string): string | undefined {
    return resolvePaneInstance(this.getLayoutFn(), paneId)?.instanceId;
  }

  resolvePaneSettings(paneId: string): ResolvedRegistryPaneSettings | null {
    return resolveRegistryPaneSettings({
      config: this.getConfigFn(),
      getConfigState: (pluginId, key) => this.getConfigState(pluginId, key),
      getPaneRuntimeState: this.getPaneRuntimeStateFn,
      layout: this.getLayoutFn(),
      paneDefs: this.contributions.panesMap,
      paneOwners: this.contributions.panesMap.owners,
      resolvePaneTarget: (targetPaneId) => this.resolvePaneTarget(targetPaneId),
      requestedPaneId: paneId,
    });
  }

  hasPaneSettings(paneId: string): boolean {
    return this.resolvePaneSettings(paneId) !== null;
  }

  resolvePaneQuickSettings(paneId: string): ResolvedRegistryPaneQuickSetting[] {
    return resolveRegistryPaneQuickSettings(this.resolvePaneSettings(paneId));
  }

  async togglePaneQuickSetting(paneId: string, key: string): Promise<void> {
    const quickSetting = this.resolvePaneQuickSettings(paneId).find((setting) => setting.key === key);
    if (!quickSetting) return;
    await this.applyPaneSettingValueFn(paneId, quickSetting.field, !quickSetting.value);
  }

  getCommandPluginId(commandId: string): string | undefined {
    return this.contributions.commandsMap.owners.get(commandId);
  }

  getCommandBarSearchProviderPluginId(providerId: string): string | undefined {
    return this.contributions.commandBarSearchProvidersMap.owners.get(providerId);
  }

  getPanePluginId(paneId: string): string | undefined {
    return this.contributions.panesMap.owners.get(paneId);
  }

  getPaneTemplatePluginId(templateId: string): string | undefined {
    return this.contributions.paneTemplatesMap.owners.get(templateId);
  }

  getShortcutPluginId(shortcutId: string): string | undefined {
    return this.contributions.shortcutsMap.owners.get(shortcutId);
  }

  getTickerResearchTabPluginId(tabId: string): string | undefined {
    return this.contributions.tickerResearchTabsMap.owners.get(tabId);
  }

  isPaneFloating(paneId: string): boolean {
    try {
      const target = this.resolvePaneTarget(paneId);
      return !!target && this.getLayoutFn().floating.some((entry) => entry.instanceId === target);
    } catch {
      return false;
    }
  }

  private createContext(pluginId: string): GloomPluginContext {
    const contributions = this.contributions;
    const items = contributions.getOrCreatePluginItems(pluginId);
    return {
      registerPane: (pane) => contributions.registerPane(pluginId, pane),
      registerPaneTemplate: (template) => contributions.registerPaneTemplate(pluginId, template),
      registerCommand: (command) => contributions.registerCommand(pluginId, command),
      registerCommandBarSearchProvider: (provider) => contributions.registerCommandBarSearchProvider(pluginId, provider),
      registerColumn: (column) => contributions.registerColumn(pluginId, column),
      registerBroker: (broker) => contributions.registerBroker(pluginId, broker),
      registerCapability: (capability) => {
        if (this.enableCapabilityHandlers) this.registerCapabilityForPlugin(pluginId, capability, items);
      },
      registerTickerResearchTab: (tab) => contributions.registerTickerResearchTab(pluginId, tab),
      registerShortcut: (shortcut) => contributions.registerShortcut(pluginId, shortcut),
      registerTickerAction: (action) => contributions.registerTickerAction(pluginId, action),
      registerContextMenuProvider: (provider) => contributions.registerContextMenuProvider(pluginId, provider),
      registerSyncContributor: (contributor) => {
        const dispose = this.registerSyncContributorForPlugin(pluginId, contributor);
        items.eventDisposers.push(dispose);
        return dispose;
      },
      registerSyncTransport: (transport) => {
        const dispose = this.registerSyncTransportForPlugin(pluginId, transport);
        items.eventDisposers.push(dispose);
        return dispose;
      },
      watchNewsQuery: (query, listener) => {
        const dispose = this.watchNewsQueryFn(query, listener);
        items.newsQueryWatchDisposers.push(dispose);
        return dispose;
      },
      getData: (ticker) => this.getDataFn(ticker),
      getTicker: (symbol) => this.getTickerFn(symbol),
      getConfig: () => this.getConfigFn(),
      getPaneDef: (paneId) => contributions.panesMap.get(paneId),
      marketData: this.marketData,
      connectionHealth: this.connectionHealth,
      tickerRepository: this.tickerRepository,
      persistence: createPluginPersistence(this.persistence.pluginState, this.persistence.resources, `plugin:${pluginId}`, pluginId),
      log: debugLog.createLogger(pluginId),
      resume: createPluginResumeState({
        pluginId,
        getResumeState: (key, version) => this.getResumeState(pluginId, key, version),
        setResumeState: (key, value, version) => this.setResumeState(pluginId, key, value, version),
        deleteResumeState: (key) => this.deleteResumeState(pluginId, key),
        getPaneRuntimeState: (paneId) => this.getPaneRuntimeStateFn(paneId),
        updatePaneRuntimeState: (paneId, patch) => this.updatePaneRuntimeStateFn(paneId, patch),
      }),
      paneSettings: createPluginPaneSettingsState({
        getLayout: () => this.getLayoutFn(),
        updateLayout: (layout) => this.updateLayoutFn(layout),
        resolvePaneTarget: (paneId) => this.resolvePaneTarget(paneId),
      }),
      configState: {
        get: (key) => this.getConfigState(pluginId, key),
        set: (key, value) => this.setConfigState(pluginId, key, value),
        delete: (key) => this.deleteConfigState(pluginId, key),
        keys: () => this.getConfigStateKeys(pluginId),
      },
      createBrokerInstance: (brokerType, label, values) => this.createBrokerInstanceFn(brokerType, label, values),
      updateBrokerInstance: this.updateBrokerInstance,
      syncBrokerInstance: this.syncBrokerInstance,
      removeBrokerInstance: this.removeBrokerInstance,
      selectTicker: this.selectTicker,
      switchPanel: this.switchPanel,
      switchTab: this.switchTab,
      openCommandBar: this.openCommandBar,
      showPane: this.showPane,
      createPaneFromTemplate: this.createPaneFromTemplate,
      hidePane: this.hidePane,
      focusPane: this.focusPane,
      pinTicker: this.pinTicker,
      navigateTicker: this.navigateTicker,
      openPaneSettings: this.openPaneSettings,
      on: (event, handler) => {
        const dispose = this.events.on(event, handler);
        items.eventDisposers.push(dispose);
        return dispose;
      },
      emit: (event, payload) => this.events.emit(event, payload),
      notify: (notification) => this.notifyFn(notification),
    };
  }

  private registryLog = debugLog.createLogger("registry");

  async register(plugin: GloomPlugin): Promise<void> {
    this.registryLog.info(`Registering plugin: ${plugin.id} v${plugin.version ?? "?"}`);
    if (isReservedBuiltinPluginId(plugin.id)) {
      throw new Error(`Plugin id is reserved by a built-in module: ${plugin.id}`);
    }
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin already registered: ${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
    try {
      const items = this.contributions.getOrCreatePluginItems(plugin.id);
      if (plugin.panes) {
        for (const pane of plugin.panes) {
          this.contributions.registerPane(plugin.id, pane);
        }
      }

      if (plugin.paneTemplates) {
        for (const template of plugin.paneTemplates) {
          this.contributions.registerPaneTemplate(plugin.id, template);
        }
      }

      if (plugin.broker) {
        this.contributions.registerBroker(plugin.id, plugin.broker);
      }

      if (this.enableCapabilityHandlers && plugin.capabilities) {
        for (const capability of plugin.capabilities) {
          this.registerCapabilityForPlugin(plugin.id, capability, items);
        }
      }

      this.slots.register(plugin, this);

      if (plugin.setup) {
        await plugin.setup(this.createContext(plugin.id));
      }
    } catch (error) {
      try {
        this.removePlugin(plugin.id);
      } catch (cleanupError) {
        this.registryLog.error("Failed to clean up rejected plugin registration", {
          pluginId: plugin.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    }

    this.events.emit("plugin:registered", { pluginId: plugin.id });
  }

  unregister(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    this.registryLog.info(`Unregistering plugin: ${pluginId}`);

    this.removePlugin(pluginId);
    this.events.emit("plugin:unregistered", { pluginId });
  }

  private removePlugin(pluginId: string): void {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    let cleanupError: unknown;
    try { plugin.dispose?.(); } catch (error) { cleanupError = error; }
    try { this.slots.unregister(pluginId); } catch (error) { cleanupError ??= error; }
    try { this.contributions.unregister(pluginId); } catch (error) { cleanupError ??= error; }
    this.plugins.delete(pluginId);
    if (cleanupError) throw cleanupError;
  }

  destroy(): void {
    for (const pluginId of [...this.plugins.keys()].reverse()) {
      try {
        this.unregister(pluginId);
      } catch (error) {
        this.registryLog.error("Failed to unregister plugin during registry destroy", {
          pluginId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.capabilities.destroy();
    this.contributions.capabilityOwners.clear();
    this.resumeStateListeners.clear();
    releaseSharedRegistry(this, this.marketData);
  }
}
