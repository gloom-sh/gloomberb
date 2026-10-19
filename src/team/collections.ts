import type { TeamCollection, TeamCollectionItem } from "../api-client";
import { getManualPortfolioPositionPrefill } from "../portfolio/manual-lots";
import type { AppConfig } from "../types/config";
import type { Portfolio, TickerRecord, Watchlist } from "../types/ticker";

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
function collectionsToConfigEntries(
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

interface LocalMember {
  ticker: TickerRecord;
  /** The ticker's shares in the collection: its one lot, or the total of several. Null with no position. */
  quantity: number | null;
  /** Several lots that cannot be totalled (mixed currencies, a long and a short lot): there is no quantity to compare or send. */
  lotsNotTotalled?: boolean;
}

/** Which tickers a team collection holds locally, keyed by symbol. */
export function localMembership(
  tickers: ReadonlyMap<string, TickerRecord>,
  localCollectionId: string,
  kind: "watchlist" | "portfolio",
): Map<string, LocalMember> {
  const members = new Map<string, LocalMember>();
  for (const ticker of tickers.values()) {
    if (kind === "watchlist") {
      if (ticker.metadata.watchlists.includes(localCollectionId)) {
        members.set(ticker.metadata.ticker, { ticker, quantity: null });
      }
      continue;
    }
    if (!ticker.metadata.portfolios.includes(localCollectionId)) continue;
    const { position, lotCount } = getManualPortfolioPositionPrefill(ticker, localCollectionId);
    members.set(ticker.metadata.ticker, {
      ticker,
      quantity: position ? position.shares : null,
      ...(lotCount > 1 && !position ? { lotsNotTotalled: true } : {}),
    });
  }
  return members;
}

export interface MembershipDiff {
  add: Array<{ symbol: string; quantity: number | null }>;
  remove: string[];
}

/**
 * What changed locally since the last known server set, to push upstream.
 * Lots that cannot be totalled have no quantity to push: a ticker the server
 * already holds is left as the server has it, and a new one goes up without one.
 */
export function diffMembership(
  local: ReadonlyMap<string, Pick<LocalMember, "quantity" | "lotsNotTotalled">>,
  known: ReadonlyMap<string, TeamCollectionItem>,
): MembershipDiff {
  const add: MembershipDiff["add"] = [];
  const remove: string[] = [];
  for (const [symbol, entry] of local) {
    const item = known.get(symbol);
    if (!item || (!entry.lotsNotTotalled && (item.quantity ?? null) !== entry.quantity)) add.push({ symbol, quantity: entry.quantity });
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
  // The lot itself, or the total of several lots (null when those cannot be totalled).
  const { position, lotCount } = getManualPortfolioPositionPrefill(ticker, localCollectionId);
  const quantity = item?.quantity ?? null;
  if (!item) {
    if (!has && lotCount === 0) return null;
    return {
      ...ticker,
      metadata: {
        ...metadata,
        portfolios: metadata.portfolios.filter((entry) => entry !== localCollectionId),
        positions: metadata.positions.filter((entry) => entry.portfolio !== localCollectionId),
      },
    };
  }
  // Several lots are collapsed into one only when the server's quantity differs
  // from their total, and never when they cannot be totalled: no lot is dropped
  // for a number that was not compared with all of them.
  if (lotCount > 1 && (!position || position.shares === quantity)) {
    return has ? null : { ...ticker, metadata: { ...metadata, portfolios: [...metadata.portfolios, localCollectionId] } };
  }
  if (has && (position?.shares ?? null) === quantity) return null;
  const positions = metadata.positions.filter((entry) => entry.portfolio !== localCollectionId);
  if (quantity !== null) {
    // A count that turns a long into a short, or back, is a new position: the old one's cost and date
    // were for what was closed, so the lot keeps neither and its cost is unknown until it is entered.
    const flipped = !!position && quantity !== 0 && position.shares !== 0 && Math.sign(quantity) !== Math.sign(position.shares);
    positions.push({
      portfolio: localCollectionId,
      shares: quantity,
      ...(flipped ? {} : { avgCost: position?.avgCost ?? 0 }),
      currency: position?.currency ?? currency,
      broker: "manual",
      ...(!flipped && position?.dateAcquired ? { dateAcquired: position.dateAcquired } : {}),
      // A future's contract size stays with the holding when the team changes its count.
      ...(position?.multiplier ? { multiplier: position.multiplier } : {}),
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
