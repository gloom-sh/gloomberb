import type { ReactNode } from "react";
import type { PluginCapability } from "../capabilities";
import type { CliGlobalOptions } from "../cli/options";
import type { CliResult, CliResultRenderOptions } from "../cli/result";
import type { SeriesDefinition } from "../series/types";
import type { PluginLogger } from "../utils/debug-log";
import type { BrokerAdapter } from "./broker";
import type { AppConfig } from "./config";
import type { TickerFinancials } from "./financials";
import type { GloomPluginContext } from "./plugin-context";
import type { PaneTemplateDef } from "./plugin-pane-templates";
import type { PaneDef } from "./plugin-panes";
import type { TickerRecord } from "./ticker";

/**
 * Named render slots. The host renders only `status:widget`; the other names
 * are never drawn and are kept so existing plugins still type-check.
 */
export interface GloomSlots {
  /** @deprecated Never rendered. Use `ctx.registerTickerResearchTab`. */
  "ticker-research:tab": { ticker: TickerRecord; financials: TickerFinancials | null };
  /** @deprecated Never rendered. Use `ctx.registerTickerResearchTab`. */
  "ticker-research:section": { ticker: TickerRecord; financials: TickerFinancials | null };
  /** @deprecated Never rendered. Use `ctx.registerColumn`. */
  "list:column": { ticker: TickerRecord; financials: TickerFinancials | null };
  /** @deprecated Never rendered. Use `ctx.registerCommandBarSearchProvider`. */
  "command:extra": { query: string };
  /** @deprecated Never rendered. Use `ctx.registerCommand`. */
  "command:preset": Record<string, never>;
  "status:widget": Record<string, never>;
  /** @deprecated Never rendered. Declare settings with `configSchema`. */
  "config:section": Record<string, never>;
  /** @deprecated Never called. Subscribe with `ctx.on("ticker:refreshed")`. */
  "data:post-refresh": { ticker: string; financials: TickerFinancials };
  /** @deprecated Never called. Contribute data with an `asset-data` capability. */
  "data:enricher": { ticker: TickerRecord };
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

interface CliCommandHelpOption {
  /** Flag spelling with its value, e.g. `--range <range>`. */
  flags: string;
  description: string;
}

interface CliCommandHelp {
  /** Heading `gloom help` lists the command under. Plugin commands without one share a plugin heading. */
  group?: string;
  /** Invocations without the leading `gloomberb`, e.g. `quote <symbol...>`. */
  usage?: string[];
  options?: CliCommandHelpOption[];
  /** Complete invocations without the leading `gloomberb`. */
  examples?: string[];
  /** Extra blocks shown only in the command's own help (`gloom help <command>`). */
  sections?: CliCommandHelpSection[];
}

interface CliLaunchEnvironment {
  terminalWidth: number;
  terminalHeight: number;
}

/**
 * The resume state the app writes at exit and reads at startup. A plugin whose
 * CLI command launches the UI seeds it so the pane opens on what was asked for
 * rather than on what the last session left behind.
 */
export type { AppSessionSnapshot } from "../core/state/session-persistence";

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
    renderStats: typeof import("../utils/cli-output").renderStats;
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

/**
 * One setting a plugin needs from the user before it is useful, such as an API
 * key. Values are stored in the plugin's `configState` under `key`.
 */
export interface PluginConfigField {
  key: string;
  label: string;
  type?: "text" | "password" | "number" | "select";
  /** Shown under the field. Say where to get the value, not what the plugin does. */
  description?: string;
  placeholder?: string;
  defaultValue?: string;
  /** The plugin counts as "needs setup" while a required field is empty. Default true. */
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
}

export interface GloomPlugin {
  id: string;
  /**
   * Where this plugin's saved state lives: its `pluginConfig` entry, its resume
   * state, and the per-pane state its panes write. Defaults to `id`.
   *
   * Set it when a plugin is renamed, or moves out of this repository under a
   * new id, so the threads, tabs, and defaults a user already has stay theirs.
   * Everything else (the toggle, the marketplace, seeding) keys off `id`.
   */
  stateId?: string;
  name: string;
  version: string;
  description?: string;
  toggleable?: boolean;
  order?: number;
  cliCommands?: CliCommandDef[];
  /** Defaults to every target when omitted. */
  targets?: readonly PluginTarget[];
  /**
   * Third-party hosts the plugin fetches from, as bare domains
   * (`"api.example.com"`; a parent domain also covers its subdomains).
   *
   * Terminal and desktop reach anything, so this is informational there and
   * is what the plugin directory shows under "Network access". On the web the
   * browser cannot call a host that sends no CORS headers, so the hosted app
   * proxies exactly the hosts the bundled plugins declare here and refuses
   * the rest. A plugin that leaves a host out works on the desktop and fails
   * on the web.
   *
   * Hosts reached by a plugin's dependencies count too: declare every host
   * contacted on the plugin's behalf, including authentication endpoints.
   */
  hosts?: readonly string[];
  /** Shown in the marketplace pane and on the website. */
  homepage?: string;
  /**
   * Settings the plugin cannot work without. Declaring them gives the plugin a
   * "Set up <name>" command, a form the marketplace opens from its `s` key, and
   * a `needs setup` status until every required field has a value. Read the
   * values back with `ctx.configState.get(key)`.
   */
  configSchema?: PluginConfigField[];
  /**
   * Overrides the default readiness rule (every required `configSchema` field
   * has a value) for plugins whose setup is not a plain form, such as a broker
   * login or a file that must exist.
   */
  isConfigured?(values: Record<string, unknown>): boolean;

  setup?(ctx: GloomPluginContext): void | Promise<void>;
  dispose?(): void;

  panes?: PaneDef[];
  paneTemplates?: PaneTemplateDef[];
  broker?: BrokerAdapter;
  capabilities?: PluginCapability[];
  /**
   * Series the plugin adds to the data catalog, chartable against any other
   * catalog entry. A definition that fails validation is skipped and logged;
   * `ctx.registerSeries` adds series later and throws instead.
   */
  series?: readonly SeriesDefinition[];
  slots?: Partial<{
    [K in keyof GloomSlots]: (props: GloomSlots[K]) => ReactNode;
  }>;
}
