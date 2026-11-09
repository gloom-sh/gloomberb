import type { AppConfig, LayoutConfig, PaneBinding, PaneInstanceConfig } from "./config";
import type { HeadlessPaneDefinition, HeadlessPaneFreshness } from "./headless";
import type { BrokerContractRef, InstrumentSearchResult, TickerListingRef } from "./instrument";
import type { WizardStep } from "./plugin-shared";
import type { TickerRecord } from "./ticker";

export interface PaneTemplateContext {
  config: AppConfig;
  layout: LayoutConfig;
  focusedPaneId: string | null;
  activeTicker: string | null;
  activeInstrument?: BrokerContractRef | null;
  activeListing?: TickerListingRef;
  activeCollectionId: string | null;
}

/** One value a shortcut argument accepts: `value` is typed after the prefix, `label` says what it is. */
export interface ShortcutArgOption {
  value: string;
  label: string;
}

/** Why a typed argument opens nothing: the row's text, and the line under it saying what to type instead. */
export interface ShortcutArgError {
  message: string;
  detail?: string;
}

interface PaneTemplateShortcut {
  prefix: string;
  /** Other mnemonics for the same view (FFIP for WIRP). They open it when typed but are not listed as separate rows. */
  aliases?: readonly string[];
  /** Keep this shortcut executable when typed, but omit its pane from command-bar browse rows. Defaults to true. */
  showInBrowse?: boolean;
  /**
   * What the shortcut takes after the prefix. Left out, it takes the argument
   * the template's `headless` definition declares, as `gloom catalog` lists it.
   */
  argPlaceholder?: string;
  argKind?: "text" | "ticker" | "ticker-list";
  /**
   * For a ticker list, entries kept as typed instead of resolved as tickers:
   * CORR keeps map series (`GEO:HORMUZ`) beside its tickers.
   */
  keepArgToken?: (token: string) => boolean;
  argOptional?: boolean;
  /**
   * The argument is a company the function reports on (CDS, TRACE): with
   * none typed, the command bar opens it on the ticker in focus, and with no
   * ticker in focus market-wide. `<ticker> <code>` opens it too.
   */
  focusedIssuer?: boolean;
  /**
   * With no argument typed and none to infer from the active ticker, open
   * the pane without one instead of asking for it (ERN alone is the market
   * board). Without it an optional argument still falls back to the form.
   */
  openWithoutArg?: boolean;
  /**
   * Named values the argument accepts, for an argument mostly drawn from a
   * small set (a statistic, a futures root). The command-bar assistant picks
   * from it instead of guessing the text; the command may accept others too.
   */
  argOptions?: () => readonly ShortcutArgOption[];
  /**
   * Why a typed argument opens nothing, or null when it opens the view:
   * `PF Nope` names no portfolio or watchlist. The command bar shows it in
   * place of the function's row, and the pane does not open for it.
   */
  argError?: (arg: string, context: PaneTemplateContext) => ShortcutArgError | null;
}

export interface PaneTemplateCreateOptions {
  arg?: string;
  values?: Record<string, string>;
  symbol?: string | null;
  symbols?: string[] | null;
  ticker?: TickerRecord | null;
  searchResult?: InstrumentSearchResult | null;
  instrument?: BrokerContractRef | null;
  listing?: TickerListingRef;
  /** Template-owned, validated data restored from a public pane share. */
  shareData?: unknown;
  /**
   * The options a word that names one view of a function presets (`PDUFA`
   * opens CATL with `--type pdufa`, `runway` FA with `--statement liquidity`),
   * applied as `fn` applies them: as settings and as the view state they name.
   */
  preset?: Readonly<Record<string, string>>;
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
  /**
   * False leaves the function out of every list and search of functions
   * (command-bar browse, search and assistant, Help, `gloom catalog` and
   * search, the plugin directory, chat suggestions) while typing its code
   * still opens it, `fn` and `shot` still run it and its help still answers.
   * ATTN until it publishes (attention/listing.ts).
   */
  listed?: boolean;
  /** Template-specific headless model. Takes precedence over the pane-level model. */
  headless?: HeadlessPaneDefinition;
  /**
   * A one-ticker template whose pane also opens on several at once (DVD's
   * ranking): `fn` and `shot` pass a typed list (`shot DVD KO JNJ`) to
   * createInstance as `symbols`. Any other one-ticker template gets the list
   * as it always has, in `symbol` and `arg`.
   */
  opensTickerList?: boolean;
  /**
   * Source and status of the view this template opens, for a template that
   * opens one view of a pane hosting several (Fixed Income's Issuer Debt).
   * Captures and rendered-view reports merge it over the pane's own
   * `reportFreshness`: each field set here wins, the rest are the pane's. So
   * they date the filings on screen, not the issuer's stock quote.
   */
  reportFreshness?: Pick<HeadlessPaneFreshness, "source" | "status" | "basis" | "local">;
  wizard?: WizardStep[];
  canCreate?: (context: PaneTemplateContext, options?: PaneTemplateCreateOptions) => boolean;
  /**
   * Settings shown by catalog discovery without running createInstance. Supply
   * these when opening a pane needs live data or has side effects. An empty
   * object means there are no settings to describe before the pane is opened.
   * When omitted, discovery derives settings from createInstance as before.
   */
  catalogSettings?: Record<string, unknown>;
  createInstance?: (
    context: PaneTemplateContext,
    options?: PaneTemplateCreateOptions,
  ) => PaneTemplateInstanceConfig | null | Promise<PaneTemplateInstanceConfig | null>;
  /** Legacy v1 restoration or an explicit transformed snapshot; normal pane shares use portableShare. */
  publicShare?: PaneTemplatePublicShareDef;
}
