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
import { cloudSyncController } from "../../sync/controller";
import type {
  RegisteredSyncContributor,
  RegisteredSyncTransport,
  SyncContributor,
  SyncTransport,
} from "../../sync/types";
import type { BrokerAdapter } from "../../types/broker";
import { resolvePaneInstance } from "../../types/config";
import type { ContextMenuContext, ContextMenuItem } from "../../types/context-menu";
import type { DataProvider } from "../../types/data-provider";
import type {
  CommandBarSearchProvider,
  CommandDef,
  CustomColumnDef,
  GloomPlugin,
  GloomPluginContext,
  GloomSlots,
  KeyboardShortcut,
  PaneDef,
  PaneTemplateDef,
  TickerAction,
  TickerResearchTabDef,
} from "../../types/plugin";
import { debugLog } from "../../utils/debug-log";
import { EventBus, type HostEvents } from "../event-bus";
import { isReservedBuiltinPluginId } from "../ownership";
import { createPluginPersistence } from "../plugin-persistence";
import { createPluginTeamState } from "../team-state";
import { withPluginRender, type PluginRuntimeAccess } from "../runtime";
import { resolveRegistryContextMenuItems } from "./context-menu";
import { RegistryContributions, type PluginItems } from "./contributions";
import {
  createDefaultHostActions,
  HOST_ACTION_NAMES,
  type DeprecatedHostActionSlots,
  type PluginHostActions,
} from "./host-actions";
import {
  resolveRegistryPaneQuickSettings,
  resolveRegistryPaneSettings,
  type ResolvedRegistryPaneQuickSetting,
  type ResolvedRegistryPaneSettings,
} from "./pane-settings";
import {
  RegistryResumeStateListeners,
  bindPluginContextNamespaces,
  createPluginPaneSettingsState,
  createPluginResumeState,
  type NamespacedPluginContext,
} from "./plugin-state";
import { createPluginSetupCommand, isPluginConfigured } from "./setup-command";
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

export type { WindowEditMode } from "./host-actions";

/** A switched-off plugin, named for a "Turn on" offer. */
export interface DisabledPluginOwner {
  id: string;
  name: string;
}
export {
  getSharedMarketData,
  getSharedRegistry,
  setSharedMarketDataForTests,
  setSharedRegistryForTests
} from "./shared";

/**
 * Every host action is also a member of the registry (`registry.showPane(id)`)
 * that calls whatever the app bound last, so one passed around keeps working
 * after the app rebinds it.
 */
export interface PluginRegistry extends PluginHostActions, DeprecatedHostActionSlots {}

export class PluginRegistry implements PluginRuntimeAccess {
  private readonly defaultHostActions = createDefaultHostActions(() => this);
  private readonly hostActions: PluginHostActions = { ...this.defaultHostActions };
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
  listBrokerAdapters = () => [...this.contributions.brokersMap.values()];

  constructor(
    marketData: DataProvider,
    tickerRepository: AppTickerRepositoryPort,
    persistence: AppPersistencePort,
    options: PluginRegistryOptions = {},
  ) {
    for (const name of HOST_ACTION_NAMES) {
      Object.assign(this, {
        [name]: (...args: unknown[]) => (this.hostActions[name] as (...args: unknown[]) => unknown)(...args),
      });
      // The old one-slot-per-action API: reading a slot returns the bound
      // action, assigning one binds it.
      Object.defineProperty(this, `${name}Fn`, {
        configurable: true,
        get: () => this.hostActions[name],
        set: (action: PluginHostActions[typeof name]) => { this.bindHost({ [name]: action }); },
      });
    }
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
      wrapComponent: (pluginId, component) => withPluginRender(this.stateNamespace(pluginId), this, component),
      wrapBrokerAdapter: this.wrapBrokerAdapter,
    });

    bindSharedRegistry(this, marketData);
    this.capabilities = new CapabilityRegistry({
      isPluginEnabled: (pluginId) => !this.getConfig().disabledPlugins.includes(pluginId),
      pluginName: (pluginId) => this.plugins.get(pluginId)?.name,
      isCapabilityEnabled: (capability, pluginId) => {
        const disabledSources = this.getConfig().disabledSources ?? [];
        return !disabledSources.includes(capability.sourceId ?? capability.id) && !this.getConfig().disabledPlugins.includes(pluginId);
      },
      connectionHealth: this.connectionHealth,
    });
  }

  /**
   * Binds the given host actions and leaves the others as they are. The
   * returned function puts the defaults back for any of them still bound, so
   * a shell or window that unmounts does not undo what mounted after it.
   */
  bindHost(actions: Partial<PluginHostActions>): () => void {
    const bound = Object.entries(actions).filter(([, action]) => action !== undefined);
    Object.assign(this.hostActions, Object.fromEntries(bound));
    return () => {
      for (const [name, action] of bound) {
        const key = name as keyof PluginHostActions;
        if (this.hostActions[key] === action) Object.assign(this.hostActions, { [key]: this.defaultHostActions[key] });
      }
    };
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
    const disabledPlugins = new Set(this.getConfig().disabledPlugins ?? []);
    return cloudSyncController
      .getRegisteredContributors()
      .filter((entry) => !disabledPlugins.has(entry.pluginId));
  }

  getActiveSyncTransport(): RegisteredSyncTransport | null {
    const disabledPlugins = new Set(this.getConfig().disabledPlugins ?? []);
    return cloudSyncController
      .getRegisteredTransports()
      .find((entry) => !disabledPlugins.has(entry.pluginId) && entry.transport.isAvailable()) ?? null;
  }

  getContextMenuItems(context: ContextMenuContext): ContextMenuItem[] {
    return resolveRegistryContextMenuItems({
      context,
      disabledPlugins: new Set(this.getConfig().disabledPlugins ?? []),
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
    const disabled = this.getConfig().disabledPlugins;
    return [...this.contributions.tickerActionsMap].filter(([id]) => (
      !disabled.includes(this.contributions.tickerActionsMap.owners.get(id)!)
    )).map(([, action]) => action);
  }

  renderSlot<K extends keyof GloomSlots>(
    name: K,
    props: GloomSlots[K],
    disabledPlugins: readonly string[] = this.getConfig().disabledPlugins,
  ): ReactNode {
    return this.slots.render(name, props, disabledPlugins);
  }

  private registerCapabilityForPlugin(pluginId: string, capability: PluginCapability, items: PluginItems): void {
    const ownedCapability: PluginCapability = {
      ...capability,
      isEnabled: () => {
        const config = this.getConfig();
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
      const dispose = this.registerNewsCapability(ownedCapability as NewsCapability);
      items.capabilityDisposers.push(dispose);
    }
  }

  /**
   * Where a plugin's saved state lives, which is its id unless it declares
   * otherwise. A plugin that was renamed keeps reading and writing the state
   * the user already has instead of starting again under the new id.
   */
  private stateNamespace(pluginId: string): string {
    return this.plugins.get(pluginId)?.stateId ?? pluginId;
  }

  subscribeResumeState(pluginId: string, key: string, listener: () => void): () => void {
    return this.resumeStateListeners.subscribe(this.stateNamespace(pluginId), key, listener);
  }

  getResumeState<T = unknown>(pluginId: string, key: string, schemaVersion?: number): T | null {
    const stateId = this.stateNamespace(pluginId);
    return this.persistence.pluginState.get<T>(stateId, `resume:${key}`, schemaVersion)?.value ?? null;
  }

  setResumeState(pluginId: string, key: string, value: unknown, schemaVersion?: number): void {
    const stateId = this.stateNamespace(pluginId);
    this.persistence.pluginState.set(stateId, `resume:${key}`, value, schemaVersion);
    this.resumeStateListeners.emit(stateId, key);
  }

  deleteResumeState(pluginId: string, key: string): void {
    const stateId = this.stateNamespace(pluginId);
    this.persistence.pluginState.delete(stateId, `resume:${key}`);
    this.resumeStateListeners.emit(stateId, key);
  }

  getConfigState<T = unknown>(pluginId: string, key: string): T | null {
    return this.getPluginConfigValue<T>(this.stateNamespace(pluginId), key);
  }

  setConfigState(pluginId: string, key: string, value: unknown): Promise<void> {
    return this.setPluginConfigValue(this.stateNamespace(pluginId), key, value);
  }

  setConfigStates(pluginId: string, values: Record<string, unknown>): Promise<void> {
    return this.setPluginConfigValues(this.stateNamespace(pluginId), values);
  }

  deleteConfigState(pluginId: string, key: string): Promise<void> {
    return this.deletePluginConfigValue(this.stateNamespace(pluginId), key);
  }

  getConfigStateKeys(pluginId: string): string[] {
    return Object.keys(this.getConfig().pluginConfig[this.stateNamespace(pluginId)] ?? {}).sort();
  }

  /** False while a plugin with a `configSchema` is missing a required value. */
  isPluginConfigured(pluginId: string): boolean {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return true;
    return isPluginConfigured(plugin, this.getConfig().pluginConfig[this.stateNamespace(pluginId)] ?? {});
  }

  private resolvePaneTarget(paneId: string): string | undefined {
    return resolvePaneInstance(this.getLayout(), paneId)?.instanceId;
  }

  resolvePaneSettings(paneId: string): ResolvedRegistryPaneSettings | null {
    return resolveRegistryPaneSettings({
      config: this.getConfig(),
      getConfigState: (pluginId, key) => this.getConfigState(pluginId, key),
      getPaneRuntimeState: this.getPaneRuntimeState,
      layout: this.getLayout(),
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
    await this.applyPaneSettingValue(paneId, quickSetting.field, quickSetting.nextValue);
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

  /**
   * The plugin that owns this pane type when it is switched off. A pane of a
   * switched-off plugin stays hidden, so callers offer to turn it on instead
   * of adding one.
   */
  getDisabledPaneOwner(
    paneType: string,
    disabledPlugins: readonly string[] = this.getConfig().disabledPlugins,
  ): DisabledPluginOwner | null {
    return this.disabledOwner(this.getPanePluginId(paneType), disabledPlugins);
  }

  /** The same for a template: its own plugin, or the one owning the pane it opens. */
  getDisabledPaneTemplateOwner(
    templateId: string,
    disabledPlugins: readonly string[] = this.getConfig().disabledPlugins,
  ): DisabledPluginOwner | null {
    const paneType = this.paneTemplates.get(templateId)?.paneId;
    return this.disabledOwner(this.getPaneTemplatePluginId(templateId), disabledPlugins)
      ?? (paneType ? this.getDisabledPaneOwner(paneType, disabledPlugins) : null);
  }

  private disabledOwner(pluginId: string | undefined, disabledPlugins: readonly string[]): DisabledPluginOwner | null {
    if (!pluginId || !disabledPlugins.includes(pluginId)) return null;
    return { id: pluginId, name: this.plugins.get(pluginId)?.name ?? pluginId };
  }

  getBrokerPluginId(brokerType: string): string | undefined {
    return this.contributions.brokersMap.owners.get(brokerType);
  }

  getShortcutPluginId(shortcutId: string): string | undefined {
    return this.contributions.shortcutsMap.owners.get(shortcutId);
  }

  getTickerResearchTabPluginId(tabId: string): string | undefined {
    return this.contributions.tickerResearchTabsMap.owners.get(tabId);
  }

  /** @deprecated Check the layout's `floating` entries instead. */
  isPaneFloating(paneId: string): boolean {
    try {
      const target = this.resolvePaneTarget(paneId);
      return !!target && this.getLayout().floating.some((entry) => entry.instanceId === target);
    } catch {
      return false;
    }
  }

  /**
   * The state parts of a plugin's context. `namespaceKey` is the plugin's id,
   * or the namespace a composed module keeps; both resolve the way a render
   * context's id does.
   */
  private createNamespacedContext(namespaceKey: string): NamespacedPluginContext {
    const stateId = this.stateNamespace(namespaceKey);
    return {
      persistence: createPluginPersistence(
        this.persistence.pluginState,
        this.persistence.resources,
        `plugin:${stateId}`,
        stateId,
      ),
      resume: createPluginResumeState({
        pluginId: stateId,
        getResumeState: (key, version) => this.getResumeState(namespaceKey, key, version),
        setResumeState: (key, value, version) => this.setResumeState(namespaceKey, key, value, version),
        deleteResumeState: (key) => this.deleteResumeState(namespaceKey, key),
        getPaneRuntimeState: (paneId) => this.getPaneRuntimeState(paneId),
        updatePaneRuntimeState: (paneId, patch) => this.updatePaneRuntimeState(paneId, patch),
      }),
      teamState: createPluginTeamState(stateId),
      configState: {
        get: (key) => this.getConfigState(namespaceKey, key),
        set: (key, value) => this.setConfigState(namespaceKey, key, value),
        delete: (key) => this.deleteConfigState(namespaceKey, key),
        keys: () => this.getConfigStateKeys(namespaceKey),
      },
    };
  }

  private createContext(pluginId: string): GloomPluginContext {
    const contributions = this.contributions;
    const items = contributions.getOrCreatePluginItems(pluginId);
    return bindPluginContextNamespaces({
      registerPane: (pane) => contributions.registerPane(pluginId, pane),
      registerPaneTemplate: (template) => contributions.registerPaneTemplate(pluginId, template, true),
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
        const dispose = this.watchNewsQuery(query, listener);
        items.newsQueryWatchDisposers.push(dispose);
        return dispose;
      },
      getData: (ticker) => this.getData(ticker),
      getTicker: (symbol) => this.getTicker(symbol),
      getConfig: () => this.getConfig(),
      getPaneDef: (paneId) => contributions.panesMap.get(paneId),
      marketData: this.marketData,
      connectionHealth: this.connectionHealth,
      tickerRepository: this.tickerRepository,
      ...this.createNamespacedContext(pluginId),
      log: debugLog.createLogger(pluginId),
      paneSettings: createPluginPaneSettingsState({
        getLayout: () => this.getLayout(),
        updateLayout: (layout) => this.updateLayout(layout),
        resolvePaneTarget: (paneId) => this.resolvePaneTarget(paneId),
      }),
      createBrokerInstance: (brokerType, label, values) => this.createBrokerInstance(brokerType, label, values),
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
      focusPane: (paneId) => this.focusPane(paneId),
      pinTicker: this.pinTicker,
      navigateTicker: this.navigateTicker,
      openPaneSettings: this.openPaneSettings,
      sharePane: this.sharePane,
      on: (event, handler) => {
        const dispose = this.events.on(event, handler);
        items.eventDisposers.push(dispose);
        return dispose;
      },
      // Every plugin event is also a host event; TypeScript cannot see that through the generic key.
      emit: (event, payload) => this.events.emit(event, payload as HostEvents[typeof event]),
      notify: (notification) => this.notify(notification),
    }, (stateId) => this.createNamespacedContext(stateId));
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

      this.slots.register(plugin, (renderer) => withPluginRender(this.stateNamespace(plugin.id), this, renderer));

      const setupCommand = createPluginSetupCommand(plugin, {
        getValues: () => this.getConfig().pluginConfig[this.stateNamespace(plugin.id)] ?? {},
        setValues: (values) => this.setConfigStates(plugin.id, values),
        notify: (body, type) => this.notify({ body, type }),
      });
      if (setupCommand) this.contributions.registerCommand(plugin.id, setupCommand);

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
