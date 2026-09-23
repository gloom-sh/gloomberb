import type { TickerFinancials } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import { instrumentFromTicker, type TickerInstrumentOptions } from "./request-types";

const withoutPriceCache = new WeakMap<TickerFinancials, TickerFinancials>();

/** The same record without a price, kept stable so row caches still hit. */
function withoutPrice(financials: TickerFinancials): TickerFinancials {
  let stripped = withoutPriceCache.get(financials);
  if (!stripped) {
    stripped = { ...financials, quote: undefined, priceHistory: [] };
    withoutPriceCache.set(financials, stripped);
  }
  return stripped;
}

export function buildPortfolioFinancialsMap(
  portfolioTickers: TickerRecord[],
  cachedFinancials: Map<string, TickerFinancials>,
  marketFinancials: Map<string, TickerFinancials>,
  options: TickerInstrumentOptions = {},
): Map<string, TickerFinancials> {
  const result = new Map<string, TickerFinancials>();
  for (const ticker of portfolioTickers) {
    const symbol = ticker.metadata.ticker;
    const cached = cachedFinancials.get(symbol);
    const instrument = instrumentFromTicker(ticker, symbol, options);
    if (cached) {
      // The symbol-only app cache cannot establish a broker price's contract.
      const ambiguousPrice = options.portfolioId && (!instrument || instrument.brokerId || ticker.metadata.broker_contracts?.length);
      result.set(symbol, ambiguousPrice ? withoutPrice(cached) : cached);
    }
    const scoped = marketFinancials.get(symbol);
    if (scoped) result.set(symbol, instrument ? scoped : withoutPrice(scoped));
  }
  return result;
}
