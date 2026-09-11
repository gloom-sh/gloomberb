/**
 * Public live-quote surface for external plugins (`gloomberb/quotes`).
 *
 * `useMarketData()` from `gloomberb/react` hands a plugin the `DataProvider`
 * for one-off reads. This module is the streaming layer on top of it: a pane
 * that shows many symbols at once subscribes to them here and receives the
 * same live or polled updates the host's own screeners get, through the same
 * subscription registry, so two panes watching the same symbol share one feed.
 *
 * It is a shared host module, not something a plugin bundle can carry a copy
 * of: the subscriptions live in host state, and a second instance would open a
 * second feed and never see the first one's updates.
 *
 * Compatibility commitment: see the note in `./utils.ts`.
 */

// Subscribing a list of targets and reading the entries as they update.
export { DEFAULT_QUOTE_POLL_INTERVAL_MS, useLiveQuoteEntries } from "../state/hooks/quote-streaming";
export type { QuoteUpdateOptions } from "../state/hooks/quote-streaming";
export type { QuoteSubscriptionTarget } from "../types/data-provider";
export type { QueryEntry } from "../market-data/result-types";
export type { Quote } from "../types/financials";

// A screener-style pane holds rows it fetched itself and overlays the live
// feed on top. These are the host's helpers for that pattern: build the
// subscription targets from the rows, merge the entries back in, and summarise
// whether the feed is live, mixed, or polling for the footer.
export {
  buildScreenerQuoteTargets,
  overlayScreenerQuoteEntries,
  resolveScreenerQuoteFeedStatus,
} from "../plugins/builtin/shared/screener-live-quotes";
export type {
  ScreenerQuoteFeedStatus,
  ScreenerQuoteFreshness,
  ScreenerQuoteRow,
} from "../plugins/builtin/shared/screener-live-quotes";

// The persisted "Live streaming" pane setting and its quick toggle, so a
// plugin pane offers the same control, on the same key, as the built-ins.
export {
  LIVE_STREAMING_QUICK_SETTING,
  LIVE_STREAMING_SETTING_FIELD,
  LIVE_STREAMING_SETTING_KEY,
  resolveLiveStreamingSetting,
  useLiveStreamingSetting,
  withLiveStreamingSetting,
} from "../plugins/builtin/shared/live-streaming";
