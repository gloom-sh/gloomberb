import { useCallback, useMemo, useRef } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { PerpBoardRow, PerpEquityListing } from "../../../api-client/perps";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import type { TickerRecord } from "../../../types/ticker";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { loadPerpsEquities } from "./client";
import { perpEquityIdentity } from "./equity-identity";

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

const NO_PERPETUALS: ListPerpetuals = { markets: new Map(), version: 0, stale: false };

export interface ListPerpetuals {
  /** Each row's contract by ticker, null for none; a row is missing while its first answer loads. */
  markets: ReadonlyMap<string, PerpBoardRow | null>;
  /** Moves whenever `markets` does. */
  version: number;
  /** A refresh failed: the contracts shown are the last ones read. */
  stale: boolean;
}

/**
 * The stock perpetual of every row in a watchlist or portfolio, from one batch request for the whole list, refreshed
 * once a minute. A row's figures never wait on anything else: rows without a stock listing read as no perpetual at
 * once, and a failed or refused lookup leaves every row without one, as DES leaves out its perpetual row.
 */
export function useListPerpetuals(tickers: readonly TickerRecord[], enabled: boolean): ListPerpetuals {
  const session = useResearchCloudSession();
  const plan = usePlanAccess();
  const accessKey = `${session.requestKey}:${plan.hasProAccess ? "pro" : "preview"}`;
  // The list's listings, sorted and unique, as one string: a reorder or a quote keeps the same request.
  const requestKey = useMemo(() => {
    if (!enabled) return "";
    const listings = new Map<string, PerpEquityListing>();
    for (const ticker of tickers) {
      const listing = rowListing(ticker);
      if (listing) listings.set(listingKey(listing), listing);
    }
    return listings.size ? JSON.stringify([...listings].sort(([a], [b]) => a.localeCompare(b)).map(([, listing]) => listing)) : "";
  }, [enabled, tickers]);
  const loader = useCallback(async (force: boolean) => {
    const listings = JSON.parse(requestKey) as PerpEquityListing[];
    return { listings, ...(await loadPerpsEquities(listings, accessKey, force)) };
  }, [accessKey, requestKey]);
  // An added row waits for its own answer while the others keep theirs.
  const resource = useAsyncResource(requestKey ? loader : null, { clearOnError: isAccessDenied, keepPreviousData: true });
  useAutoRefresh(resource.updatedAt, resource.load, { intervalMs: 60_000 });
  const versionRef = useRef(0);
  const { data, loading } = resource;
  return useMemo(() => {
    if (!enabled) return NO_PERPETUALS;
    const byListing = new Map<string, PerpBoardRow | null>();
    data?.listings.forEach((listing, index) => byListing.set(listingKey(listing), data.payload.results[index]?.market ?? null));
    const markets = new Map<string, PerpBoardRow | null>();
    for (const ticker of tickers) {
      const listing = rowListing(ticker);
      const key = listing ? listingKey(listing) : null;
      if (key && byListing.has(key)) markets.set(ticker.metadata.ticker, byListing.get(key) ?? null);
      // Still loading: the row's cell waits. Otherwise there is nothing to show.
      else if (!key || !loading) markets.set(ticker.metadata.ticker, null);
    }
    versionRef.current += 1;
    return { markets, version: versionRef.current, stale: !!data?.stale };
  }, [data, enabled, loading, tickers]);
}
