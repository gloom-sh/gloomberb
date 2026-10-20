import { useCallback, useMemo, useRef } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { PerpBoardRow, PerpEquityListing } from "../../../api-client/perps";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import type { TickerRecord } from "../../../types/ticker";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { perpetualListing } from "../../../tickers/perpetual-listing";
import { loadPerpSelection, loadPerpsEquities } from "./client";
import { perpEquityIdentity } from "./equity-identity";
import { useLivePerpRows } from "./live-rows";

const STOCK_TYPES = new Set(["STK", "EQUITY", "STOCK", "COMMON STOCK"]);
const listingKey = (listing: PerpEquityListing) => `${listing.symbol}:${listing.exchange}`;

/**
 * The listing a row asks about: a stock, or a saved ticker of no known type, on a venue the server can match.
 * Read from the saved record, not the quote, so quotes arriving never change the request.
 */
function rowListing(ticker: TickerRecord): PerpEquityListing | null {
  const type = ticker.metadata.assetCategory?.trim().toUpperCase();
  if (type && !STOCK_TYPES.has(type)) return null;
  return perpEquityIdentity(ticker.metadata.ticker, ticker.metadata.exchange);
}

/** A row that is a perpetual market itself: its own contract, by market id. */
const rowMarket = (ticker: TickerRecord) => perpetualListing(ticker.metadata.ticker, ticker.metadata.exchange)?.marketId ?? null;

const NO_PERPETUALS: ListPerpetuals = { markets: new Map(), version: 0, stale: false };
const NO_SYMBOLS: ReadonlySet<string> = new Set();
/** The most contracts a list follows on the quote stream at once: the rows in view. */
const LIVE_LIMIT = 60;

export interface ListPerpetuals {
  /** Each row's contract by ticker, null for none; a row is missing while its first answer loads. */
  markets: ReadonlyMap<string, PerpBoardRow | null>;
  /** Moves whenever `markets` does. */
  version: number;
  /** A refresh failed: the contracts shown are the last ones read. */
  stale: boolean;
}

interface ListRequest { listings: PerpEquityListing[]; markets: string[] }

/** A perpetual row's own market, as PERP reads one market; none when it cannot be read. */
async function loadOwnMarket(marketId: string, access: string, force: boolean): Promise<{ row: PerpBoardRow | null; stale: boolean }> {
  try {
    const result = await loadPerpSelection(marketId, access, force);
    return { row: result.payload.rows.find((row) => row.marketId === marketId) ?? null, stale: result.stale };
  } catch (error) {
    if (isAccessDenied(error)) throw error;
    return { row: null, stale: true };
  }
}

/**
 * The perpetual of every row in a watchlist or portfolio, refreshed once a minute: a stock's from one batch request
 * for the whole list, and a row that is itself a perpetual market its own contract, read as PERP reads one market.
 * A row's figures never wait on anything else: rows without a stock listing read as no perpetual at once, and a
 * failed or refused lookup leaves every row without one, as DES leaves out its perpetual row.
 */
export function useListPerpetuals(tickers: readonly TickerRecord[], enabled: boolean, liveSymbols: ReadonlySet<string> = NO_SYMBOLS): ListPerpetuals {
  const session = useResearchCloudSession();
  const plan = usePlanAccess();
  const accessKey = `${session.requestKey}:${plan.hasProAccess ? "pro" : "preview"}`;
  // The list's listings and markets, sorted and unique, as one string: a reorder or a quote keeps the same request.
  const requestKey = useMemo(() => {
    if (!enabled) return "";
    const listings = new Map<string, PerpEquityListing>();
    const markets = new Set<string>();
    for (const ticker of tickers) {
      const market = rowMarket(ticker);
      if (market) {
        markets.add(market);
        continue;
      }
      const listing = rowListing(ticker);
      if (listing) listings.set(listingKey(listing), listing);
    }
    if (!listings.size && !markets.size) return "";
    const request: ListRequest = {
      listings: [...listings].sort(([a], [b]) => a.localeCompare(b)).map(([, listing]) => listing),
      markets: [...markets].sort(),
    };
    return JSON.stringify(request);
  }, [enabled, tickers]);
  const loader = useCallback(async (force: boolean) => {
    const { listings, markets } = JSON.parse(requestKey) as ListRequest;
    const [equities, own] = await Promise.all([
      listings.length ? loadPerpsEquities(listings, accessKey, force) : null,
      Promise.all(markets.map((marketId) => loadOwnMarket(marketId, accessKey, force))),
    ]);
    return {
      listings,
      results: equities?.payload.results ?? [],
      markets: new Map(markets.map((marketId, index) => [marketId, own[index]!.row] as const)),
      stale: !!equities?.stale || own.some((market) => market.stale),
    };
  }, [accessKey, requestKey]);
  // An added row waits for its own answer while the others keep theirs.
  const resource = useAsyncResource(requestKey ? loader : null, { clearOnError: isAccessDenied, keepPreviousData: true });
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  const versionRef = useRef(0);
  const { data, loading } = resource;
  const fetched = useMemo(() => {
    if (!enabled) return NO_PERPETUALS;
    const byListing = new Map<string, PerpBoardRow | null>();
    data?.listings.forEach((listing, index) => byListing.set(listingKey(listing), data.results[index]?.market ?? null));
    const markets = new Map<string, PerpBoardRow | null>();
    for (const ticker of tickers) {
      const market = rowMarket(ticker);
      const listing = market ? null : rowListing(ticker);
      const key = listing ? listingKey(listing) : null;
      if (market && data?.markets.has(market)) markets.set(ticker.metadata.ticker, data.markets.get(market) ?? null);
      else if (key && byListing.has(key)) markets.set(ticker.metadata.ticker, byListing.get(key) ?? null);
      // Still loading: the row's cell waits. Otherwise there is nothing to show.
      else if ((!key && !market) || !loading) markets.set(ticker.metadata.ticker, null);
    }
    return { markets, version: 0, stale: !!data?.stale };
  }, [data, enabled, loading, tickers]);
  // The contracts of the rows in view follow the quote stream; each is subscribed once however many rows share it.
  const liveRows = useMemo(() => {
    const rows = new Map<string, PerpBoardRow>();
    for (const symbol of liveSymbols) {
      const row = fetched.markets.get(symbol);
      if (row && rows.size < LIVE_LIMIT) rows.set(row.marketId, row);
    }
    return [...rows.values()];
  }, [fetched, liveSymbols]);
  const live = useLivePerpRows(liveRows, { surface: "watchlist", enabled: enabled && liveRows.length > 0 });
  return useMemo(() => {
    if (fetched === NO_PERPETUALS) return NO_PERPETUALS;
    const byMarket = new Map(live.rows.map((row) => [row.marketId, row]));
    const markets = byMarket.size
      ? new Map([...fetched.markets].map(([symbol, row]) => [symbol, row ? byMarket.get(row.marketId) ?? row : row]))
      : fetched.markets;
    versionRef.current += 1;
    return { markets, version: versionRef.current, stale: fetched.stale };
  }, [fetched, live.rows]);
}
