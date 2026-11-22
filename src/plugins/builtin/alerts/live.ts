import { getSharedMarketDataCoordinator, type MarketDataCoordinator, type StreamTickFollow } from "../../../market-data/coordinator";
import type { QuoteSubscriptionHandle } from "../../../market-data/coordinator/quotes";
import { getActiveQuoteDisplay, withActiveQuoteDisplay } from "../../../market-data/market/status";
import type { StreamTickRange, StreamTickReading } from "../../../market-data/quotes/tick-range";
import type { InstrumentRef } from "../../../market-data/request-types";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import { isAppVisible, subscribeAppVisibility } from "../../../state/app/activity";
import { savedCopyAt } from "../../../data/saved-copies";
import type { Quote } from "../../../types/financials";
import type { AlertRule } from "./types";

/** A streamed quote older than this no longer judges an alert; the poll takes the symbol back. */
const ALERT_STREAM_FRESH_MS = 90_000;
/**
 * Alerts watch symbols nobody may be looking at, so they rank below anything
 * on screen and ride the server's off-screen cadence.
 */
const ALERT_STREAM_WEIGHT = 20;

/**
 * The listing an alert's quotes stream on: the one it names, or for a rule set
 * by symbol alone (BTC-USD, AAPL, EURUSD=X, GC=F) the venue its last quote
 * was from, so it follows the key a watchlist row of that listing streams on.
 * A bare symbol is a key of its own, and with many rows on screen the feed
 * left it, an off-screen target, without ticks.
 */
export function alertInstrument(alert: Pick<AlertRule, "symbol" | "exchange" | "lastQuoteExchange">): InstrumentRef {
  return { symbol: alert.symbol, exchange: alert.exchange || alert.lastQuoteExchange || "" };
}

/**
 * The price an alert compares, from a streamed quote fresh enough to act on.
 * Snapshot loads, stale connections, quiet symbols and a copy saved before
 * the app last closed return null, which leaves the symbol to the poll.
 */
export function streamedAlertQuote(quote: Quote | null | undefined, now = Date.now()): Quote | null {
  if (!quote || quote.delivery !== "stream" || quote.stale === true || savedCopyAt(quote) != null) return null;
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
  alert: Pick<AlertRule, "symbol" | "exchange" | "lastQuoteExchange" | "metric">,
  coordinator: MarketDataCoordinator | null = getSharedMarketDataCoordinator(),
  now = Date.now(),
): Quote | null {
  if (alert.metric || !coordinator) return null;
  return streamedAlertQuote(resolveEntryData(coordinator.getQuoteEntry(alertInstrument(alert))), now);
}

/**
 * A streamed alert quote as it read at another tick its frame folded in: that
 * tick's price, move and print time on the newest quote's session and listing.
 */
export function alertQuoteAtTick(quote: Quote, tick: StreamTickReading, now = Date.now()): Quote | null {
  const atTick = streamedAlertQuote(withActiveQuoteDisplay(quote, tick), now);
  return atTick && { ...atTick, lastUpdated: tick.lastUpdated ?? quote.lastUpdated };
}

export interface AlertQuoteStream {
  /** Re-read the active alerts and follow exactly their symbols. */
  sync(): void;
  /** The range of each symbol's ticks since the last take that priced other than its quote, by quote key. */
  takeTicks(): Map<string, StreamTickRange>;
  dispose(): void;
}

/** The stream the plugin runs, so edits made in the alerts pane reach it at once. */
let runningStream: AlertQuoteStream | null = null;

/** Follow the stored alerts' symbols now, after the pane re-armed, edited or deleted one. */
export function syncAlertQuoteStream(): void {
  runningStream?.sync();
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
  // Every tick is judged, not only the newest one each frame applies.
  let ticks: StreamTickFollow | null = null;

  const teardown = () => {
    unsubscribeKeys?.();
    unsubscribeKeys = null;
    ticks?.dispose();
    ticks = null;
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
      // A move rule that went off is still followed: the next session's quote arms it again.
      if (alert.metric || (alert.status !== "active" && !alert.move)) continue;
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
    // A symbol still followed keeps the ticks it gathered and nobody took yet.
    if (ticks) ticks.update(keys);
    else ticks = next.followStreamTicks(keys, onQuotes);
  };

  const unsubscribeVisibility = subscribeAppVisibility(sync);
  sync();

  const stream: AlertQuoteStream = {
    sync,
    takeTicks: () => ticks?.take() ?? new Map(),
    dispose() {
      if (disposed) return;
      disposed = true;
      if (runningStream === stream) runningStream = null;
      unsubscribeVisibility();
      teardown();
    },
  };
  runningStream = stream;
  return stream;
}
