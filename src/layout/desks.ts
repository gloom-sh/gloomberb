import { buildCreateOptions } from "../cli/pane-functions/options";
import {
  capabilityPaneSettings,
  capabilityPluginState,
  getPaneFunctionCapability,
  normalizeCapabilityOptions,
} from "../cli/pane-functions/capabilities";
import { CHART_SPEC_SETTING_KEY, parseChartSpec } from "../plugins/builtin/chart-composer/chart-spec";
import {
  getSelectedBuiltinStudies,
  setBuiltinStudies,
  type BuiltinStudySelection,
} from "../plugins/builtin/chart-composer/studies";
import type { PaneRuntimeState } from "../core/state/app/types";
import { materializeMarketplaceLayout } from "../shares/portable-layout";
import {
  createPaneInstanceId,
  type AppConfig,
  type DockLayoutNode,
  type PaneInstanceConfig,
  type SavedLayout,
} from "../types/config";
import type { TickerFinancials } from "../types/financials";
import type { PaneDef, PaneTemplateDef } from "../types/plugin";
import type { TickerRecord } from "../types/ticker";
import { resolveTickerInstrumentKind } from "../tickers/instrument-kind";

/**
 * Desks: ready-made layout tabs for one kind of trading, offered when the app
 * first runs ("What do you trade?") and later with DESK. A desk is a list of
 * functions as the command bar takes them, built through the same pane
 * templates, so each tile is what typing the function opens. Only functions
 * that show real data signed out and on Free go in a desk; a Pro-only function
 * waits in the desk's Pro row, added when the account has Pro. The Rates and
 * Options desks grew out of the Rates and Volatility desks in the layout
 * gallery.
 */

export const DESK_KEYS = ["equities", "options", "futures", "rates", "fx", "active"] as const;
export type DeskKey = (typeof DESK_KEYS)[number];

/** In an argument, the company the desk is built around. */
const DESK_COMPANY = "{company}";
/** The company when the user has no stock of their own yet. */
const DESK_FALLBACK_COMPANY = "AAPL";

interface DeskPane {
  /** The mnemonic as the command bar takes it. */
  fn: string;
  arg?: string;
  /** The function's options, as `gloomberb fn` takes them. */
  options?: Readonly<Record<string, string>>;
  /** The pane (its place in the desk, from 1) whose ticker this one follows. */
  follows?: number;
  /** Chart studies on top of the ones the function opens with. */
  studies?: readonly BuiltinStudySelection[];
}

export interface Desk {
  key: DeskKey;
  /** What the picker calls it. */
  label: string;
  /** The tab's name. */
  name: string;
  /** Panes p1..pN, in this order. */
  panes: readonly DeskPane[];
  /** How p1..pN are arranged. */
  dock: DockLayoutNode;
  /** Pro-only functions: a row under the desk when the account has Pro. */
  pro?: readonly DeskPane[];
}

const pane = (place: number): DockLayoutNode => ({ kind: "pane", instanceId: `p${place}` });
/** Side by side, first on the left. */
const row = (ratio: number, first: DockLayoutNode, second: DockLayoutNode): DockLayoutNode => (
  { kind: "split", axis: "horizontal", ratio, first, second }
);
/** Stacked, first on top. */
const column = (ratio: number, first: DockLayoutNode, second: DockLayoutNode): DockLayoutNode => (
  { kind: "split", axis: "vertical", ratio, first, second }
);
/** Side by side in equal widths. */
function evenRow([first, ...rest]: readonly number[]): DockLayoutNode {
  return rest.length === 0 ? pane(first!) : row(1 / (rest.length + 1), pane(first!), evenRow(rest));
}

/** Liquid names a day trader watches: the index ETFs and the heaviest single stocks. */
const ACTIVE_WATCHLIST = "SPY,QQQ,IWM,NVDA,TSLA,AAPL,AMD,META";

export const DESKS: readonly Desk[] = [
  {
    key: "equities",
    label: "Equities",
    name: "Equities",
    panes: [
      { fn: "DES", arg: DESK_COMPANY },
      { fn: "G", arg: DESK_COMPANY, follows: 1 },
      { fn: "FA", arg: DESK_COMPANY, follows: 1 },
      { fn: "ERN" },
      { fn: "TOP" },
      { fn: "EQS" },
    ],
    dock: column(0.56, row(0.33, pane(1), row(0.45, pane(2), pane(3))), row(0.4, pane(5), row(0.5, pane(4), pane(6)))),
  },
  {
    key: "options",
    label: "Options",
    name: "Options",
    panes: [
      { fn: "OMON", arg: "SPY" },
      { fn: "OPX", arg: "SPY", follows: 1 },
      { fn: "OVDV", arg: "SPY", follows: 1 },
      { fn: "HIVG", arg: "SPY", follows: 1 },
      { fn: "VOLS" },
    ],
    dock: column(0.55, row(0.58, pane(1), pane(2)), row(0.36, pane(3), row(0.5, pane(4), pane(5)))),
    pro: [{ fn: "FLOW" }],
  },
  {
    key: "futures",
    label: "Futures & commodities",
    name: "Futures",
    panes: [
      { fn: "FUT" },
      { fn: "GP", arg: "CL1" },
      { fn: "CTM", arg: "CL" },
      { fn: "COT", arg: "CL" },
      { fn: "SEAS", arg: "CL1", follows: 2 },
    ],
    dock: column(0.55, row(0.5, pane(1), pane(2)), row(0.34, pane(3), row(0.5, pane(4), pane(5)))),
  },
  {
    key: "rates",
    label: "Rates & credit",
    name: "Rates",
    panes: [
      { fn: "WIRP" },
      { fn: "GC" },
      { fn: "BTMM" },
      { fn: "CDX" },
      { fn: "SOVR" },
      { fn: "CBR" },
    ],
    dock: column(0.5, row(0.4, pane(1), row(0.5, pane(2), pane(3))), row(0.34, pane(4), row(0.5, pane(5), pane(6)))),
  },
  {
    key: "fx",
    label: "FX & macro",
    name: "FX & Macro",
    panes: [
      { fn: "FXC" },
      { fn: "WEI" },
      { fn: "GC", options: { tab: "world" } },
      { fn: "ECO" },
      { fn: "ECST" },
      { fn: "CBR" },
    ],
    // The cross-rate matrix is short and wide, so it sits over the calendar.
    dock: row(0.46, column(0.28, pane(1), pane(4)), row(0.5, column(0.55, pane(2), pane(5)), column(0.5, pane(3), pane(6)))),
  },
  {
    key: "active",
    label: "Active trading",
    name: "Trading",
    panes: [
      { fn: "GIP", arg: "SPY", studies: ["vwap"] },
      { fn: "QQ", arg: ACTIVE_WATCHLIST },
      { fn: "TAS", arg: "SPY", follows: 1 },
      { fn: "MOST" },
      { fn: "HALT" },
      { fn: "N" },
    ],
    dock: row(0.74, column(0.58, row(0.62, pane(1), pane(2)), row(0.5, pane(4), row(0.5, pane(5), pane(6)))), pane(3)),
  },
];

export function getDesk(key: DeskKey): Desk {
  return DESKS.find((desk) => desk.key === key)!;
}

export function isDeskKey(value: unknown): value is DeskKey {
  return typeof value === "string" && (DESK_KEYS as readonly string[]).includes(value);
}

/**
 * The company DES, G and FA open on: the first candidate that is a stock,
 * since a fund or a future has no financials for FA to show.
 */
export function pickDeskCompany(
  candidates: Iterable<string | null | undefined>,
  isStock: (symbol: string) => boolean,
): string {
  for (const symbol of candidates) {
    if (symbol && isStock(symbol)) return symbol;
  }
  return DESK_FALLBACK_COMPANY;
}

/** A stock the app has a record of; a symbol it knows nothing about may be a fund. */
export function isDeskStock(
  ticker: TickerRecord | null | undefined,
  financials?: Pick<TickerFinancials, "quote" | "quoteMetadata"> | null,
): boolean {
  return !!ticker && resolveTickerInstrumentKind(ticker, financials) === "equity";
}

/** The mnemonics a desk opens, for a one-line summary. */
export function deskFunctions(desk: Desk): string[] {
  return [...new Set(desk.panes.map((entry) => entry.fn))];
}

/** What the app's registry offers a desk to be built from. */
export interface DeskCatalog {
  panes: ReadonlyMap<string, PaneDef>;
  paneTemplates: ReadonlyMap<string, PaneTemplateDef>;
}

/** DES is the command bar's own command; the pane it opens is the T template's. */
const TEMPLATE_PREFIXES: Readonly<Record<string, string>> = { DES: "T" };

/** The pane template a desk function opens, by its exact mnemonic. */
export function deskTemplate(catalog: DeskCatalog, fn: string): PaneTemplateDef | null {
  const prefix = TEMPLATE_PREFIXES[fn] ?? fn;
  for (const template of catalog.paneTemplates.values()) {
    if (template.shortcut?.prefix === prefix) return template;
  }
  return null;
}

interface BuiltDeskPane {
  instance: PaneInstanceConfig;
  pluginState: Record<string, Record<string, unknown>>;
}

async function buildDeskPane(
  template: PaneTemplateDef,
  paneDef: PaneDef,
  config: AppConfig,
  entry: DeskPane,
  wireId: string,
  /** The wire id of the pane it follows, when that pane is on this desk. */
  followId: string | null,
  company: string,
): Promise<BuiltDeskPane> {
  const arg = entry.arg === DESK_COMPANY ? company : entry.arg ?? "";
  const createOptions = buildCreateOptions(template, arg);
  const spec = await template.createInstance?.({
    config,
    layout: config.layout,
    focusedPaneId: null,
    activeTicker: createOptions?.symbol ?? null,
    activeCollectionId: null,
  }, createOptions) ?? {};
  const capability = getPaneFunctionCapability(template, paneDef);
  const options = normalizeCapabilityOptions(capability, { ...entry.options }, { strict: true });
  const settings: Record<string, unknown> = { ...spec.settings, ...capabilityPaneSettings(capability, options) };
  const chartSpec = entry.studies?.length ? parseChartSpec(settings[CHART_SPEC_SETTING_KEY]) : null;
  if (chartSpec) {
    settings[CHART_SPEC_SETTING_KEY] = setBuiltinStudies(chartSpec, [...getSelectedBuiltinStudies(chartSpec), ...entry.studies!]);
  }
  // A follower's title comes from the ticker it follows, so it never names a
  // ticker the pane has moved off.
  const instance: PaneInstanceConfig = {
    instanceId: wireId,
    paneId: template.paneId,
    ...(followId || !spec.title ? {} : { title: spec.title }),
    binding: followId
      ? { kind: "follow", sourceInstanceId: followId }
      : spec.binding ?? (createOptions?.symbol ? { kind: "fixed", symbol: createOptions.symbol } : { kind: "none" }),
    ...(spec.params ? { params: { ...spec.params } } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {}),
  };
  return { instance, pluginState: capabilityPluginState(capability, options) };
}

/** The dock without the panes a host left out; a split with one side left becomes that side. */
function keepDockPanes(node: DockLayoutNode, kept: ReadonlySet<string>): DockLayoutNode | null {
  if (node.kind === "pane") return kept.has(node.instanceId) ? node : null;
  const first = keepDockPanes(node.first, kept);
  const second = keepDockPanes(node.second, kept);
  return first && second ? { ...node, first, second } : first ?? second;
}

/** A built desk: a saved tab whose pane state the app can install as it is. */
export type DeskLayout = SavedLayout & { paneState: Record<string, PaneRuntimeState> };

export interface BuildDeskOptions {
  catalog: DeskCatalog;
  config: AppConfig;
  /** The stock behind DES, G and FA. */
  company: string;
  /** Adds the desk's Pro row. */
  pro: boolean;
}

/**
 * A desk as a saved layout tab, with fresh pane ids. A function the host does
 * not have (the web build leaves some out) is left out of the desk rather
 * than shown as a placeholder, and its neighbours take the room. Null when
 * the host has none of them.
 */
export async function buildDesk(desk: Desk, { catalog, config, company, pro }: BuildDeskOptions): Promise<DeskLayout | null> {
  const entries = pro && desk.pro?.length ? [...desk.panes, ...desk.pro] : desk.panes;
  const available = entries.flatMap((entry, index) => {
    const template = deskTemplate(catalog, entry.fn);
    const paneDef = template ? catalog.panes.get(template.paneId) : undefined;
    return template && paneDef ? [{ entry, template, paneDef, wireId: `p${index + 1}` }] : [];
  });
  if (available.length === 0) return null;
  const kept = new Set(available.map(({ wireId }) => wireId));
  const built = await Promise.all(available.map(({ entry, template, paneDef, wireId }) => {
    const followId = entry.follows && kept.has(`p${entry.follows}`) ? `p${entry.follows}` : null;
    return buildDeskPane(template, paneDef, config, entry, wireId, followId, company);
  }));
  const proPlaces = entries.slice(desk.panes.length).map((_, index) => desk.panes.length + index + 1);
  const dock = proPlaces.length > 0 ? column(0.7, desk.dock, evenRow(proPlaces)) : desk.dock;
  const paneState = Object.fromEntries(built.flatMap(({ instance, pluginState }) => (
    Object.keys(pluginState).length > 0 ? [[instance.instanceId, { pluginState }]] : []
  )));
  const materialized = materializeMarketplaceLayout({
    layout: {
      dockRoot: keepDockPanes(dock, kept),
      instances: built.map(({ instance }) => instance),
      floating: [],
      detached: [],
    },
    paneState,
  }, (paneId) => createPaneInstanceId(paneId));
  return {
    name: desk.name,
    layout: materialized.layout,
    paneState: materialized.paneState,
    focusedPaneId: materialized.layout.instances[0]?.instanceId ?? null,
  };
}
