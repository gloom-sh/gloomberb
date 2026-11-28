import type { FundMember } from "../../../api-client/members";
import type { PanePersonalData } from "../../../types/plugin";
import type { Portfolio, TickerRecord, Watchlist } from "../../../types/ticker";
import { isRecord } from "../../../utils/guards";
import { getSectorCollection } from "../sectors/sector-data";
import { collectionKindNote } from "../shared/collection-options";

/** Focused industries, named by the fund whose published holdings define the group. */
const INDUSTRIES = [
  { etf: "SOXX", name: "Semiconductors" },
  { etf: "XPH", name: "Pharmaceuticals" },
  { etf: "XBI", name: "Biotech" },
  { etf: "ITA", name: "Aerospace & defense" },
  { etf: "KRE", name: "Regional banks" },
  { etf: "IGV", name: "Software" },
  { etf: "XRT", name: "Retail" },
  { etf: "XHB", name: "Homebuilders" },
  { etf: "XOP", name: "Oil & gas exploration" },
] as const;

/**
 * Which companies ERN lists: the market, the user's lists, or a fund's holdings. A list that is `deleted` is the one
 * PF opened the board on, gone since: it lists nothing rather than the market.
 */
export type EarningsScope =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "portfolio" | "watchlist"; id: string; name: string; deleted?: true }
  | { kind: "fund"; etf: string; name: string };

export interface EarningsScopeOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  scope: EarningsScope;
}

/** The value that lists the market; also what an unknown or removed choice reads as. */
export const ALL_SCOPE = "all";
const MINE_SCOPE = "mine";

/**
 * The pane setting PF's Earnings Calendar opens a board with: the Names value of the portfolio or watchlist on screen
 * (`portfolio:<id>`). It names the window, so ERN and EVTS never take it, and never leaves the device.
 */
export const COLLECTION_SETTING = "collection";

type CollectionKind = "portfolio" | "watchlist";

/** The Names value of one of the person's portfolios or watchlists, by its id: two lists of one name stay apart. */
export function collectionScope(kind: CollectionKind, id: string): string {
  return `${kind}:${id}`;
}

function collectionOf(value: unknown): { kind: CollectionKind; id: string } | null {
  if (typeof value !== "string") return null;
  const match = /^(portfolio|watchlist):(.+)$/s.exec(value);
  return match ? { kind: match[1] as CollectionKind, id: match[2]! } : null;
}

/** Whether a Names value is one of the person's portfolios or watchlists. */
function isCollectionScope(value: unknown): value is string {
  return collectionOf(value) !== null;
}

/**
 * The Names value a board shows: the choice made in the pane, else the list PF opened it on, else Mine for a layout
 * saved with the Mine toggle that came before the filter, else the market.
 */
export function requestedEarningsScope(chosen: unknown, openedOn: unknown, mineOnly: unknown): string {
  if (typeof chosen === "string") return chosen;
  if (isCollectionScope(openedOn)) return openedOn;
  return mineOnly === true ? MINE_SCOPE : ALL_SCOPE;
}

/**
 * Personal lists, broad sectors and focused industries stay separate in the Names menu. `openedOn`, the list PF
 * opened the board on while no other choice is made, stays in it once deleted, as a list of nothing.
 */
export function earningsScopeOptions(
  collections: { portfolios: readonly Portfolio[]; watchlists: readonly Watchlist[] },
  openedOn?: string | null,
): EarningsScopeOption[] {
  const lists = [
    ...collections.portfolios.map((portfolio): EarningsScopeOption => ({
      value: collectionScope("portfolio", portfolio.id), label: portfolio.name, description: collectionKindNote(portfolio.name, "Portfolio"), group: "Your lists",
      scope: { kind: "portfolio", id: portfolio.id, name: portfolio.name },
    })),
    ...collections.watchlists.map((watchlist): EarningsScopeOption => ({
      value: collectionScope("watchlist", watchlist.id), label: watchlist.name, description: collectionKindNote(watchlist.name, "Watchlist"), group: "Your lists",
      scope: { kind: "watchlist", id: watchlist.id, name: watchlist.name },
    })),
  ];
  const gone = collectionOf(openedOn);
  if (gone && !lists.some((option) => option.value === openedOn)) {
    const label = gone.kind === "portfolio" ? "Deleted portfolio" : "Deleted watchlist";
    lists.push({ value: openedOn!, label, group: "Your lists", scope: { ...gone, name: label, deleted: true } });
  }
  return [
    { value: ALL_SCOPE, label: "All", scope: { kind: "all" } },
    { value: MINE_SCOPE, label: "Mine", description: "Portfolios and watchlists", scope: { kind: "mine" } },
    ...lists,
    ...getSectorCollection("sectors").items.map((sector): EarningsScopeOption => ({
      // Keep the saved sector choice when switching to that fund's own holdings.
      value: `sector:${sector.etf}`, label: `${sector.name} (${sector.etf})`, group: "Sectors",
      scope: { kind: "fund", etf: sector.etf, name: sector.name },
    })),
    ...INDUSTRIES.map((industry): EarningsScopeOption => ({
      value: `industry:${industry.etf}`, label: `${industry.name} (${industry.etf})`, group: "Industries",
      scope: { kind: "fund", etf: industry.etf, name: industry.name },
    })),
  ];
}

/**
 * What a board on the person's own names shows of theirs, for the pane's `personalData`: a portfolio its holdings, a
 * watchlist (its name on the Names filter, its tickers in the rows) or Mine their own data, holdings once a held
 * name is among them. Null for the market, a sector or an industry.
 */
export function ownNamesPersonalData(value: string, tickers: Iterable<TickerRecord>): PanePersonalData | null {
  const list = collectionOf(value);
  if (list?.kind === "portfolio") return "holdings";
  if (!list && value !== MINE_SCOPE) return null;
  const shown = [...tickers].filter(({ metadata }) => (list
    ? metadata.watchlists.includes(list.id)
    : metadata.portfolios.length > 0 || metadata.watchlists.length > 0));
  if (shown.some(({ metadata }) => metadata.portfolios.length > 0)) return "holdings";
  return list || shown.length > 0 ? "personal" : null;
}

/**
 * The pane state a public link or a published layout carries: a Names choice of one of the person's lists stays on
 * the device, so the link opens on the market instead. A sector or an industry travels.
 */
export function withoutCollectionScope(state: Readonly<Record<string, unknown>>, stateId: string): Record<string, unknown> {
  const pluginState = state.pluginState;
  if (!isRecord(pluginState)) return state;
  const own = pluginState[stateId];
  if (!isRecord(own) || !isCollectionScope(own.scope)) return state;
  const { scope: _private, ...rest } = own;
  return { ...state, pluginState: { ...pluginState, [stateId]: rest } };
}

/** The scope a saved value names among `options`; the market when it names none. */
export function readEarningsScope(value: string, options: readonly EarningsScopeOption[]): EarningsScopeOption {
  return options.find((option) => option.value === value) ?? options[0]!;
}

/** A fund's companies, largest weight first; cash and other unlisted holdings have no symbol. */
export function fundSymbols(members: readonly FundMember[]): string[] {
  const symbols = [...members]
    .sort((left, right) => (right.weight ?? 0) - (left.weight ?? 0))
    .flatMap((member) => member.symbol?.trim() ? [member.symbol.trim().toUpperCase()] : []);
  return [...new Set(symbols)];
}
