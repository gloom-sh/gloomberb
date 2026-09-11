/**
 * Public utility surface for external plugins (`gloomberb/utils`).
 *
 * Everything re-exported here is a compatibility commitment: plugins in other
 * repositories import it, so removing or changing a signature is a breaking
 * change for them. Internal helpers stay internal — add to this barrel only
 * when a real plugin needs it, and prefer widening later over exporting
 * speculatively.
 *
 * `src/public/public-api.test.ts` checks that every subpath resolves and that a
 * bundled plugin shares the host's module instances.
 */

export { createThrottledFetch } from "../utils/throttled-fetch";
export type {
  ThrottledFetchClient,
  ThrottledFetchOptions,
  ThrottledFetchTransport,
} from "../utils/throttled-fetch";

export { normalizedHttpUrl } from "../utils/url";

export { formatRelativeAge } from "../utils/relative-time";

export { decodeHtmlEntities } from "../utils/html-entities";

export { isPlainKey, isPlainKeyboardEvent } from "../utils/keyboard";
export type { KeyboardModifierEventLike } from "../utils/keyboard";

export {
  displayWidth,
  formatCompact,
  formatCompactCurrency,
  formatCurrency,
  formatGrowthShort,
  formatNumber,
  formatPercent,
  formatPercentRaw,
  formatTimeAgo,
  formatWithDivisor,
  padTo,
  pickUnit,
  truncateToDisplayWidth,
} from "../utils/format";

// Broker and instrument helpers. IBKR needs all of these, and any broker plugin
// will: instance lookup, currency minor units, venue normalization, and stable
// hashing for cache keys.
export {
  buildBrokerPortfolioId,
  createBrokerInstanceId,
  getBrokerInstance,
  getBrokerInstancesByType,
  isBrokerPortfolioId,
} from "../utils/broker-instances";
export {
  hasLikelyQuoteUnitMismatch,
  normalizePriceValueByDivisor,
  resolveCurrencyUnit,
  resolveExchangeSubUnitCurrencyUnit,
  resolvePriceHistoryCurrencyUnit,
} from "../utils/currency-units";
export type { CurrencyUnitInfo } from "../utils/currency-units";
export {
  canonicalExchange,
  canonicalTickerKey,
  normalizeSymbol,
  parsePublicTickerKey,
  publicExchange,
  publicTickerKey,
  resolveExchangeTimeZone,
} from "../utils/exchanges";
export { fnv1aHashString } from "../utils/hash";
export { splitLongTextSegmentByDisplayWidth, truncateWithEllipsis, wrapTextLines } from "../utils/text-wrap";
export { httpFetch, setHttpFetchTransport } from "../utils/http-transport";
export type { HttpFetchTransport } from "../utils/http-transport";
export { debugLog } from "../utils/debug-log";

// A pane that fetches on its own schedule and wants to survive restarts: a
// persisted cache keyed by the plugin, with a TTL and a stale-while-refresh
// read. The Fear & Greed and IPO calendar plugins both keep their last good
// payload this way so the pane has something to show before the first fetch.
export { createPluginCache } from "../data/plugin-cache";
export type { PluginCacheResult } from "../data/plugin-cache";

// Table sorting, so a plugin table cycles its sort the same way built-in ones
// do and orders mixed null/number/string columns identically.
export { compareSortValues, cycleSortPreference } from "../utils/sort-values";
export type { SortDirection, SortPreference } from "../utils/sort-values";

// Exchange schedules are published as wall-clock times in a named zone.
export { zonedDateTimeParts, zonedWallClockToUtcMs } from "../utils/zoned-date-time";

// A list pane with a search field hands the arrow keys between the two.
export { isPlainArrowUp, stopSearchFocusNavigation } from "../utils/search-focus-navigation";
