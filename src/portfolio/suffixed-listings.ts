import type { AppConfig } from "../types/config";
import type { TickerMetadata, TickerPosition, TickerRecord } from "../types/ticker";
import { listingSuffixVenue, tickerHasListingSuffix } from "../sources/listing-symbols";
import { canonicalExchange, parsePublicTickerKey, publicTickerKey } from "../utils/exchanges";

/**
 * A lot as the fields sync keeps of it (`sanitizePosition`), so a copy that
 * went through sync, or through an older build, reads as the same lot.
 */
function lotFingerprint(lot: TickerPosition): string {
  const costFx = lot.costFxRate != null && lot.costFxCurrency ? [lot.costFxRate, lot.costFxCurrency] : [null, null];
  return JSON.stringify([
    lot.portfolio, lot.shares, lot.avgCost ?? null, lot.currency ?? null, lot.dateAcquired ?? null, ...costFx,
    lot.broker, lot.side ?? null, lot.multiplier ?? null,
  ]);
}

interface SuffixedListingMerge {
  /** The rows to save: each listing's row with what its suffixed rows held, then those rows emptied. */
  saves: TickerRecord[];
  /**
   * Each suffixed row's key to its listing row's key: the rows merged now,
   * and ones merged before, whose targets an older copy of the config may
   * still name.
   */
  moved: Map<string, string>;
  /** Custom fields a suffixed row held another value for than its listing's row did: kept on the suffixed row. */
  keptCustom: Array<{ from: string; into: string; fields: string[] }>;
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

function isEmptyValue(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

/**
 * The listing's custom fields with the suffixed row's: the listing's value
 * where it has one, else the suffixed row's. A field both hold with other
 * values keeps the listing's, and the suffixed row's value stays with it.
 */
function mergeCustom(listing: Record<string, unknown>, suffixed: Record<string, unknown>) {
  const custom = { ...listing };
  const kept: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(suffixed)) {
    if (isEmptyValue(value)) continue;
    if (isEmptyValue(custom[field])) custom[field] = value;
    else if (JSON.stringify(custom[field]) !== JSON.stringify(value)) kept[field] = value;
  }
  return { custom, kept };
}

/**
 * The key of a listing's row (SYMBOL on VENUE): the row saved there already,
 * under the bare symbol or a venue key, else, when `create`, the venue's key
 * (GARAN:BIST, SHOP:XTSE). A merge never takes the bare key, so typing SHOP
 * still means the US listing. Null when there is none to take, or the
 * venue's key holds another venue's row.
 */
function listingKey(
  symbol: string,
  exchange: string,
  rows: ReadonlyMap<string, TickerRecord>,
  keysBySymbol: ReadonlyMap<string, readonly string[]>,
  create: boolean,
): string | null {
  const onVenue = (key: string) => canonicalExchange(rows.get(key)?.metadata.exchange) === exchange;
  const venueKey = publicTickerKey(symbol, exchange);
  if (onVenue(symbol)) return symbol;
  if (onVenue(venueKey)) return venueKey;
  const named = keysBySymbol.get(symbol)?.find((key) => !!parsePublicTickerKey(key).exchange && onVenue(key));
  if (named) return named;
  return create && !rows.has(venueKey) ? venueKey : null;
}

/**
 * Rows a portfolio or watchlist holds under a vendor's suffixed key (GARAN.IS
 * on BIST) merged into their listing's own row (GARAN on BIST), which is made
 * when there is none (`listingKey`): memberships, tags and custom fields
 * (`mergeCustom`) join, and lots are added, each once: the listing's row
 * records what it took (`mergedLots`), so a copy sync brings back is not
 * counted twice. The suffixed row stays, emptied, for a link or a layout that
 * names it. A broker's row is the broker's to key and stays as it is, and so
 * does a suffix no saved venue confirms (`listingSuffixVenue`: MKC.V on NYSE
 * is a share class). Null when no suffixed row has a listing's row.
 */
export function mergeSuffixedListings(tickers: readonly TickerRecord[]): SuffixedListingMerge | null {
  const rows = new Map(tickers.map((ticker) => [ticker.metadata.ticker, ticker] as const));
  const keysBySymbol = new Map<string, string[]>();
  const index = (key: string) => {
    const { symbol } = parsePublicTickerKey(key);
    keysBySymbol.set(symbol, [...keysBySymbol.get(symbol) ?? [], key]);
  };
  for (const key of rows.keys()) index(key);
  const listings = new Set<string>();
  const emptied = new Set<string>();
  const moved = new Map<string, string>();
  const keptCustom: SuffixedListingMerge["keptCustom"] = [];
  for (const { metadata: suffixed } of tickers) {
    if (isBrokerRow(suffixed)) continue;
    const parsed = parsePublicTickerKey(suffixed.ticker);
    if (!tickerHasListingSuffix(parsed.symbol)) continue;
    const venue = listingSuffixVenue(parsed.symbol, parsed.exchange ?? suffixed.exchange);
    if (!venue) continue;
    const filed = isFiled(suffixed);
    const key = listingKey(venue.symbol, venue.exchange, rows, keysBySymbol, filed);
    if (!key) continue;
    moved.set(suffixed.ticker, key);
    if (!filed) continue;
    const existing = rows.get(key)?.metadata;
    if (!existing) index(key);
    const { mergedLots: _lots, broker_contracts: _contracts, ...rest } = suffixed;
    const listing: TickerMetadata = existing ?? {
      ...rest, ticker: key, exchange: venue.exchange, portfolios: [], watchlists: [], positions: [], tags: [], custom: {},
    };
    // Lots the listing's row took from this key before count once: a copy brought back is not added again.
    const taken = [...listing.mergedLots?.[suffixed.ticker] ?? []];
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
    const { custom, kept } = mergeCustom(listing.custom, suffixed.custom);
    if (Object.keys(kept).length > 0) keptCustom.push({ from: suffixed.ticker, into: key, fields: Object.keys(kept) });
    rows.set(key, {
      metadata: {
        ...listing,
        name: listing.name || suffixed.name,
        currency: listing.currency || suffixed.currency,
        portfolios: union(listing.portfolios, [...suffixed.portfolios, ...added.map((lot) => lot.portfolio)]),
        watchlists: union(listing.watchlists, suffixed.watchlists),
        positions: [...listing.positions, ...added],
        tags: union(listing.tags, suffixed.tags),
        custom,
        ...taken.length > 0 ? { mergedLots: { ...listing.mergedLots, [suffixed.ticker]: taken } } : {},
      },
    });
    rows.set(suffixed.ticker, { metadata: { ...suffixed, portfolios: [], watchlists: [], positions: [], tags: [], custom: kept } });
    listings.add(key);
    emptied.add(suffixed.ticker);
  }
  if (moved.size === 0) return null;
  // The listings' rows first: saved in this order, a stop between them loses nothing.
  return { saves: [...listings, ...emptied].map((key) => rows.get(key)!), moved, keptCustom };
}

/**
 * The config with each portfolio's target for a suffixed key moved to its
 * listing's row, added to any target that row had: the two rows' share of
 * the portfolio is one listing's. The same config when no target moved.
 */
export function moveTargetWeights(config: AppConfig, moved: ReadonlyMap<string, string>): AppConfig {
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
 * `mergeSuffixedListings` for a saved profile: the config with its targets
 * moved is saved first, then the rows, the listings' before the ones they
 * took from, so a stop at any point leaves nothing a second run does not
 * finish. The profile comes back as it now is; null when nothing changed.
 */
export async function mergeSavedSuffixedListings(
  tickers: readonly TickerRecord[],
  config: AppConfig,
  save: { config: (config: AppConfig) => Promise<void>; tickers: (rows: TickerRecord[]) => Promise<void> },
): Promise<{ tickers: TickerRecord[]; config: AppConfig; keptCustom: SuffixedListingMerge["keptCustom"] } | null> {
  const merge = mergeSuffixedListings(tickers);
  if (!merge) return null;
  const nextConfig = moveTargetWeights(config, merge.moved);
  if (merge.saves.length === 0 && nextConfig === config) return null;
  if (nextConfig !== config) await save.config(nextConfig);
  if (merge.saves.length > 0) await save.tickers(merge.saves);
  const saved = new Map(merge.saves.map((row) => [row.metadata.ticker, row] as const));
  const kept = tickers.map((ticker) => saved.get(ticker.metadata.ticker) ?? ticker);
  const keys = new Set(tickers.map((ticker) => ticker.metadata.ticker));
  const added = merge.saves.filter((row) => !keys.has(row.metadata.ticker));
  return { tickers: [...kept, ...added], config: nextConfig, keptCustom: merge.keptCustom };
}
