import type { ReactNode } from "react";
import type { AppPersistencePort, AppTickerRepositoryPort } from "../../core/app-service-ports";
import {
  connectionHealth as sharedConnectionHealth,
  type ConnectionHealthRegistry,
} from "../../core/connection-health";
import type { BrokerAdapter } from "../../types/broker";
import {
  CapabilityRegistry,
  type CapabilityManifest,
  type NewsCapability,
  type PluginCapability,
} from "../../capabilities";
import type { BrokerInstanceConfig, LayoutConfig } from "../../types/config";
import type { DataProvider } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";
import type {
  AppNotificationDelivery,
  AppNotificationRequest,
  BrokerInstanceUpdateOptions,
  CommandDef,
  CustomColumnDef,
  GloomPlugin,
  GloomSlots,
  KeyboardShortcut,
  PaneDef,
  PaneTemplateCreateOptions,
  PaneTemplateDef,
  PinTickerOptions,
  TickerAction,
  TickerResearchTabDef,
} from "../../types/plugin";
import type { ContextMenuContext, ContextMenuItem } from "../../types/context-menu";
import type { TickerRecord } from "../../types/ticker";
import type {
  RegisteredSyncContributor,
  RegisteredSyncTransport,
  SyncContributor,
  SyncTransport,
} from "../../sync/types";
import { EventBus } from "../event-bus";
import { resolvePaneInstance } from "../../types/config";
import { debugLog } from "../../utils/debug-log";
import {
  wrapTickerResearchTabDefWithRuntime,
  wrapPaneDefWithRuntime,
  type PluginRuntimeAccess,
} from "../runtime";
import type { PaneRuntimeState } from "../../core/state/app/state";
import {
  resolveRegistryPaneQuickSettings,
  resolveRegistryPaneSettings,
  type ResolvedRegistryPaneQuickSetting,
  type ResolvedRegistryPaneSettings,
} from "./pane-settings";
import { RegistrySlots } from "./slots";
import { RegistryContributions, type PluginItems } from "./contributions";
import { createRegistryPluginContext } from "./context";
import { resolveRegistryContextMenuItems } from "./context-menu";
import {
  bindSharedRegistry,
  releaseSharedRegistry,
} from "./shared";
import { RegistryResumeStateListeners } from "./plugin-state";
import { cloudSyncController } from "../../sync/controller";
import { isReservedBuiltinPluginId } from "../ownership";

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
  setSharedRegistryForTests,
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

  readonly Slot;

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
    this.Slot = ({ name, ...props }: { name: keyof GloomSlots } & Record<string, unknown>) => (
      this.renderSlot(name, props as any)
    );
  }

  get panes(): ReadonlyMap<string, PaneDef> { return this.contributions.panesMap; }
  get paneTemplates(): ReadonlyMap<string, PaneTemplateDef> { return this.contributions.paneTemplatesMap; }
  get commands(): ReadonlyMap<string, CommandDef> { return this.contributions.commandsMap; }
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
    return this.contributions.pluginItems.get(pluginId)?.panes ?? [];
  }

  getPluginPaneTemplateIds(pluginId: string): string[] {
    return this.contributions.pluginItems.get(pluginId)?.paneTemplates ?? [];
  }

  notify(notification: AppNotificationRequest): AppNotificationDelivery | void {
    return this.notifyFn(notification);
  }

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
    this.contributions.registerCapability(pluginId, capability.id, items);
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
      paneOwners: this.contributions.paneOwners,
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
    return this.contributions.commandOwners.get(commandId);
  }

  getPanePluginId(paneId: string): string | undefined {
    return this.contributions.paneOwners.get(paneId);
  }

  getPaneTemplatePluginId(templateId: string): string | undefined {
    return this.contributions.paneTemplateOwners.get(templateId);
  }

  getShortcutPluginId(shortcutId: string): string | undefined {
    return this.contributions.shortcutOwners.get(shortcutId);
  }

  getTickerResearchTabPluginId(tabId: string): string | undefined {
    return this.contributions.tickerResearchTabOwners.get(tabId);
  }

  isPaneFloating(paneId: string): boolean {
    try {
      const target = this.resolvePaneTarget(paneId);
      return !!target && this.getLayoutFn().floating.some((entry) => entry.instanceId === target);
    } catch {
      return false;
    }
  }

  private createContext(pluginId: string) {
    const items = this.contributions.getOrCreatePluginItems(pluginId);
    return createRegistryPluginContext({
      pluginId,
      items,
      contributions: this.contributions,
      enableCapabilityHandlers: this.enableCapabilityHandlers,
      marketData: this.marketData,
      connectionHealth: this.connectionHealth,
      tickerRepository: this.tickerRepository,
      persistence: this.persistence,
      getLayout: () => this.getLayoutFn(),
      updateLayout: (layout) => this.updateLayoutFn(layout),
      resolvePaneTarget: (paneId) => this.resolvePaneTarget(paneId),
      registerCapabilityForPlugin: (targetPluginId, capability, pluginItems) => this.registerCapabilityForPlugin(targetPluginId, capability, pluginItems),
      registerSyncContributorForPlugin: (targetPluginId, contributor) => this.registerSyncContributorForPlugin(targetPluginId, contributor),
      registerSyncTransportForPlugin: (targetPluginId, transport) => this.registerSyncTransportForPlugin(targetPluginId, transport),
      watchNewsQuery: (query, listener) => this.watchNewsQueryFn(query, listener),
      getData: (ticker) => this.getDataFn(ticker),
      getTicker: (symbol) => this.getTickerFn(symbol),
      getConfig: () => this.getConfigFn(),
      getResumeState: (key, schemaVersion) => this.getResumeState(pluginId, key, schemaVersion),
      setResumeState: (key, value, schemaVersion) => this.setResumeState(pluginId, key, value, schemaVersion),
      deleteResumeState: (key) => this.deleteResumeState(pluginId, key),
      getPaneRuntimeState: (paneId) => this.getPaneRuntimeStateFn(paneId),
      updatePaneRuntimeState: (paneId, patch) => this.updatePaneRuntimeStateFn(paneId, patch),
      getConfigState: (key) => this.getConfigState(pluginId, key),
      setConfigState: (key, value) => this.setConfigState(pluginId, key, value),
      deleteConfigState: (key) => this.deleteConfigState(pluginId, key),
      getConfigStateKeys: () => this.getConfigStateKeys(pluginId),
      createBrokerInstance: (brokerType, label, values) => this.createBrokerInstanceFn(brokerType, label, values),
      updateBrokerInstance: (instanceId, values, options) => this.updateBrokerInstanceFn(instanceId, values, options),
      syncBrokerInstance: (instanceId) => this.syncBrokerInstanceFn(instanceId),
      removeBrokerInstance: (instanceId) => this.removeBrokerInstanceFn(instanceId),
      selectTicker: (symbol, paneId) => this.selectTicker(symbol, paneId),
      switchPanel: (panel) => this.switchPanel(panel),
      switchTab: (tabId, paneId) => this.switchTab(tabId, paneId),
      openCommandBar: (query) => this.openCommandBar(query),
      showPane: (paneId) => this.showPane(paneId),
      createPaneFromTemplate: (templateId, options) => this.createPaneFromTemplate(templateId, options),
      hidePane: (paneId) => this.hidePane(paneId),
      focusPane: (paneId) => this.focusPaneFn(paneId),
      pinTicker: (symbol, options) => this.pinTicker(symbol, options),
      navigateTicker: (symbol, options) => this.navigateTicker(symbol, options),
      openPaneSettings: (paneId) => this.openPaneSettings(paneId),
      events: this.events,
      notify: (notification) => this.notifyFn(notification),
    });
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
          this.contributions.registerPane(plugin.id, pane, items);
        }
      }

      if (plugin.paneTemplates) {
        for (const template of plugin.paneTemplates) {
          this.contributions.registerPaneTemplate(plugin.id, template, items);
        }
      }

      if (plugin.broker) {
        this.contributions.registerBroker(plugin.id, plugin.broker, items);
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
