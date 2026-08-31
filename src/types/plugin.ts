import type { ReactNode } from "react";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import type { ConnectionHealthRegistry } from "../core/connection-health";
import type { PluginEvents } from "../plugins/event-bus";
import type { PluginLogger } from "../utils/debug-log";
import type { BrokerAdapter } from "./broker";
import type { PluginCapability } from "../capabilities";
import type { CliGlobalOptions } from "../cli/options";
import type { CliResult, CliResultRenderOptions } from "../cli/result";
import type { ContextMenuContext, ContextMenuItem } from "./context-menu";
import type {
  AppConfig,
  BrokerInstanceConfig,
  ColumnConfig,
  LayoutConfig,
  PaneBinding,
  PaneInstanceConfig,
} from "./config";
import type { DataProvider } from "./data-provider";
import type { TickerFinancials } from "./financials";
import type { CachePolicy, PersistedResourceValue } from "./persistence";
import type { TickerRecord } from "./ticker";
import type { InstrumentSearchResult } from "./instrument";
import type { SyncContributor, SyncTransport } from "../sync/types";

export interface GloomSlots {
  "ticker-research:tab": { ticker: TickerRecord; financials: TickerFinancials | null };
  "ticker-research:section": { ticker: TickerRecord; financials: TickerFinancials | null };
  "list:column": { ticker: TickerRecord; financials: TickerFinancials | null };
  "command:extra": { query: string };
  "command:preset": Record<string, never>;
  "status:widget": Record<string, never>;
  "config:section": Record<string, never>;
  "data:post-refresh": { ticker: string; financials: TickerFinancials };
  "data:enricher": { ticker: TickerRecord };
}

export interface PaneProps {
  paneId: string;
  paneType: string;
  focused: boolean;
  width: number;
  height: number;
  close?: () => void;
}

export type PaneSharePrivateFields = true | readonly string[];

export interface PanePortableShareDef {
  /** Fields excluded before pane configuration or state leaves the device. */
  private?: {
    title?: boolean;
    params?: PaneSharePrivateFields;
    settings?: PaneSharePrivateFields;
    state?: PaneSharePrivateFields;
  };
}

export interface PaneDef {
  id: string;
  name: string;
  icon?: string;
  component: (props: PaneProps) => ReactNode;
  defaultPosition: "left" | "right";
  defaultWidth?: string;
  defaultFloatingSize?: { width: number; height: number };
  defaultMode?: "docked" | "floating";
  /** Pane publishes its selected symbol as pane-state `cursorSymbol`, so ticker panes can follow it. */
  tickerSource?: boolean;
  /** Add an Excel-compatible CSV action for the pane's single active DataTable. */
  tableExport?: true;
  settings?: PaneSettingsDef | ((context: PaneSettingsContext) => PaneSettingsDef | null);
  /** Portable sharing is public by default; list the few pane-owned fields that must remain local. */
  portableShare?: PanePortableShareDef;
  /** Compact controls surfaced next to the pane title. Toggle keys reference toggle fields in settings. */
  quickSettings?: readonly PaneQuickSettingDef[];
}

export interface PaneQuickSettingDef {
  type: "toggle";
  key: string;
  icon: "zap";
  label?: string;
}

export interface PaneSettingsContext {
  config: AppConfig;
  layout: LayoutConfig;
  paneId: string;
  paneType: string;
  pane: PaneInstanceConfig;
  settings: Record<string, unknown>;
  paneState: Record<string, unknown>;
  activeTicker: string | null;
  activeCollectionId: string | null;
}

export interface PaneSettingOption {
  value: string;
  label: string;
  description?: string;
}

interface PaneSettingFieldBase {
  key: string;
  label: string;
  description?: string;
  storage?: "pane" | "plugin";
  /** Keys in the same storage scope that should be reset when this value changes. */
  clearOnChange?: string[];
}

interface PaneSettingToggleField extends PaneSettingFieldBase {
  type: "toggle";
}

export interface PaneSettingTextField extends PaneSettingFieldBase {
  type: "text";
  placeholder?: string;
}

interface PaneSettingSelectField extends PaneSettingFieldBase {
  type: "select";
  options: PaneSettingOption[];
}

interface PaneSettingMultiSelectField extends PaneSettingFieldBase {
  type: "multi-select";
  options: PaneSettingOption[];
}

interface PaneSettingOrderedMultiSelectField extends PaneSettingFieldBase {
  type: "ordered-multi-select";
  options: PaneSettingOption[];
}

export interface PaneSettingActionContext extends PaneSettingsContext {
  surface: "pane-dialog" | "command-bar";
  close(): void;
  openCommandBar(query?: string): void;
  notify(notification: AppNotificationRequest): void;
}

export type PaneSettingActionHandler = (
  context: PaneSettingActionContext,
) => void | Promise<void>;

export type PaneSettingActionField = Omit<PaneSettingFieldBase, "storage" | "clearOnChange"> & {
  type: "action";
  actionId: string;
  actionLabel?: string;
  disabled?: boolean;
  action: PaneSettingActionHandler;
};

export type PaneSettingField =
  | PaneSettingToggleField
  | PaneSettingTextField
  | PaneSettingSelectField
  | PaneSettingMultiSelectField
  | PaneSettingOrderedMultiSelectField
  | PaneSettingActionField;

export interface PaneSettingsDef {
  title?: string;
  values?: Record<string, unknown>;
  fields: PaneSettingField[];
  applyValue?: (
    settings: Record<string, unknown>,
    field: PaneSettingField,
    value: unknown,
    context: PaneSettingsContext,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface PaneTemplateContext {
  config: AppConfig;
  layout: LayoutConfig;
  focusedPaneId: string | null;
  activeTicker: string | null;
  activeCollectionId: string | null;
}

interface PaneTemplateShortcut {
  prefix: string;
  argPlaceholder?: string;
  argKind?: "text" | "ticker" | "ticker-list";
  argOptional?: boolean;
}

export interface PaneTemplateCreateOptions {
  arg?: string;
  values?: Record<string, string>;
  symbol?: string | null;
  symbols?: string[] | null;
  ticker?: TickerRecord | null;
  searchResult?: InstrumentSearchResult | null;
  /** Template-owned, validated data restored from a public pane share. */
  shareData?: unknown;
}

export interface PaneTemplateInstanceConfig {
  instanceId?: string;
  title?: string;
  binding?: PaneBinding;
  params?: Record<string, string>;
  settings?: Record<string, unknown>;
  placement?: "default" | "docked" | "floating";
  relativeToPaneId?: string;
  relativePosition?: "left" | "right" | "above" | "below";
}

export interface PaneTemplatePublicShareContext {
  pane: PaneInstanceConfig;
  paneState: Record<string, unknown>;
}

export interface PaneTemplatePublicShareSnapshot {
  title: string;
  description?: string;
  data: Record<string, unknown>;
}

export interface PaneTemplatePublicShareDef {
  serialize(context: PaneTemplatePublicShareContext): PaneTemplatePublicShareSnapshot | null;
  restore(data: Record<string, unknown>): PaneTemplateCreateOptions | null;
}

export interface PaneTemplateDef {
  id: string;
  paneId: string;
  label: string;
  description: string;
  keywords?: string[];
  shortcut?: PaneTemplateShortcut;
  wizard?: WizardStep[];
  canCreate?: (context: PaneTemplateContext, options?: PaneTemplateCreateOptions) => boolean;
  createInstance?: (
    context: PaneTemplateContext,
    options?: PaneTemplateCreateOptions,
  ) => PaneTemplateInstanceConfig | null | Promise<PaneTemplateInstanceConfig | null>;
  /** Legacy v1 restoration or an explicit transformed snapshot; normal pane shares use portableShare. */
  publicShare?: PaneTemplatePublicShareDef;
}

export interface WizardStep {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  required?: boolean;
  type?: "text" | "password" | "info" | "select" | "number" | "textarea";
  options?: Array<{ label: string; value: string }>;
  dependsOn?: { key: string; value: string };
  /** Later wizard values to clear when this selection changes from its default. */
  clearOnChange?: string[];
  body?: string[];
}

export interface CommandShortcutArgContext {
  activeTicker: string | null;
}

interface CommandShortcutArgDef {
  placeholder?: string;
  kind?: "text" | "ticker" | "ticker-list";
  parse?: (
    arg: string,
    context: CommandShortcutArgContext,
  ) => Record<string, string>;
}

export interface CommandResultDef {
  id: string;
  label: string;
  detail?: string;
  category?: string;
  right?: string;
  keywords?: string[];
  current?: boolean;
  disabled?: boolean;
  execute: () => void | Promise<void>;
}

interface CliHelpColumn {
  header: string;
  align?: "left" | "right" | "center";
  width?: number;
}

interface CliCommandHelpSection {
  title: string;
  columns?: CliHelpColumn[];
  rows?: string[][];
  lines?: string[];
}

interface CliCommandHelp {
  usage?: string[];
  sections?: CliCommandHelpSection[];
}

interface CliLaunchEnvironment {
  terminalWidth: number;
  terminalHeight: number;
}

export interface CliLaunchConfigResult<TLaunchState = unknown> {
  config: AppConfig;
  launchState?: TLaunchState;
}

export interface CliLaunchRequest<TLaunchState = unknown> {
  applyConfig(config: AppConfig, env: CliLaunchEnvironment): CliLaunchConfigResult<TLaunchState>;
  applySessionSnapshot?(
    config: AppConfig,
    snapshot: import("../core/state/session-persistence").AppSessionSnapshot | null,
    launchState: TLaunchState | undefined,
  ): import("../core/state/session-persistence").AppSessionSnapshot;
}

export type CliDispatchResult =
  | { kind: "handled" }
  | { kind: "launch-ui"; request: CliLaunchRequest }
  | { kind: "unhandled" };

export interface CliCommandContext {
  initConfigData(): Promise<import("../cli/types").ConfigContext>;
  initMarketData(): Promise<import("../cli/types").MarketContext>;
  initServices(): Promise<import("../cli/types").CliServicesContext>;
  cliOptions: CliGlobalOptions;
  plugins: GloomPlugin[];
  fail(message: string, details?: string): never;
  closeAndFail(
    persistence: import("../data/app-persistence").AppPersistence,
    message: string,
    details?: string,
  ): never;
  output: {
    cliStyles: typeof import("../utils/cli-output").cliStyles;
    colorBySign: typeof import("../utils/cli-output").colorBySign;
    renderSection: typeof import("../utils/cli-output").renderSection;
    renderStat: typeof import("../utils/cli-output").renderStat;
    renderTable: typeof import("../utils/cli-output").renderTable;
  };
  printResult<T, Row extends Record<string, unknown> = Record<string, unknown>>(
    result: CliResult<T>,
    options?: CliResultRenderOptions<T, Row>,
  ): void;
  log: PluginLogger;
}

export interface CliCommandDef {
  name: string;
  aliases?: string[];
  description: string;
  help?: CliCommandHelp;
  execute(args: string[], ctx: CliCommandContext): void | CliDispatchResult | Promise<void | CliDispatchResult>;
}

export interface CommandDef {
  id: string;
  label: string;
  keywords: string[];
  shortcut?: string;
  shortcutArg?: CommandShortcutArgDef;
  buildResults?: (arg: string) => CommandResultDef[];
  execute: (values?: Record<string, string>) => void | Promise<void>;
  category: "navigation" | "data" | "portfolio" | "config";
  description?: string;
  wizard?: WizardStep[];
  confirm?: CommandConfirmDef | ((context: CommandConfirmContext) => CommandConfirmDef | null);
  wizardLayout?: "steps" | "form";
  hidden?: () => boolean;
}

interface CommandConfirmContext {
  config: AppConfig;
  layout: LayoutConfig;
  activeTicker: string | null;
  activeCollectionId: string | null;
}

interface CommandConfirmDef {
  title: string;
  body: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

export interface CustomColumnDef extends ColumnConfig {
  render: (ticker: TickerRecord, financials: TickerFinancials | null) => string;
}

export interface TickerResearchTabProps {
  width: number;
  height: number;
  focused: boolean;
  onCapture: (capturing: boolean) => void;
}

interface TickerResearchTabVisibilityContext {
  config: AppConfig;
  ticker: TickerRecord | null;
  financials: TickerFinancials | null | undefined;
  hasOptionsChain: boolean;
}

export interface TickerResearchTabDef {
  id: string;
  name: string;
  order: number;
  component: (props: TickerResearchTabProps) => ReactNode;
  isVisible?: (context: TickerResearchTabVisibilityContext) => boolean;
}

export interface KeyboardShortcut {
  id: string;
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  description: string;
  execute: () => void;
}

export interface TickerAction {
  id: string;
  label: string;
  keywords: string[];
  filter?: (ticker: TickerRecord) => boolean;
  execute: (ticker: TickerRecord, financials: TickerFinancials | null) => void | Promise<void>;
}

export interface ContextMenuProviderDef {
  id: string;
  order?: number;
  contexts?: ContextMenuContext["kind"][];
  getItems(context: ContextMenuContext): ContextMenuItem[] | null | undefined;
}

export interface PluginPersistence {
  getState<T = unknown>(key: string, options?: { schemaVersion?: number }): T | null;
  setState(key: string, value: unknown, options?: { schemaVersion?: number }): void;
  deleteState(key: string): void;
  getResource<T = unknown>(
    kind: string,
    key: string,
    options?: { sourceKey?: string; schemaVersion?: number; allowExpired?: boolean },
  ): PersistedResourceValue<T> | null;
  setResource<T = unknown>(
    kind: string,
    key: string,
    value: T,
    options: {
      cachePolicy: CachePolicy;
      sourceKey?: string;
      schemaVersion?: number;
      provenance?: unknown;
    },
  ): PersistedResourceValue<T>;
  deleteResource(kind: string, key: string, options?: { sourceKey?: string }): void;
}

export interface PluginResumeState {
  getState<T = unknown>(key: string, options?: { schemaVersion?: number }): T | null;
  setState(key: string, value: unknown, options?: { schemaVersion?: number }): void;
  deleteState(key: string): void;
  getPaneState<T = unknown>(paneId: string, key: string): T | null;
  setPaneState(paneId: string, key: string, value: unknown): void;
  deletePaneState(paneId: string, key: string): void;
}

export interface PluginConfigState {
  get<T = unknown>(key: string): T | null;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): string[];
}

export interface PluginPaneSettingsState {
  get<T = unknown>(paneId: string, key: string): T | null;
  set(paneId: string, key: string, value: unknown): Promise<void>;
  delete(paneId: string, key: string): Promise<void>;
}

export type AppNotificationType = "info" | "success" | "error";
type AppDesktopNotificationMode = "never" | "when-inactive" | "always";

export interface AppNotificationDelivery {
  toastVisible: boolean;
  desktopRequested: boolean;
}

export interface AppNotificationRequest {
  title?: string;
  body: string;
  subtitle?: string;
  duration?: number;
  type?: AppNotificationType;
  toast?: boolean;
  /** If true, in-app toast stays visible until user dismisses it */
  persistent?: boolean;
  desktop?: AppDesktopNotificationMode;
  /** macOS sound name (e.g., "Glass", "Ping", "Hero"). Ignored on other platforms. */
  sound?: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface BrokerInstanceUpdateOptions {
  label?: string;
  enabled?: boolean;
  replaceConfig?: boolean;
}

export interface PinTickerOptions {
  floating?: boolean;
  paneType?: string;
  forceNewPane?: boolean;
}

export interface GloomPluginContext {
  registerPane(pane: PaneDef): void;
  registerPaneTemplate(template: PaneTemplateDef): void;
  registerCommand(command: CommandDef): void;
  registerColumn(column: CustomColumnDef): void;
  registerBroker(broker: BrokerAdapter): void;
  registerCapability(capability: PluginCapability): void;
  registerTickerResearchTab(tab: TickerResearchTabDef): void;
  registerShortcut(shortcut: KeyboardShortcut): void;
  registerTickerAction(action: TickerAction): void;
  registerContextMenuProvider(provider: ContextMenuProviderDef): void;
  registerSyncContributor(contributor: SyncContributor): () => void;
  registerSyncTransport(transport: SyncTransport): () => void;
  watchNewsQuery?(
    query: import("./news-source").NewsQuery,
    listener: (state: import("./news-source").NewsQueryState) => void,
  ): () => void;

  getData(ticker: string): TickerFinancials | null;
  getTicker(ticker: string): TickerRecord | null;
  getConfig(): import("./config").AppConfig;
  getPaneDef(paneId: string): PaneDef | undefined;

  readonly marketData: DataProvider;
  readonly connectionHealth: ConnectionHealthRegistry;
  readonly tickerRepository: AppTickerRepositoryPort;
  readonly persistence: PluginPersistence;
  readonly log: PluginLogger;
  readonly resume: PluginResumeState;
  readonly configState: PluginConfigState;
  readonly paneSettings: PluginPaneSettingsState;

  createBrokerInstance(brokerType: string, label: string, values: Record<string, unknown>): Promise<BrokerInstanceConfig>;
  updateBrokerInstance(instanceId: string, values: Record<string, unknown>, options?: BrokerInstanceUpdateOptions): Promise<void>;
  syncBrokerInstance(instanceId: string): Promise<void>;
  removeBrokerInstance(instanceId: string): Promise<void>;

  selectTicker(symbol: string, paneId?: string): void;
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

  on<K extends keyof PluginEvents>(event: K, handler: (payload: PluginEvents[K]) => void): () => void;
  emit<K extends keyof PluginEvents>(event: K, payload: PluginEvents[K]): void;

  notify(notification: AppNotificationRequest): AppNotificationDelivery | void;
}

/**
 * Where a plugin can actually run.
 *
 * `cli` and `tui` run in Bun and may use Node APIs. `desktop` runs in the
 * Electrobun view. `web` runs in the browser at term.gloom.sh, which rules out
 * Node builtins entirely — a plugin opening a TCP socket (IBKR Gateway) can
 * never be web-capable, no matter what it declares.
 *
 * Plugins may declare this, but the registry derives it from a static import
 * scan and overwrites the declaration. Treat an author-supplied value as a hint.
 */
export type PluginTarget = "cli" | "tui" | "desktop" | "web";

export const ALL_PLUGIN_TARGETS: readonly PluginTarget[] = ["cli", "tui", "desktop", "web"];

export interface GloomPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  toggleable?: boolean;
  order?: number;
  cliCommands?: CliCommandDef[];
  /** Defaults to every target when omitted. */
  targets?: readonly PluginTarget[];
  /** Shown in the marketplace pane and on the website. */
  homepage?: string;

  setup?(ctx: GloomPluginContext): void | Promise<void>;
  dispose?(): void;

  panes?: PaneDef[];
  paneTemplates?: PaneTemplateDef[];
  broker?: BrokerAdapter;
  capabilities?: PluginCapability[];
  slots?: Partial<{
    [K in keyof GloomSlots]: (props: GloomSlots[K]) => ReactNode;
  }>;
}
