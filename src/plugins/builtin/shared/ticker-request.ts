import { useCallback } from "react";
import { ApiRequestError } from "../../../api-client/errors";
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
 * The pane's symbol for research panes that load their own data. Identity only:
 * it does not observe the quote, so a price tick does not re-render the pane.
 */
export function useBoundTicker() {
  const { symbol, ticker } = usePaneTickerIdentity();
  return {
    symbol,
    ticker,
    exchange: ticker?.metadata.exchange ?? "",
    currency: ticker?.metadata.currency ?? "USD",
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

export function formatDateTime(date: Date): string {
  const iso = date.toISOString();
  const hasTime = date.getUTCHours() !== 0 || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0;
  return hasTime ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}
