import type { NewsCapability } from "../../capabilities";
import type { PaneRuntimeState } from "../../core/state/app/state";
import type { LayoutMarketplacePayload } from "../../shares/portable-layout";
import type { AppConfig, BrokerInstanceConfig, LayoutConfig } from "../../types/config";
import type { TickerFinancials } from "../../types/financials";
import type { NewsQuery, NewsQueryState } from "../../types/news-source";
import type {
  AppNotificationDelivery,
  AppNotificationRequest,
  BrokerInstanceUpdateOptions,
  PaneSettingField,
  PaneTemplateCreateOptions,
  PinTickerOptions,
} from "../../types/plugin";
import type { TickerRecord } from "../../types/ticker";

export type WindowEditMode = "move" | "resize";

/**
 * What the app does on behalf of plugins and the host UI. The registry starts
 * with the no-op defaults below; the app, its shell and each window bind the
 * real actions with `PluginRegistry.bindHost` as they mount.
 */
export interface PluginHostActions {
  getTicker(symbol: string): TickerRecord | null;
  getData(symbol: string): TickerFinancials | null;
  getConfig(): AppConfig;
  createBrokerInstance(brokerType: string, label: string, values: Record<string, unknown>): Promise<BrokerInstanceConfig>;
  connectBrokerInstance(instanceId: string): Promise<void>;
  updateBrokerInstance(instanceId: string, values: Record<string, unknown>, options?: BrokerInstanceUpdateOptions): Promise<void>;
  syncBrokerInstance(instanceId: string): Promise<void>;
  removeBrokerInstance(instanceId: string): Promise<void>;

  selectTicker(symbol: string, paneId?: string): void;
  /** Focus the leftmost or rightmost docked pane. */
  switchPanel(panel: "left" | "right"): void;
  switchTab(tabId: string, paneId?: string): void;
  openCommandBar(query?: string): void;
  openPluginCommandWorkflow(commandId: string): void;
  /** Opens one of the app's own forms, such as `new-portfolio`, or Add Broker in the Brokers pane. Not on the plugin API. */
  openBuiltInWorkflow(actionId: string): void;
  /** `options.fieldKey` starts the cursor on that setting, as a setting picked in the command bar does. */
  openPaneSettings(paneId?: string, options?: { fieldKey?: string }): void;
  sharePane(paneId?: string): void;
  openWindowMode(paneId?: string, mode?: WindowEditMode): void;
  /** The shell's fullscreen toggle for a pane; false when there is nothing to fill the window with. */
  togglePaneFullscreen(paneId: string): boolean;
  /** The shell's Move to New Layout for a pane; false when it did nothing. Not on the plugin API. */
  movePaneToNewLayout(paneId: string): boolean;
  /** Returns a pane Move to New Layout moved to where it came from; false when it did nothing. Not on the plugin API. */
  movePaneBack(paneId: string): boolean;
  showPane(paneId: string): void;
  createPaneFromTemplate(templateId: string, options?: PaneTemplateCreateOptions): void;
  createPaneFromTemplateAsync(templateId: string, options?: PaneTemplateCreateOptions): Promise<void>;
  openPortablePaneShareAsync(layout: LayoutMarketplacePayload): Promise<void>;
  hidePane(paneId: string): void;
  focusPane(paneId: string, layout?: LayoutConfig): void;
  pinTicker(symbol: string, options?: PinTickerOptions): void;
  navigateTicker(symbol: string, options?: { sourcePaneId?: string | null }): void;

  getLayout(): LayoutConfig;
  updateLayout(layout: LayoutConfig): void;
  getTermSize(): { width: number; height: number };

  registerNewsCapability(capability: NewsCapability): () => void;
  watchNewsQuery(query: NewsQuery, listener: (state: NewsQueryState) => void): () => void;

  notify(notification: AppNotificationRequest): AppNotificationDelivery | void;
  /** Switches a plugin on or off the way the Plugins pane does. Not on the plugin API. */
  setPluginEnabled(pluginId: string, enabled: boolean): void;
  getPaneRuntimeState(paneId: string): PaneRuntimeState | null;
  updatePaneRuntimeState(paneId: string, patch: Partial<PaneRuntimeState>): void;
  applyPaneSettingValue(paneId: string, field: PaneSettingField, value: unknown): Promise<void>;
  getPluginConfigValue<T = unknown>(pluginId: string, key: string): T | null;
  setPluginConfigValue(pluginId: string, key: string, value: unknown): Promise<void>;
  setPluginConfigValues(pluginId: string, values: Record<string, unknown>): Promise<void>;
  deletePluginConfigValue(pluginId: string, key: string): Promise<void>;
}

/**
 * Stand-ins for actions nothing has bound. Pass `current` so the default
 * plugin config lookup reads whatever config the host binds later.
 */
export function createDefaultHostActions(current?: () => Pick<PluginHostActions, "getConfig">): PluginHostActions {
  const defaults: PluginHostActions = {
    getTicker: () => null,
    getData: () => null,
    getConfig: () => { throw new Error("getConfig is not bound"); },
    createBrokerInstance: async () => { throw new Error("createBrokerInstance is not bound"); },
    connectBrokerInstance: async () => {},
    updateBrokerInstance: async () => {},
    syncBrokerInstance: async () => {},
    removeBrokerInstance: async () => {},
    selectTicker: () => {},
    switchPanel: () => {},
    switchTab: () => {},
    openCommandBar: () => {},
    openPluginCommandWorkflow: () => {},
    openBuiltInWorkflow: () => {},
    openPaneSettings: () => {},
    sharePane: () => {},
    openWindowMode: () => {},
    togglePaneFullscreen: () => false,
    movePaneToNewLayout: () => false,
    movePaneBack: () => false,
    showPane: () => {},
    createPaneFromTemplate: () => {},
    createPaneFromTemplateAsync: async () => {},
    openPortablePaneShareAsync: async () => {},
    hidePane: () => {},
    focusPane: () => {},
    pinTicker: () => {},
    navigateTicker: () => {},
    getLayout: () => ({ dockRoot: null, instances: [], floating: [], detached: [] }),
    updateLayout: () => {},
    getTermSize: () => ({ width: 120, height: 40 }),
    registerNewsCapability: () => () => {},
    watchNewsQuery: () => () => {},
    notify: () => {},
    setPluginEnabled: () => {},
    getPaneRuntimeState: () => null,
    updatePaneRuntimeState: () => {},
    applyPaneSettingValue: async () => {},
    getPluginConfigValue: <T = unknown>(pluginId: string, key: string): T | null => (
      ((current?.() ?? defaults).getConfig().pluginConfig[pluginId]?.[key] as T | undefined) ?? null
    ),
    setPluginConfigValue: async () => {},
    setPluginConfigValues: async () => {},
    deletePluginConfigValue: async () => {},
  };
  return defaults;
}

export const HOST_ACTION_NAMES = Object.keys(createDefaultHostActions()) as ReadonlyArray<keyof PluginHostActions>;

/** The host actions a plugin's panes reach through their render context. */
const PLUGIN_RUNTIME_HOST_ACTIONS = [
  "createBrokerInstance",
  "connectBrokerInstance",
  "updateBrokerInstance",
  "syncBrokerInstance",
  "removeBrokerInstance",
  "pinTicker",
  "navigateTicker",
  "selectTicker",
  "switchTab",
  "switchPanel",
  "openCommandBar",
  "showPane",
  "createPaneFromTemplate",
  "hidePane",
  "focusPane",
  "openPaneSettings",
  "sharePane",
  "openPluginCommandWorkflow",
  "notify",
] as const satisfies ReadonlyArray<keyof PluginHostActions>;

export type PluginRuntimeHostActions = Pick<PluginHostActions, typeof PLUGIN_RUNTIME_HOST_ACTIONS[number]>;

export function pickPluginRuntimeHostActions(actions: PluginHostActions): PluginRuntimeHostActions {
  return Object.fromEntries(
    PLUGIN_RUNTIME_HOST_ACTIONS.map((name) => [name, actions[name]]),
  ) as unknown as PluginRuntimeHostActions;
}

type HostAction<K extends keyof PluginHostActions> = PluginHostActions[K];

/**
 * The registry's old one-slot-per-action API. Reading a slot returns the bound
 * action and assigning one binds it. Kept for one release so code outside this
 * repository that still sets them keeps working.
 */
export interface DeprecatedHostActionSlots {
  /** @deprecated Call `getTicker`; bind it with `bindHost`. */
  getTickerFn: HostAction<"getTicker">;
  /** @deprecated Call `getData`; bind it with `bindHost`. */
  getDataFn: HostAction<"getData">;
  /** @deprecated Call `getConfig`; bind it with `bindHost`. */
  getConfigFn: HostAction<"getConfig">;
  /** @deprecated Call `createBrokerInstance`; bind it with `bindHost`. */
  createBrokerInstanceFn: HostAction<"createBrokerInstance">;
  /** @deprecated Call `connectBrokerInstance`; bind it with `bindHost`. */
  connectBrokerInstanceFn: HostAction<"connectBrokerInstance">;
  /** @deprecated Call `updateBrokerInstance`; bind it with `bindHost`. */
  updateBrokerInstanceFn: HostAction<"updateBrokerInstance">;
  /** @deprecated Call `syncBrokerInstance`; bind it with `bindHost`. */
  syncBrokerInstanceFn: HostAction<"syncBrokerInstance">;
  /** @deprecated Call `removeBrokerInstance`; bind it with `bindHost`. */
  removeBrokerInstanceFn: HostAction<"removeBrokerInstance">;
  /** @deprecated Call `selectTicker`; bind it with `bindHost`. */
  selectTickerFn: HostAction<"selectTicker">;
  /** @deprecated Call `switchPanel`; bind it with `bindHost`. */
  switchPanelFn: HostAction<"switchPanel">;
  /** @deprecated Call `switchTab`; bind it with `bindHost`. */
  switchTabFn: HostAction<"switchTab">;
  /** @deprecated Call `openCommandBar`; bind it with `bindHost`. */
  openCommandBarFn: HostAction<"openCommandBar">;
  /** @deprecated Call `openPluginCommandWorkflow`; bind it with `bindHost`. */
  openPluginCommandWorkflowFn: HostAction<"openPluginCommandWorkflow">;
  /** @deprecated Call `openPaneSettings`; bind it with `bindHost`. */
  openPaneSettingsFn: HostAction<"openPaneSettings">;
  /** @deprecated Call `sharePane`; bind it with `bindHost`. */
  sharePaneFn: HostAction<"sharePane">;
  /** @deprecated Call `openWindowMode`; bind it with `bindHost`. */
  openWindowModeFn: HostAction<"openWindowMode">;
  /** @deprecated Call `togglePaneFullscreen`; bind it with `bindHost`. */
  togglePaneFullscreenFn: HostAction<"togglePaneFullscreen">;
  /** @deprecated Call `showPane`; bind it with `bindHost`. */
  showPaneFn: HostAction<"showPane">;
  /** @deprecated Call `createPaneFromTemplate`; bind it with `bindHost`. */
  createPaneFromTemplateFn: HostAction<"createPaneFromTemplate">;
  /** @deprecated Call `createPaneFromTemplateAsync`; bind it with `bindHost`. */
  createPaneFromTemplateAsyncFn: HostAction<"createPaneFromTemplateAsync">;
  /** @deprecated Call `openPortablePaneShareAsync`; bind it with `bindHost`. */
  openPortablePaneShareAsyncFn: HostAction<"openPortablePaneShareAsync">;
  /** @deprecated Call `hidePane`; bind it with `bindHost`. */
  hidePaneFn: HostAction<"hidePane">;
  /** @deprecated Call `focusPane`; bind it with `bindHost`. */
  focusPaneFn: HostAction<"focusPane">;
  /** @deprecated Call `pinTicker`; bind it with `bindHost`. */
  pinTickerFn: HostAction<"pinTicker">;
  /** @deprecated Call `navigateTicker`; bind it with `bindHost`. */
  navigateTickerFn: HostAction<"navigateTicker">;
  /** @deprecated Call `getLayout`; bind it with `bindHost`. */
  getLayoutFn: HostAction<"getLayout">;
  /** @deprecated Call `updateLayout`; bind it with `bindHost`. */
  updateLayoutFn: HostAction<"updateLayout">;
  /** @deprecated Call `getTermSize`; bind it with `bindHost`. */
  getTermSizeFn: HostAction<"getTermSize">;
  /** @deprecated Call `registerNewsCapability`; bind it with `bindHost`. */
  registerNewsCapabilityFn: HostAction<"registerNewsCapability">;
  /** @deprecated Call `watchNewsQuery`; bind it with `bindHost`. */
  watchNewsQueryFn: HostAction<"watchNewsQuery">;
  /** @deprecated Call `notify`; bind it with `bindHost`. */
  notifyFn: HostAction<"notify">;
  /** @deprecated Call `getPaneRuntimeState`; bind it with `bindHost`. */
  getPaneRuntimeStateFn: HostAction<"getPaneRuntimeState">;
  /** @deprecated Call `updatePaneRuntimeState`; bind it with `bindHost`. */
  updatePaneRuntimeStateFn: HostAction<"updatePaneRuntimeState">;
  /** @deprecated Call `applyPaneSettingValue`; bind it with `bindHost`. */
  applyPaneSettingValueFn: HostAction<"applyPaneSettingValue">;
  /** @deprecated Call `getPluginConfigValue`; bind it with `bindHost`. */
  getPluginConfigValueFn: HostAction<"getPluginConfigValue">;
  /** @deprecated Call `setPluginConfigValue`; bind it with `bindHost`. */
  setPluginConfigValueFn: HostAction<"setPluginConfigValue">;
  /** @deprecated Call `setPluginConfigValues`; bind it with `bindHost`. */
  setPluginConfigValuesFn: HostAction<"setPluginConfigValues">;
  /** @deprecated Call `deletePluginConfigValue`; bind it with `bindHost`. */
  deletePluginConfigValueFn: HostAction<"deletePluginConfigValue">;
}
