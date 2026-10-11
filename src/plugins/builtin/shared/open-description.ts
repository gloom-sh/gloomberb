import { useCallback } from "react";
import { useAppGetState } from "../../../state/app/context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey, publicTickerKey } from "../../../utils/exchanges";
import { usePluginTickerActions } from "../../runtime";

/**
 * Opens a listing's DES the way a ticker link does: the research pane already open for that listing comes
 * forward, and a new one floats only when there is none. Every pane's DES hand-off (`d`, a menu entry, a
 * linked row) goes through here, so none opens `NEE:XNYS` beside the `NEE` already on screen.
 *
 * The listing opens under the key DES gives it: a US listing under its bare symbol (the US venues share one
 * namespace), as does a listing abroad already saved under its bare symbol. A bare symbol saved for another
 * listing keeps the venue on, so the security asked for is the one that opens.
 */
export function useOpenDescription(): (ticker: string, exchange?: string) => void {
  const { pinTicker } = usePluginTickerActions();
  const getState = useAppGetState();
  return useCallback((ticker: string, exchange?: string) => {
    // A key keeps its own spelling (`ADYEN:AMS`): it may be the one a saved ticker has.
    const key = exchange ? publicTickerKey(ticker.trim(), exchange) : ticker.trim().toUpperCase();
    const { symbol, exchange: venue } = parsePublicTickerKey(key);
    const saved = venue ? getState().tickers.get(symbol)?.metadata.exchange : undefined;
    const bare = saved
      ? canonicalExchange(saved) === venue || (isUsListingExchange(saved) && isUsListingExchange(venue))
      : isUsListingExchange(venue);
    pinTicker(bare ? symbol : key, { floating: true, paneType: TICKER_RESEARCH_PANE_ID });
  }, [getState, pinTicker]);
}
