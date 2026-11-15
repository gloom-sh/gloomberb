import type { AppConfig } from "../types/config";
import type { Watchlist, WatchlistGroup } from "../types/ticker";
import { parseCollectionRef } from "../team/collections";
import { isRecord } from "../utils/guards";

/** The longest name a group takes, so its header and the CLI's Group column stay readable. */
const MAX_GROUP_NAME_LENGTH = 40;

/** The section a list's tickers in no group show under; no group takes the name. */
export const UNGROUPED_LABEL = "Ungrouped";

const sameName = (left: string, right: string) => left.toLocaleLowerCase() === right.toLocaleLowerCase();

/**
 * A list's groups as they are kept: names trimmed, two names that differ only
 * in case one group under the first's name, each symbol in the first group
 * that lists it, and a group left with no symbol dropped. Undefined when none
 * remain, so a list without groups saves and syncs as it did before groups.
 * Reads anything (a pulled or hand-edited config) and keeps what is well formed.
 */
export function normalizeWatchlistGroups(value: unknown): WatchlistGroup[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const groups: WatchlistGroup[] = [];
  const placed = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.name !== "string" || !Array.isArray(entry.symbols)) continue;
    const name = entry.name.trim();
    if (!name) continue;
    let group = groups.find((existing) => sameName(existing.name, name));
    if (!group) {
      group = { name, symbols: [] };
      groups.push(group);
    }
    for (const symbol of entry.symbols) {
      if (typeof symbol !== "string" || !symbol.trim() || placed.has(symbol)) continue;
      placed.add(symbol);
      group.symbols.push(symbol);
    }
  }
  const kept = groups.filter((group) => group.symbols.length > 0);
  return kept.length > 0 ? kept : undefined;
}

/** A list's groups, none for a list without; a config pulled from another device is read as it came, so this checks it. */
export function watchlistGroups(watchlist: Pick<Watchlist, "groups"> | null | undefined): WatchlistGroup[] {
  return normalizeWatchlistGroups(watchlist?.groups) ?? [];
}

/** The name of the group a ticker of the list is in, by its key; null when it is in none. */
export function watchlistGroupOf(watchlist: Pick<Watchlist, "groups"> | null | undefined, symbol: string): string | null {
  return watchlistGroups(watchlist).find((group) => group.symbols.includes(symbol))?.name ?? null;
}

/**
 * Whether the list takes groups: a personal one. A team list is shared with
 * everyone on the team and its items are the server's, so it has none.
 */
export function watchlistTakesGroups(watchlist: Pick<Watchlist, "id" | "teamId">): boolean {
  return !watchlist.teamId && parseCollectionRef(watchlist.id).scope !== "team";
}

/** A group name as typed, trimmed; throws saying why one cannot be used. */
export function parseWatchlistGroupName(input: string): string {
  const name = input.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("A group needs a name.");
  if (name.length > MAX_GROUP_NAME_LENGTH) throw new Error(`A group name is at most ${MAX_GROUP_NAME_LENGTH} characters.`);
  if (sameName(name, UNGROUPED_LABEL)) throw new Error(`"${UNGROUPED_LABEL}" is where tickers in no group show; name the group something else.`);
  return name;
}

function withGroups(config: AppConfig, watchlistId: string, groups: readonly WatchlistGroup[]): AppConfig {
  const kept = normalizeWatchlistGroups(groups);
  return {
    ...config,
    watchlists: config.watchlists.map((watchlist) => {
      if (watchlist.id !== watchlistId) return watchlist;
      const { groups: _groups, ...rest } = watchlist;
      return kept ? { ...rest, groups: kept } : rest;
    }),
  };
}

/**
 * Puts `symbols` (tickers' keys) in the list's group `group` names, matched in
 * any case, taking each out of any other group of the list; a new group goes
 * last. `null` takes them out of their group. `moved` names the symbols whose
 * group changed, and `group` is the name they are under now; the config comes
 * back as it was when none moved.
 */
export function setWatchlistGroup(
  config: AppConfig,
  watchlistId: string,
  symbols: readonly string[],
  group: string | null,
): { config: AppConfig; group: string | null; moved: string[] } {
  const watchlist = config.watchlists.find((entry) => entry.id === watchlistId);
  if (!watchlist) throw new Error("Watchlist not found.");
  const groups = watchlistGroups(watchlist);
  const target = group == null ? null : groups.find((entry) => sameName(entry.name, group))?.name ?? parseWatchlistGroupName(group);
  const moving = [...new Set(symbols)].filter((symbol) => watchlistGroupOf(watchlist, symbol) !== target);
  if (moving.length === 0) return { config, group: target, moved: [] };
  const next = groups.map((entry) => ({ name: entry.name, symbols: entry.symbols.filter((symbol) => !moving.includes(symbol)) }));
  if (target != null) {
    const existing = next.find((entry) => entry.name === target);
    if (existing) existing.symbols.push(...moving);
    else next.push({ name: target, symbols: [...moving] });
  }
  return { config: withGroups(config, watchlistId, next), group: target, moved: moving };
}

/** The list's groups without `symbols`, tickers that left the list: one added back later starts in no group. */
export function withoutWatchlistGroupSymbols(config: AppConfig, watchlistId: string, symbols: readonly string[]): AppConfig {
  const watchlist = config.watchlists.find((entry) => entry.id === watchlistId);
  const groups = watchlistGroups(watchlist);
  if (!groups.some((group) => group.symbols.some((symbol) => symbols.includes(symbol)))) return config;
  return withGroups(config, watchlistId, groups.map((group) => ({ ...group, symbols: group.symbols.filter((symbol) => !symbols.includes(symbol)) })));
}

/**
 * The config without group symbols whose ticker is loaded and no longer on
 * the list: taken off it some other way (the command bar, another device, an
 * older build), so one added back later starts in no group. A symbol with no
 * loaded row is kept: a pull may not have written it yet, or its row did not
 * read, and a symbol with no row shows nowhere anyway.
 */
export function withoutStaleWatchlistGroupSymbols(
  config: AppConfig,
  tickers: Iterable<{ metadata: { ticker: string; watchlists: readonly string[] } }>,
): AppConfig {
  if (!config.watchlists.some((watchlist) => watchlist.groups)) return config;
  const listsOf = new Map<string, readonly string[]>();
  for (const ticker of tickers) listsOf.set(ticker.metadata.ticker, ticker.metadata.watchlists);
  let next = config;
  for (const watchlist of config.watchlists) {
    const stale = watchlistGroups(watchlist).flatMap((group) => group.symbols.filter((symbol) => {
      const lists = listsOf.get(symbol);
      return lists != null && !lists.includes(watchlist.id);
    }));
    if (stale.length > 0) next = withoutWatchlistGroupSymbols(next, watchlist.id, stale);
  }
  return next;
}

/**
 * Names a group of the list, matched in any case, `to` instead. A name another
 * group has merges the two, where the first of them was.
 */
export function renameWatchlistGroup(config: AppConfig, watchlistId: string, from: string, to: string): AppConfig {
  const watchlist = config.watchlists.find((entry) => entry.id === watchlistId);
  const groups = watchlistGroups(watchlist);
  const renamed = parseWatchlistGroupName(to);
  if (!groups.some((group) => sameName(group.name, from))) throw new Error(`"${watchlist?.name ?? watchlistId}" has no group "${from}".`);
  return withGroups(config, watchlistId, groups.map((group) => (sameName(group.name, from) ? { ...group, name: renamed } : group)));
}

/**
 * Group symbols saved under an old key moved to their listing's key
 * (`mergeSuffixedListings`: GARAN.IS into GARAN:BIST), as target weights are.
 * A listing already in a group keeps that group.
 */
export function moveWatchlistGroupSymbols(config: AppConfig, moved: ReadonlyMap<string, string>): AppConfig {
  let changed = false;
  const watchlists = config.watchlists.map((watchlist) => {
    const groups = watchlistGroups(watchlist);
    if (!groups.some((group) => group.symbols.some((symbol) => moved.has(symbol)))) return watchlist;
    changed = true;
    const grouped = new Set(groups.flatMap((group) => group.symbols));
    const next = normalizeWatchlistGroups(groups.map((group) => ({
      ...group,
      symbols: group.symbols.flatMap((symbol) => {
        const to = moved.get(symbol);
        return to == null ? [symbol] : grouped.has(to) ? [] : [to];
      }),
    })));
    const { groups: _groups, ...rest } = watchlist;
    return next ? { ...rest, groups: next } : rest;
  });
  return changed ? { ...config, watchlists } : config;
}

export interface WatchlistSection<T> {
  /** The group's name; null for the tickers in no group. */
  name: string | null;
  items: T[];
}

/**
 * Items of a list under their sections, each section in the order the items
 * come: every group that holds one, in the list's order, then the items in no
 * group. Null when no item is in a group, so a list without groups shows as it
 * always has.
 */
export function sectionWatchlistItems<T>(
  groups: readonly WatchlistGroup[],
  items: readonly T[],
  keyOf: (item: T) => string,
): WatchlistSection<T>[] | null {
  const groupOf = new Map<string, number>();
  groups.forEach((group, index) => group.symbols.forEach((symbol) => groupOf.set(symbol, index)));
  const grouped: T[][] = groups.map(() => []);
  const ungrouped: T[] = [];
  for (const item of items) {
    const index = groupOf.get(keyOf(item));
    if (index == null) ungrouped.push(item);
    else grouped[index]!.push(item);
  }
  if (ungrouped.length === items.length) return null;
  return [
    ...groups.flatMap((group, index) => grouped[index]!.length > 0 ? [{ name: group.name, items: grouped[index]! }] : []),
    ...ungrouped.length > 0 ? [{ name: null, items: ungrouped }] : [],
  ];
}
