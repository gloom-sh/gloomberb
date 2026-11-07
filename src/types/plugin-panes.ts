import type { ReactNode } from "react";
import type { PaneInstanceConfig } from "./config";
import type { HeadlessPaneArgumentDef, HeadlessPaneDefinition, HeadlessPaneFreshness } from "./headless";
import type { TickerInstrumentKind } from "./instrument";
import type { PaneSettingsContext, PaneSettingsDef } from "./plugin-pane-settings";
import type { PaneLock, PaneReportOptionDef } from "./plugin-reports";
import type { TickerRecord } from "./ticker";

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
  /**
   * Rewrites the instance before it leaves the device, on every publish. The
   * receiver has none of the sender's local ticker records, so anything
   * resolved through them (a listing's venue, for example) must be pinned into
   * the instance here; a layout published to the gallery passes none.
   */
  prepare?(pane: PaneInstanceConfig, context: {
    tickers: ReadonlyMap<string, TickerRecord>;
    /** The moment the pane's layout tab has its crosshair pinned at, so a link opens there. */
    pinnedTime?: number;
  }): PaneInstanceConfig;
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
  /**
   * Pane shows one ticker read through its binding (`usePaneTicker`, `usePaneTickerIdentity`), so
   * its pane menu offers "Link to" each visible list, scanner, and other single-ticker pane, and
   * it then follows that pane's selection. A function decides per instance (a chart with one
   * security, not a comparison). A follower must never write its own `cursorSymbol`: that would
   * win over the binding.
   */
  tickerFollower?: boolean | ((pane: PaneInstanceConfig) => boolean);
  /**
   * A single-ticker pane that keeps its ticker somewhere besides its binding (a chart's series)
   * moves it here when ticker search changes the ticker the pane shows. The host has already set
   * the binding and the title; `previous` is the ticker the pane showed until now.
   */
  retargetTicker?(pane: PaneInstanceConfig, symbol: string, previous: string | null): PaneInstanceConfig;
  /**
   * Instrument kinds this pane has data for, such as `["equity"]` for company
   * data, as a research tab declares them. Bound to a ticker of another known
   * kind (an index, an ETF), the pane says so in place of its data, and `fn`
   * and `shot` answer before loading. Omit when every ticker has it.
   */
  instruments?: readonly TickerInstrumentKind[];
  /**
   * For a pane type that two or more functions open (ERN and EVTS): the settings that say
   * what a window shows, as against how (a range, a toggle, a column choice). Opening a
   * function again focuses a window whose binding, params and settings match what the
   * function opens; a window with a setting of its own that is not listed here is still that
   * window, and one with a listed setting the function does not set belongs to another
   * function and is left alone. Without it, a pane type opened by several functions is
   * matched on its settings exactly, and a window that picked up any setting is not found.
   * An empty list says binding and params alone name the window.
   */
  identitySettings?: readonly string[];
  /**
   * The title a saved window of this pane has, from its params and settings,
   * for lists that name windows without rendering them (the Layouts browser).
   * A pane that titles itself by what it shows ("Curve \u00b7 BZ") gives the same
   * title here, so two of its windows are told apart before either is opened.
   */
  instanceTitle?(pane: PaneInstanceConfig): string | null;
  /** Renderer-neutral data model used by CLI functions, automation, and hosted tools. */
  headless?: HeadlessPaneDefinition;
  /**
   * Source and status a rendered-view report (`fn` on a pane without a
   * `headless` model) cites, when "Gloom Cloud" with the state the footer
   * shows would be wrong: local data, a calculator, filed records.
   */
  reportFreshness?: Pick<HeadlessPaneFreshness, "source" | "status" | "basis" | "local">;
  /**
   * Options a rendered-view report takes (`fn OMON AAPL --strikes 10`):
   * each sets the pane setting of its key, is checked by its `normalize`, and
   * is listed with its example by `gloom catalog`.
   */
  reportOptions?: readonly PaneReportOptionDef[];
  /**
   * A rendered-view report that takes its `reportOptions` and nothing else:
   * any other option is refused with the ones it takes (`fn FUT --bogus 1`),
   * as a `headless` report refuses one, instead of being set as a pane
   * setting of that name.
   */
  reportOptionsOnly?: boolean;
  /**
   * What a rendered-view report takes after the function, for a pane whose
   * template reads it with no shortcut to say so (X Feed's query): the
   * catalog lists it, and `fn` refuses an argument from a function that
   * declares none here, in its shortcut or in a `headless` model.
   */
  reportArgument?: Pick<HeadlessPaneArgumentDef, "kind" | "placeholder" | "description" | "optional"> & {
    /**
     * The argument names something the pane opens by its own id (the story
     * pane's story id), never a symbol: `fn` does not look it up as a ticker.
     * A query (X Feed's) leaves it unset and keeps its ticker reading.
     */
    identifier?: boolean;
  };
  /**
   * Lines a rendered-view report prints above its table, from the settings it
   * ran with: what the default view leaves out and how to see more. `--json`
   * carries them in `data.metadata.notices`.
   */
  reportNotices?(settings: Readonly<Record<string, unknown>>): string[];
  /**
   * What a rendered-view report prints in place of the pane when a sign-in
   * wall or the Pro lock covers all of it: what is locked, what can still be
   * read without it and where, and how to unlock it. A `headless` pane's report
   * prints it when the server refuses the read (401, 402 or 403). Without it
   * the report prints the wall's own words, or the refusal. Either way it cites
   * no source, since nothing was read. A free route it names must have data
   * for the symbol (`lock.context` reads it), so the note may resolve later.
   */
  reportLockNote?(lock: PaneLock): string | Promise<string>;
  /**
   * The sign-in wall covers the whole pane whenever there is no Gloom Cloud
   * session (ASKG): a rendered-view report without one prints its
   * `reportLockNote` at once rather than render the wall to read it.
   */
  signInWall?: boolean;
  /**
   * What a rendered-view report needs before it shows anything, such as a
   * sign-in: `gloom catalog` lists it under Requires, as it does a
   * `headless` model's `discovery.dataRequirements`.
   */
  reportRequirements?: readonly string[];
  /**
   * A `shot` without `--height` grows to the pane's natural height, up to the
   * height limit, so a fixed board (FUT) shows every row instead of cutting
   * the last ones. Leave it off for long or paged lists; a pane with tabs
   * answers for the instance shown, so only its fixed board's tab grows.
   */
  shotFitsRows?: true | ((pane: PaneInstanceConfig) => boolean);
  /**
   * A report of the pane grows to the whole text of the page its reader has
   * open (a docs page), so it is not cut at the first screen. A list the reader
   * opens from keeps its height.
   */
  shotFitsReader?: true;
  /** Add an Excel-compatible CSV action for the pane's single active DataTable. */
  tableExport?: true;
  settings?: PaneSettingsDef | ((context: PaneSettingsContext) => PaneSettingsDef | null);
  /** Portable sharing is public by default; list the few pane-owned fields that must remain local. */
  portableShare?: PanePortableShareDef;
  /**
   * What a public link to the pane may name as the item it was on, beside the
   * pane (`shares/pane-item.ts`); unset, the link names the pane alone. Only for
   * a pane of public data, and only the app's own panes: a plugin loaded from
   * outside the app names nothing, whatever it sets here.
   */
  shareItem?: PaneShareItemDef;
  /**
   * The person's own data the pane shows, so copying a public link to it,
   * posting its picture in a bug report and attaching it to an Ask Gloom
   * question ask first. A function decides
   * per instance from what it shows now (a chat pane on a public channel, a
   * quote of a ticker not held), and a function that returns null opts that
   * instance out. Leave it off for market data. A pane that says nothing is
   * still asked about when its plugin connects a broker (`holdings`) or the
   * pane keeps fields private when shared (`portableShare.private`,
   * `personal`), for plugins written before this field existed; declare it
   * to say exactly what the pane shows.
   */
  personalData?: PanePersonalData | ((context: PanePersonalDataContext) => PanePersonalData | null);
  /**
   * Compact controls surfaced next to the pane title. A key references a
   * toggle field in settings, or a two-option select field when `onValue` is set.
   */
  quickSettings?: readonly PaneQuickSettingDef[];
}

export interface PaneShareItemDef {
  /**
   * What the pane has open or picked: what it says with `usePaneShareItem`,
   * else its stack's detail title and its reader's opening.
   */
  open?: true;
  /** The one ticker the pane shows, when it follows one (`tickerFollower`). */
  ticker?: true;
  /**
   * The option the pane's function was opened with (`NI CRYPTO`), when the
   * function lists it (`argOptions`). Free text is never named.
   */
  argument?: true;
}

/**
 * Kinds of personal data a pane can show: `holdings` (positions, balances,
 * orders, profit and loss), `account` (account numbers, email, plan),
 * `messages` (private conversations) and `personal` (the person's own data
 * of a kind the pane does not name).
 */
export type PanePersonalData = "holdings" | "account" | "messages" | "personal";

export interface PaneQuickSettingDef {
  type: "toggle";
  key: string;
  icon: "zap" | "sqrt";
  label?: string;
  /**
   * For a two-option select field: the option the control turns on. Turning
   * it off picks the field's other option.
   */
  onValue?: string;
  /**
   * Shows the control only where it changes something, for a setting that
   * applies to some of what the pane can show. The field stays in the
   * settings dialog either way.
   */
  visible?: (context: PaneSettingsContext) => boolean;
}

/** What `PaneDef.personalData` decides from: the pane's settings context and the tickers with their positions. */
export interface PanePersonalDataContext extends PaneSettingsContext {
  tickers: ReadonlyMap<string, TickerRecord>;
}
