/**
 * Public utility surface for external plugins (`gloomberb/utils`).
 *
 * Everything re-exported here is a compatibility commitment: plugins in other
 * repositories import it, so removing or changing a signature is a breaking
 * change for them. Internal helpers stay internal — add to this barrel only
 * when a real plugin needs it, and prefer widening later over exporting
 * speculatively.
 *
 * `scripts/check-public-api.ts` pins the exported names so the surface cannot
 * grow by accident during an unrelated refactor.
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
