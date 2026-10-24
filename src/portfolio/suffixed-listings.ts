import type { AppConfig } from "../types/config";
import type { TickerMetadata, TickerPosition, TickerRecord } from "../types/ticker";
import { listingSuffixVenue, tickerHasListingSuffix } from "../sources/listing-symbols";
import { canonicalExchange, parsePublicTickerKey, publicTickerKey } from "../utils/exchanges";

/**
 * Where a listing's row notes the lots it took from a suffixed row, by that
 * row's key: a copy of the suffixed row sync brings back with the same lots
 * is then not counted twice.
 */
const MERGED_LOTS = "mergedListingLots";

/** The fields that make two lots the same lot. */
const LOT_FIELDS = [
  "portfolio", "shares", "avgCost", "currency", "dateAcquired", "costFxRate", "costFxCurrency", "broker", "side", "multiplier", "priceBasis",
] as const satisfies ReadonlyArray<keyof TickerPosition>;

function lotFingerprint(lot: TickerPosition): string {
  return JSON.stringify(LOT_FIELDS.map((field) => lot[field] ?? null));
}

export interface SuffixedListingMerge {
  /** The rows that changed: each listing's row with what its suffixed rows held, and those rows emptied. */
  saves: TickerRecord[];
  /** Each emptied row's key, to the key of the row it went into. */
  moved: Map<string, string>;
}

function isFiled(metadata: TickerMetadata): boolean {
  return metadata.portfolios.length > 0 || metadata.watchlists.length > 0 || metadata.positions.length > 0;
}

/** A broker's row: the broker keys what it reports, and its next sync writes there again. */
function isBrokerRow(metadata: TickerMetadata): boolean {
  return (metadata.broker_contracts ?? []).length > 0 || metadata.positions.some((position) => position.broker !== "manual");
}

function union(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

/**
 * The key a listing's row is saved under, as saving GARAN:BIST picks it: the
 * row already there (the bare symbol, or SYMBOL:VENUE beside another venue's
 * row), else the bare symbol when it is free, else SYMBOL:VENUE.
 */
function listingKey(symbol: string, exchange: string, rows: ReadonlyMap<string, TickerRecord>): string {
  const onVenue = (key: string) => {
    const row = rows.get(key);
    return !!row && canonicalExchange(row.metadata.exchange) === exchange;
  };
  const venueKey = publicTickerKey(symbol, exchange);
  if (onVenue(symbol)) return symbol;
  if (onVenue(venueKey)) return venueKey;
  const named = [...rows.keys()].find((key) => {
    const parsed = parsePublicTickerKey(key);
    return parsed.symbol === symbol && !!parsed.exchange && onVenue(key);
  });
  if (named) return named;
  return rows.has(symbol) ? venueKey : symbol;
}

/**
 * Rows a portfolio or watchlist holds under a vendor's suffixed key (GARAN.IS
 * on BIST), merged into their listing's own row (GARAN on BIST, the row
 * GARAN:BIST is saved as), which is made when there is none: memberships,
 * tags and custom fields join, and lots are added, each once (`MERGED_LOTS`).
 * The suffixed row stays, emptied, for a link or a layout that names it. A
 * broker's row is the broker's to key and stays as it is. Null when there is
 * nothing to merge.
 */
export function mergeSuffixedListings(tickers: readonly TickerRecord[]): SuffixedListingMerge | null {
  const rows = new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker] as const));
  const changed = new Set<string>();
  const moved = new Map<string, string>();
  for (const { metadata: suffixed } of tickers) {
    if (!isFiled(suffixed) || isBrokerRow(suffixed)) continue;
    const parsed = parsePublicTickerKey(suffixed.ticker);
    if (!tickerHasListingSuffix(parsed.symbol)) continue;
    const venue = listingSuffixVenue(parsed.symbol, parsed.exchange ?? suffixed.exchange);
    if (!venue) continue;
    const key = listingKey(venue.symbol, venue.exchange, rows);
    const existing = rows.get(key)?.metadata;
    const listing: TickerMetadata = existing ?? {
      ...suffixed, ticker: key, exchange: suffixed.exchange || venue.exchange, portfolios: [], watchlists: [], positions: [], tags: [], custom: {},
    };
    // Lots this row took from the suffixed key before count once: a copy sync brings back is not added again.
    const notes = (listing.custom[MERGED_LOTS] ?? {}) as Record<string, string[]>;
    const taken = [...notes[suffixed.ticker] ?? []];
    const unseen = [...taken];
    const added: TickerPosition[] = [];
    for (const lot of suffixed.positions) {
      const fingerprint = lotFingerprint(lot);
      const seen = unseen.indexOf(fingerprint);
      if (seen >= 0) {
        unseen.splice(seen, 1);
        continue;
      }
      added.push(lot);
      taken.push(fingerprint);
    }
    rows.set(key, {
      metadata: {
        ...listing,
        name: listing.name || suffixed.name,
        currency: listing.currency || suffixed.currency,
        portfolios: union(listing.portfolios, [...suffixed.portfolios, ...added.map((lot) => lot.portfolio)]),
        watchlists: union(listing.watchlists, suffixed.watchlists),
        positions: [...listing.positions, ...added],
        tags: union(listing.tags, suffixed.tags),
        custom: { ...suffixed.custom, ...listing.custom, ...taken.length > 0 ? { [MERGED_LOTS]: { ...notes, [suffixed.ticker]: taken } } : {} },
      },
    });
    rows.set(suffixed.ticker, { metadata: { ...suffixed, portfolios: [], watchlists: [], positions: [], tags: [], custom: {} } });
    // The listing's row first: saved in this order, a stop between the two loses nothing.
    changed.add(key).add(suffixed.ticker);
    moved.set(suffixed.ticker, key);
  }
  return moved.size > 0 ? { saves: [...changed].map((key) => rows.get(key)!), moved } : null;
}

/**
 * The config with each portfolio's target for a merged row moved to the row
 * it went into, added to any target that row had: the two rows' share of the
 * portfolio is one listing's. The same config when no target moved.
 */
function moveTargetWeights(config: AppConfig, moved: ReadonlyMap<string, string>): AppConfig {
  let changed = false;
  const portfolios = config.portfolios.map((portfolio) => {
    const targets = portfolio.targetWeights;
    if (!targets || ![...moved.keys()].some((key) => key in targets)) return portfolio;
    const next = { ...targets };
    for (const [from, to] of moved) {
      if (!(from in next)) continue;
      next[to] = (next[to] ?? 0) + next[from]!;
      delete next[from];
    }
    changed = true;
    return { ...portfolio, targetWeights: next };
  });
  return changed ? { ...config, portfolios } : config;
}

/**
 * `mergeSuffixedListings` for a saved profile, as it loads: the changed rows
 * are saved, each listing's row before the row it took from, and the config
 * comes back with targets moved (saving it is the caller's). The tickers come
 * back as they now are. Null when there was nothing to merge.
 */
export async function mergeSavedSuffixedListings(
  tickers: readonly TickerRecord[],
  config: AppConfig,
  save: (rows: TickerRecord[]) => Promise<void>,
): Promise<{ tickers: TickerRecord[]; config: AppConfig } | null> {
  const merge = mergeSuffixedListings(tickers);
  if (!merge) return null;
  await save(merge.saves);
  const saved = new Map(merge.saves.map((row) => [row.metadata.ticker, row] as const));
  const kept = tickers.map((ticker) => saved.get(ticker.metadata.ticker) ?? ticker);
  const added = merge.saves.filter((row) => !tickers.some((ticker) => ticker.metadata.ticker === row.metadata.ticker));
  return { tickers: [...kept, ...added], config: moveTargetWeights(config, merge.moved) };
}
