import type { TeamCollection, TeamCollectionItem } from "../../../../api-client";
import type { AppConfig } from "../../../../types/config";
import type { Portfolio, TickerRecord, Watchlist } from "../../../../types/ticker";

const TEAM_COLLECTION_PREFIX = "team:";

/** A scoped reference: bare ids are personal, `team:<teamId>:<id>` is shared. */
export interface ScopedCollectionRef {
  scope: "user" | "team";
  teamId?: string;
  id: string;
}

export function teamCollectionLocalId(teamId: string, collectionId: string): string {
  return `${TEAM_COLLECTION_PREFIX}${teamId}:${collectionId}`;
}

export function parseCollectionRef(localId: string): ScopedCollectionRef {
  if (!localId.startsWith(TEAM_COLLECTION_PREFIX)) return { scope: "user", id: localId };
  const rest = localId.slice(TEAM_COLLECTION_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) return { scope: "user", id: localId };
  return { scope: "team", teamId: rest.slice(0, separator), id: rest.slice(separator + 1) };
}

/** The config entries a team's server collections map onto. */
export function collectionsToConfigEntries(
  collections: readonly TeamCollection[],
): { watchlists: Watchlist[]; portfolios: Portfolio[] } {
  const watchlists: Watchlist[] = [];
  const portfolios: Portfolio[] = [];
  for (const collection of collections) {
    const id = teamCollectionLocalId(collection.teamId, collection.id);
    if (collection.kind === "watchlist") watchlists.push({ id, name: collection.name, teamId: collection.teamId });
    else portfolios.push({ id, name: collection.name, currency: collection.currency ?? "USD", teamId: collection.teamId });
  }
  return { watchlists, portfolios };
}

/**
 * Replaces the team-owned entries in the config with what the server holds,
 * for the given teams only, leaving personal and other teams' entries alone.
 * Returns the same config object when nothing changed.
 */
export function reconcileConfigCollections(
  config: AppConfig,
  teamIds: readonly string[],
  collections: readonly TeamCollection[],
): AppConfig {
  const teams = new Set(teamIds);
  const owned = (entry: { teamId?: string }) => !!entry.teamId && teams.has(entry.teamId);
  const next = collectionsToConfigEntries(collections.filter((entry) => teams.has(entry.teamId)));
  const keepWatchlists = config.watchlists.filter((entry) => !owned(entry));
  const keepPortfolios = config.portfolios.filter((entry) => !owned(entry));
  const watchlists = [...keepWatchlists, ...next.watchlists];
  const portfolios = [...keepPortfolios, ...next.portfolios];
  const same = (a: readonly { id: string; name: string; currency?: string }[], b: readonly { id: string; name: string; currency?: string }[]) =>
    a.length === b.length && a.every((entry, index) => entry.id === b[index]?.id && entry.name === b[index]?.name && entry.currency === b[index]?.currency);
  if (same(config.watchlists, watchlists) && same(config.portfolios, portfolios)) return config;
  return { ...config, watchlists, portfolios };
}

/** Which tickers a team collection holds locally, keyed by symbol. */
export function localMembership(
  tickers: ReadonlyMap<string, TickerRecord>,
  localCollectionId: string,
  kind: "watchlist" | "portfolio",
): Map<string, { ticker: TickerRecord; quantity: number | null }> {
  const members = new Map<string, { ticker: TickerRecord; quantity: number | null }>();
  for (const ticker of tickers.values()) {
    if (kind === "watchlist") {
      if (ticker.metadata.watchlists.includes(localCollectionId)) {
        members.set(ticker.metadata.ticker, { ticker, quantity: null });
      }
      continue;
    }
    if (!ticker.metadata.portfolios.includes(localCollectionId)) continue;
    const position = ticker.metadata.positions.find((entry) => entry.portfolio === localCollectionId && entry.broker === "manual");
    members.set(ticker.metadata.ticker, { ticker, quantity: position ? position.shares : null });
  }
  return members;
}

export interface MembershipDiff {
  add: Array<{ symbol: string; quantity: number | null }>;
  remove: string[];
}

/** What changed locally since the last known server set, to push upstream. */
export function diffMembership(
  local: ReadonlyMap<string, { quantity: number | null }>,
  known: ReadonlyMap<string, TeamCollectionItem>,
): MembershipDiff {
  const add: MembershipDiff["add"] = [];
  const remove: string[] = [];
  for (const [symbol, entry] of local) {
    const item = known.get(symbol);
    if (!item || (item.quantity ?? null) !== entry.quantity) add.push({ symbol, quantity: entry.quantity });
  }
  for (const symbol of known.keys()) {
    if (!local.has(symbol)) remove.push(symbol);
  }
  return { add, remove };
}

/** Applies server items to a ticker's metadata for one collection. */
export function applyMembership(
  ticker: TickerRecord,
  localCollectionId: string,
  kind: "watchlist" | "portfolio",
  item: TeamCollectionItem | null,
  currency: string,
): TickerRecord | null {
  const metadata = ticker.metadata;
  if (kind === "watchlist") {
    const has = metadata.watchlists.includes(localCollectionId);
    if (!!item === has) return null;
    return {
      ...ticker,
      metadata: {
        ...metadata,
        watchlists: item ? [...metadata.watchlists, localCollectionId] : metadata.watchlists.filter((entry) => entry !== localCollectionId),
      },
    };
  }
  const has = metadata.portfolios.includes(localCollectionId);
  const position = metadata.positions.find((entry) => entry.portfolio === localCollectionId && entry.broker === "manual");
  const quantity = item?.quantity ?? null;
  if (!item) {
    if (!has && !position) return null;
    return {
      ...ticker,
      metadata: {
        ...metadata,
        portfolios: metadata.portfolios.filter((entry) => entry !== localCollectionId),
        positions: metadata.positions.filter((entry) => entry.portfolio !== localCollectionId),
      },
    };
  }
  if (has && (position?.shares ?? null) === quantity) return null;
  const positions = metadata.positions.filter((entry) => entry.portfolio !== localCollectionId);
  if (quantity !== null) {
    positions.push({
      portfolio: localCollectionId,
      shares: quantity,
      avgCost: position?.avgCost ?? 0,
      currency: position?.currency ?? currency,
      broker: "manual",
      ...(position?.dateAcquired ? { dateAcquired: position.dateAcquired } : {}),
    });
  }
  return {
    ...ticker,
    metadata: {
      ...metadata,
      portfolios: has ? metadata.portfolios : [...metadata.portfolios, localCollectionId],
      positions,
    },
  };
}

export function blankTickerRecord(symbol: string, exchange: string, currency: string): TickerRecord {
  return {
    metadata: {
      ticker: symbol,
      exchange,
      currency,
      name: symbol,
      broker_contracts: [],
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
    },
  };
}
