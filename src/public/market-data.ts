/**
 * Market-data request shapes and price formatting (`gloomberb/market-data`).
 *
 * A plugin that provides quotes or history has to build the same request
 * objects the host does, and format prices the same way, or its output looks
 * foreign next to first-party panes.
 */
// The names are listed rather than re-exported with `*` because this list is
// the public surface: a new export in these modules stays internal until it is
// added here.
export {
  instrumentFromTicker, quoteSubscriptionTargetFromTicker,
} from "../market-data/request-types";
export type {
  ChartRequest, InstrumentRef, OptionsRequest, SecFilingsRequest, TickerInstrumentOptions,
} from "../market-data/request-types";
export {
  currencyMinorDigits, formatCompactMarketPriceWithCurrency, formatMarketChangeWithCurrency,
  formatMarketCost, formatMarketCostWithCurrency, formatMarketPrice, formatMarketPriceWithCurrency,
  formatMarketQuantity, formatPriceObservation, formatSignedMarketPrice, liveQuoteFormatOptions,
  marketPriceFractionDigitCeiling, quoteFormatOptions, quoteReferencePrice, resolveAssetDisplayKind,
  stablePriceFractionDigits, withCurrencyMinorDigits, withStablePriceDigits,
} from "../market-data/market/format";
export type {
  AssetDisplayContext, AssetDisplayKind, MarketFormatOptions, StablePriceContext,
} from "../market-data/market/format";

// The coordinator the app loads snapshots through, so a plugin pane that shows
// its own list of tickers warms the same cache the rest of the app reads.
export { getSharedMarketDataCoordinator } from "../market-data/coordinator";

// Values derived from a quote and its fundamentals that a pane must not
// recompute by hand: whether a quote's timestamp can be trusted, trailing
// returns, and the market capitalization with its currency and provenance.
export { hasValidQuoteObservationTime } from "../market-data/quotes/freshness";
export { computeTickerPriceReturns } from "../market-data/ticker-price-returns";
export { selectMarketCapitalization } from "../utils/market-capitalization";
export type { MarketCapitalization } from "../utils/market-capitalization";
