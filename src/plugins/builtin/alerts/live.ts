import { getSharedMarketDataCoordinator, type MarketDataCoordinator } from "../../../market-data/coordinator";
import type { QuoteSubscriptionHandle } from "../../../market-data/coordinator/quotes";
import { getActiveQuoteDisplay } from "../../../market-data/market/status";
import type { InstrumentRef } from "../../../market-data/request-types";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import { isAppVisible, subscribeAppVisibility } from "../../../state/app/activity";
import type { Quote } from "../../../types/financials";
import type { AlertRule } from "./types";

/** A streamed quote older than this no longer judges an alert; the poll takes the symbol back. */
export const ALERT_STREAM_FRESH_MS = 90_000;
/**
 * Alerts watch symbols nobody may be looking at, so they rank below anything
 * on screen and ride the server's off-screen cadence.
 */
const ALERT_STREAM_WEIGHT = 20;

export function alertInstrument(alert: Pick<AlertRule, "symbol" | "exchange">): InstrumentRef {
  return { symbol: alert.symbol, exchange: alert.exchange ?? "" };
}

/**
 * The price an alert compares, from a streamed quote fresh enough to act on.
 * Snapshot loads, stale connections and quiet symbols return null, which
 * leaves the symbol to the poll.
 */
export function streamedAlertQuote(quote: Quote | null | undefined, now = Date.now()): Quote | null {
  if (!quote || quote.delivery !== "stream" || quote.stale === true) return null;
  const receivedAt = quote.receivedAt;
  if (typeof receivedAt !== "number" || !Number.isFinite(receivedAt) || now - receivedAt > ALERT_STREAM_FRESH_MS) return null;
  const display = getActiveQuoteDisplay(quote);
  if (!display || !Number.isFinite(display.price)) return null;
  return {
    ...quote,
    price: display.price,
    change: display.change ?? Number.NaN,
    changePercent: display.changePercent ?? Number.NaN,
  };
}

export function readStreamedAlertQuote(
  alert: Pick<AlertRule, "symbol" | "exchange">,
  coordinator: MarketDataCoordinator | null = getSharedMarketDataCoordinator(),
  now = Date.now(),
): Quote | null {
  if (!coordinator) return null;
  return streamedAlertQuote(resolveEntryData(coordinator.getQuoteEntry(alertInstrument(alert))), now);
}

export interface AlertQuoteStream {
  /** Re-read the active alerts and follow exactly their symbols. */
  sync(): void;
  dispose(): void;
}

/**
 * Keeps the active alerts' symbols on the shared quote feed and reports when
 * any of them moves. Like every stream it pauses while the app is hidden;
 * the alert poll carries the symbols then.
 */
export function createAlertQuoteStream({
  readAlerts,
  onQuotes,
}: {
  readAlerts: () => AlertRule[];
  onQuotes: () => void;
}): AlertQuoteStream {
  let disposed = false;
  let coordinator: MarketDataCoordinator | null = null;
  let handle: QuoteSubscriptionHandle | null = null;
  let keySignature = "";
  let unsubscribeKeys: (() => void) | null = null;

  const teardown = () => {
    unsubscribeKeys?.();
    unsubscribeKeys = null;
    keySignature = "";
    handle?.();
    handle = null;
    coordinator = null;
  };

  const sync = () => {
    if (disposed) return;
    const next = getSharedMarketDataCoordinator();
    const instruments = new Map<string, InstrumentRef>();
    for (const alert of readAlerts()) {
      if (alert.status !== "active") continue;
      const instrument = alertInstrument(alert);
      instruments.set(buildQuoteKey(instrument), instrument);
    }
    if (!next || instruments.size === 0 || !isAppVisible()) {
      teardown();
      return;
    }
    if (next !== coordinator) teardown();
    coordinator = next;
    const targets = [...instruments.values()].map((instrument) => ({
      instrument,
      priority: { surface: "unknown" as const, visible: false, selected: false, weight: ALERT_STREAM_WEIGHT },
    }));
    if (handle) handle.update(targets);
    else handle = next.subscribeQuotes(targets);

    const keys = [...instruments.keys()].sort();
    const signature = keys.join("\u001f");
    if (signature === keySignature) return;
    unsubscribeKeys?.();
    keySignature = signature;
    unsubscribeKeys = next.subscribeKeys(keys, onQuotes);
  };

  const unsubscribeVisibility = subscribeAppVisibility(sync);
  sync();

  return {
    sync,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeVisibility();
      teardown();
    },
  };
}
