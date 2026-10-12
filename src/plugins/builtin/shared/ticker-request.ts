import { useCallback, useMemo } from "react";
import { ApiRequestError } from "../../../api-client/errors";
import { listingAbroad, type IssuerListingParams } from "../../../api-client/paths";
import type { TickerRecord } from "../../../types/ticker";
import { useAsyncResource } from "../../../react/async-resource";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { isCloudSessionRequired } from "./research-cloud-session";

function discardDeniedResearch(error: unknown): boolean {
  return (error instanceof ApiRequestError && [401, 402, 403].includes(error.status ?? 0))
    || isCloudSessionRequired(error instanceof Error ? error.message : String(error));
}

/**
 * The bare symbol and exchange behind a ticker key. A listing chosen from
 * search is keyed "AMD:XNAS"; Cloud research endpoints take "AMD" plus the
 * exchange, and the key's exchange wins over saved metadata.
 */
export function listingIdentity(key: string | null | undefined, savedExchange = ""): { symbol: string; exchange: string } | null {
  const value = key?.trim();
  if (!value) return null;
  const parsed = parsePublicTickerKey(value);
  return { symbol: parsed.symbol.toUpperCase(), exchange: parsed.exchange ?? savedExchange };
}

/**
 * The venue and company an SEC issuer read names for the pane's listing, from
 * the pane's ticker as the SEC filings pane reads it: the key's venue, else the
 * saved one, and the company the listing was saved as (listingAbroad). Nothing
 * for a US listing or a symbol with no venue. A name that is only the symbol
 * is left out, so the server falls back to the name on a quote it holds.
 */
function issuerListing(ticker: TickerRecord | null | undefined): IssuerListingParams {
  if (!ticker) return {};
  const key = ticker.metadata.ticker.trim().toUpperCase();
  const name = ticker.metadata.name?.trim();
  const known = !!name && ![key, parsePublicTickerKey(key).symbol].includes(name.toUpperCase());
  const abroad = listingAbroad(key, ticker.metadata.exchange, known ? name : undefined);
  return { exchange: abroad?.exchange, name: abroad?.name };
}

/** `issuerListing` as a stable value, for loader dependencies. */
export function useIssuerListing(ticker: TickerRecord | null | undefined): IssuerListingParams {
  const { exchange, name } = issuerListing(ticker);
  return useMemo(() => ({ exchange, name }), [exchange, name]);
}

/**
 * The pane's symbol for research panes that load their own data. Identity only:
 * it does not observe the quote, so a price tick does not re-render the pane.
 */
export function useBoundTicker() {
  const { symbol, ticker } = usePaneTickerIdentity();
  return {
    symbol,
    ticker,
    exchange: ticker?.metadata.exchange ?? "",
    currency: ticker?.metadata.currency || "USD",
  };
}

export function useTickerRequest<T>(
  loader: (symbol: string, exchange: string, forceRefresh: boolean) => Promise<T>,
  symbol: string | null,
  exchange: string,
) {
  const request = useCallback((force: boolean) => loader(symbol!, exchange, force), [exchange, loader, symbol]);
  const { data, loading, error, reload } = useAsyncResource(symbol ? request : null, { clearOnError: discardDeniedResearch });
  return { data, loading, error: symbol ? error : "No ticker selected", reload };
}
