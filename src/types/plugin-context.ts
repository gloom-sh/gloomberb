import type { PluginCapability } from "../capabilities";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import type { ConnectionHealthRegistry } from "../core/connection-health";
import type { PluginEvents } from "../plugins/event-bus";
import type { SeriesDefinition } from "../series/types";
import type { SyncContributor, SyncTransport } from "../sync/types";
import type { PluginLogger } from "../utils/debug-log";
import type { BrokerAdapter } from "./broker";
import type { BrokerInstanceConfig } from "./config";
import type { DataProvider } from "./data-provider";
import type { TickerFinancials } from "./financials";
import type { BrokerContractRef, TickerListingRef } from "./instrument";
import type { CommandBarSearchProvider, CommandDef, KeyboardShortcut } from "./plugin-commands";
import type {
  ContextMenuProviderDef,
  CustomColumnDef,
  TickerAction,
  TickerResearchTabDef,
} from "./plugin-contributions";
import type { AppNotificationDelivery, AppNotificationRequest } from "./plugin-notifications";
import type { PaneTemplateCreateOptions, PaneTemplateDef } from "./plugin-pane-templates";
import type { PaneDef } from "./plugin-panes";
import type {
  PluginConfigState,
  PluginPaneSettingsState,
  PluginPersistence,
  PluginResumeState,
  PluginTeamState,
} from "./plugin-state";
import type { TickerRecord } from "./ticker";

export interface BrokerInstanceUpdateOptions {
  label?: string;
  enabled?: boolean;
  replaceConfig?: boolean;
  /** Keep this connection's data on this device, out of Gloom Cloud sync (`BrokerInstanceConfig.localOnly`). */
  localOnly?: boolean;
}

export interface BrokerInstanceCreateOptions {
  /** Keep the new connection's data on this device from the start, before its first import. */
  localOnly?: boolean;
}

export interface PinTickerOptions {
  floating?: boolean;
  paneType?: string;
  forceNewPane?: boolean;
  /** Preserve a contract explicitly selected from instrument search. */
  instrument?: BrokerContractRef | null;
  listing?: TickerListingRef;
  /** Select this research tab once the requested ticker has resolved. */
  tabId?: string;
  /** Merge this state into the resolved research pane when selecting `tabId`. */
  tabState?: Record<string, unknown>;
}

export interface GloomPluginContext {
  registerPane(pane: PaneDef): void;
  /** Returns a disposer; templates added after setup (team views) use it. */
  registerPaneTemplate(template: PaneTemplateDef): () => void;
  registerCommand(command: CommandDef): void;
  registerCommandBarSearchProvider(provider: CommandBarSearchProvider): () => void;
  registerColumn(column: CustomColumnDef): void;
  registerBroker(broker: BrokerAdapter): void;
  registerCapability(capability: PluginCapability): void;
  registerTickerResearchTab(tab: TickerResearchTabDef): void;
  registerShortcut(shortcut: KeyboardShortcut): void;
  registerTickerAction(action: TickerAction): void;
  registerContextMenuProvider(provider: ContextMenuProviderDef): void;
  /**
   * Adds a series to the data catalog and the chart composer, at any time
   * after setup starts (after loading a list, say). Throws when the definition
   * is invalid or its id is taken; the returned function removes it again.
   */
  registerSeries(series: SeriesDefinition): () => void;
  registerSyncContributor(contributor: SyncContributor): () => void;
  registerSyncTransport(transport: SyncTransport): () => void;
  watchNewsQuery?(
    query: import("./news-source").NewsQuery,
    listener: (state: import("./news-source").NewsQueryState) => void,
  ): () => void;

  getData(ticker: string): TickerFinancials | null;
  getTicker(ticker: string): TickerRecord | null;
  getConfig(): import("./config").AppConfig;
  /** Resolve a broker registered by another plugin, without connecting it. */
  getBrokerAdapter?(brokerType: string): BrokerAdapter | null;
  getPaneDef(paneId: string): PaneDef | undefined;

  readonly marketData: DataProvider;
  readonly connectionHealth: ConnectionHealthRegistry;
  readonly tickerRepository: AppTickerRepositoryPort;
  readonly persistence: PluginPersistence;
  readonly log: PluginLogger;
  readonly resume: PluginResumeState;
  readonly configState: PluginConfigState;
  readonly paneSettings: PluginPaneSettingsState;
  readonly teamState: PluginTeamState;
  /**
   * Where the plugin runs: `app` in the terminal or desktop app, `command`
   * while one CLI command (`gloom doctor`, `gloom fn`) loads the plugins and
   * exits. A command keeps nothing running and shows no notification, so a
   * plugin starts no pollers, streams or timers there: an alert one fired
   * would reach no one, and the command could not save that it went off.
   * Absent means `app`.
   */
  readonly runtime?: "app" | "command";

  createBrokerInstance(brokerType: string, label: string, values: Record<string, unknown>, options?: BrokerInstanceCreateOptions): Promise<BrokerInstanceConfig>;
  updateBrokerInstance(instanceId: string, values: Record<string, unknown>, options?: BrokerInstanceUpdateOptions): Promise<void>;
  syncBrokerInstance(instanceId: string): Promise<void>;
  removeBrokerInstance(instanceId: string): Promise<void>;

  selectTicker(symbol: string, paneId?: string): void;
  /** Focus the leftmost or rightmost docked pane. */
  switchPanel(panel: "left" | "right"): void;
  switchTab(tabId: string, paneId?: string): void;
  openCommandBar(query?: string): void;
  showPane(paneId: string): void;
  createPaneFromTemplate(templateId: string, options?: PaneTemplateCreateOptions): void;
  hidePane(paneId: string): void;
  focusPane(paneId: string): void;
  pinTicker(symbol: string, options?: PinTickerOptions): void;
  navigateTicker(symbol: string, options?: { sourcePaneId?: string | null }): void;
  openPaneSettings(paneId?: string): void;
  /** Shares a pane instance (the focused pane when omitted): copies a live link to it. */
  sharePane(paneId?: string): void;

  on<K extends keyof PluginEvents>(event: K, handler: (payload: PluginEvents[K]) => void): () => void;
  emit<K extends keyof PluginEvents>(event: K, payload: PluginEvents[K]): void;

  notify(notification: AppNotificationRequest): AppNotificationDelivery | void;
}
