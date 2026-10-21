import type { TeamCollection, TeamCollectionItem } from "../api-client";
import { getManualPortfolioPositionPrefill } from "../portfolio/manual-lots";
import type { AppConfig } from "../types/config";
import type { Portfolio, TickerPosition, TickerRecord, Watchlist } from "../types/ticker";
import { heldCurrencyUnit, normalizeHeldCurrencyCode } from "../utils/currency-units";
import { debugLog } from "../utils/debug-log";

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

/**
 * What a portfolio item carries of the holding beside its quantity, as sent:
 * its purchase date, and its currency with the rate its cost was bought at
 * (null when it has none), which go together. A field left out is kept as the
 * server has it, so a sync never clears a date or rate it did not know.
 */
interface TeamItemTerms {
  dateAcquired?: string;
  currency?: string;
  costFxRate?: number | null;
  costFxCurrency?: string | null;
}

interface LotTerms {
  dateAcquired?: string;
  /** The holding's currency, the one `costFx` is a rate of. */
  currency?: string;
  /** Null: no rate, the cost converts at today's. Undefined: lots whose rates do not become one. */
  costFx?: { rate: number; currency: string } | null;
}

interface LocalMember {
  ticker: TickerRecord;
  /** The ticker's shares in the collection: its one lot, or the total of several. Null with no position. */
  quantity: number | null;
  /** Several lots that cannot be totalled (mixed currencies, a long and a short lot): there is no quantity to compare or send. */
  lotsNotTotalled?: boolean;
  /**
   * Several lots whose cost FX rates cannot become one position's: a server
   * count does not collapse them (applyMembership), so their total is not sent
   * over the server's either, only for a ticker the server does not hold yet.
   */
  lotsKept?: boolean;
  /** The manual lots it holds; only a single one sends its date or rate on its own. */
  lotCount?: number;
  /** The purchase date and rate of the lot, or of several as one position keeps them. */
  terms?: LotTerms;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE = /^[A-Za-z]{3}$/;

/** Two currencies whose amounts are the same unit: a rate of one is a rate of the other (GBp and GBX are both pence). */
function sameHeldUnit(left: string | undefined, right: string | undefined): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  const a = heldCurrencyUnit(normalizeHeldCurrencyCode(left));
  const b = heldCurrencyUnit(normalizeHeldCurrencyCode(right));
  return a.currency === b.currency && a.divisor === b.divisor;
}

function positionCostFx(position: Pick<TickerPosition, "costFxRate" | "costFxCurrency">): { rate: number; currency: string } | null {
  const rate = position.costFxRate;
  return typeof rate === "number" && Number.isFinite(rate) && rate > 0 && position.costFxCurrency?.trim()
    ? { rate, currency: position.costFxCurrency.trim().toUpperCase() }
    : null;
}

/** The date, currency and rate a server item holds, each only when it holds a usable one. */
function itemTerms(item: TeamCollectionItem): LotTerms {
  const currency = typeof item.currency === "string" && CURRENCY_CODE.test(item.currency.trim()) ? normalizeHeldCurrencyCode(item.currency) : undefined;
  return {
    ...(typeof item.dateAcquired === "string" && ISO_DAY.test(item.dateAcquired) ? { dateAcquired: item.dateAcquired } : {}),
    ...(currency ? { currency, costFx: positionCostFx({ costFxRate: item.costFxRate ?? undefined, costFxCurrency: item.costFxCurrency ?? undefined }) } : {}),
  };
}

/** What a lot's terms send: a date and currency the server can store, and the rate with its currency. */
function sentTerms(terms: LotTerms | undefined, parts: { date: boolean; rate: boolean }): TeamItemTerms | null {
  const sent: TeamItemTerms = {};
  if (parts.date && terms?.dateAcquired && ISO_DAY.test(terms.dateAcquired)) sent.dateAcquired = terms.dateAcquired;
  if (parts.rate && terms?.currency && CURRENCY_CODE.test(terms.currency) && terms.costFx !== undefined) {
    sent.currency = terms.currency;
    sent.costFxRate = terms.costFx?.rate ?? null;
    sent.costFxCurrency = terms.costFx?.currency ?? null;
  }
  return Object.keys(sent).length > 0 ? sent : null;
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
    const { position, lotCount, costFxConflict } = getManualPortfolioPositionPrefill(ticker, localCollectionId);
    const currency = position?.currency?.trim() ? normalizeHeldCurrencyCode(position.currency) : undefined;
    members.set(ticker.metadata.ticker, {
      ticker,
      quantity: position ? position.shares : null,
      lotCount,
      ...(lotCount > 1 && !position ? { lotsNotTotalled: true } : {}),
      ...(lotCount > 1 && position && costFxConflict ? { lotsKept: true } : {}),
      ...(position ? {
        terms: {
          ...(position.dateAcquired ? { dateAcquired: position.dateAcquired } : {}),
          ...(currency ? { currency } : {}),
          ...(costFxConflict ? {} : { costFx: positionCostFx(position) }),
        },
      } : {}),
    });
  }
  return members;
}

export interface MembershipDiff {
  add: Array<{ symbol: string; quantity: number | null; terms?: TeamItemTerms }>;
  remove: string[];
}

/**
 * The date and rate a single lot sends on their own, its count unchanged:
 * those the server lacks or holds otherwise. A rate goes only over the
 * server's in the same currency, or none, so two teammates holding it in
 * different currencies never overwrite each other back and forth; only a
 * server that keeps terms (one that answers with them) is sent any.
 */
function changedTerms(terms: LotTerms | undefined, item: TeamCollectionItem): TeamItemTerms | null {
  if (!terms || item.dateAcquired === undefined) return null;
  const date = !!terms.dateAcquired && terms.dateAcquired !== item.dateAcquired;
  const held = itemTerms(item);
  const rate = !!terms.costFx && (!held.currency || sameHeldUnit(held.currency, terms.currency))
    && (held.currency !== terms.currency || held.costFx?.rate !== terms.costFx.rate || held.costFx?.currency !== terms.costFx.currency);
  return date || rate ? sentTerms(terms, { date, rate }) : null;
}

/**
 * What changed locally since the last known server set, to push upstream.
 * Lots that cannot be totalled have no quantity to push: a ticker the server
 * already holds is left as the server has it, and a new one goes up without
 * one; nor do lots whose rates cannot be merged push theirs over the server's.
 * A count goes up with the purchase date and rate the position keeps, and a
 * single lot's date or rate on its own when only that changed.
 */
export function diffMembership(
  local: ReadonlyMap<string, Pick<LocalMember, "quantity" | "lotsNotTotalled" | "lotsKept" | "lotCount" | "terms">>,
  known: ReadonlyMap<string, TeamCollectionItem>,
): MembershipDiff {
  const add: MembershipDiff["add"] = [];
  const remove: string[] = [];
  for (const [symbol, entry] of local) {
    const item = known.get(symbol);
    if (!item || (!entry.lotsNotTotalled && !entry.lotsKept && (item.quantity ?? null) !== entry.quantity)) {
      const terms = sentTerms(entry.terms, { date: true, rate: true });
      add.push({ symbol, quantity: entry.quantity, ...(terms ? { terms } : {}) });
      continue;
    }
    const terms = entry.lotCount === 1 ? changedTerms(entry.terms, item) : null;
    if (terms) add.push({ symbol, quantity: entry.quantity, terms });
  }
  for (const symbol of known.keys()) {
    if (!local.has(symbol)) remove.push(symbol);
  }
  return { add, remove };
}

const teamsLog = debugLog.createLogger("teams");

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
  const { position, lotCount, costFxConflict } = getManualPortfolioPositionPrefill(ticker, localCollectionId);
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
  const withMembership = () => (has ? null : { ...ticker, metadata: { ...metadata, portfolios: [...metadata.portfolios, localCollectionId] } });
  // Several lots are collapsed into one only when the server's quantity differs
  // from their total, and never when they cannot be totalled: no lot is dropped
  // for a number that was not compared with all of them.
  if (lotCount > 1 && (!position || position.shares === quantity)) return withMembership();
  const positions = metadata.positions.filter((entry) => entry.portfolio !== localCollectionId);
  if (quantity === null) {
    if (has && !position) return null;
  } else {
    // A count that turns a long into a short, or back, is a new position: the old one's cost and date
    // were for what was closed, so the lot keeps neither and its cost is unknown until it is entered.
    const flipped = !!position && quantity !== 0 && position.shares !== 0 && Math.sign(quantity) !== Math.sign(position.shares);
    // The team's purchase date and rate, as the teammate who set the holding sent them; the rate only
    // for a lot in the currency it is a rate of. Otherwise the lot keeps its own, several lots theirs merged.
    const shared = itemTerms(item);
    const lotCurrency = position?.currency ?? shared.currency ?? currency;
    const sharedRate = shared.currency && sameHeldUnit(shared.currency, lotCurrency) ? { costFx: shared.costFx ?? null } : null;
    if (lotCount > 1 && costFxConflict && !sharedRate && !flipped) {
      teamsLog.warn("Kept several lots of a team portfolio holding whose cost FX rates cannot become one position", { symbol: metadata.ticker });
      return withMembership();
    }
    const dateAcquired = shared.dateAcquired ?? (flipped ? undefined : position?.dateAcquired);
    const costFx = sharedRate ? sharedRate.costFx : flipped || !position ? null : positionCostFx(position);
    const lot: TickerPosition = {
      portfolio: localCollectionId,
      shares: quantity,
      ...(flipped ? {} : { avgCost: position?.avgCost ?? 0 }),
      currency: lotCurrency,
      broker: "manual",
      ...(dateAcquired ? { dateAcquired } : {}),
      // So does the rate its cost was bought at, with its cost.
      ...(costFx ? { costFxRate: costFx.rate, costFxCurrency: costFx.currency } : {}),
      // A future's contract size stays with the holding when the team changes its count.
      ...(position?.multiplier ? { multiplier: position.multiplier } : {}),
    };
    // A single lot already as the server has it is left as it is.
    if (has && lotCount === 1 && position && position.shares === quantity && position.dateAcquired === lot.dateAcquired
      && position.costFxRate === lot.costFxRate && position.costFxCurrency === lot.costFxCurrency) return null;
    positions.push(lot);
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
