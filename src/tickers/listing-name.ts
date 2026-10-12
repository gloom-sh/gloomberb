import type { Quote } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";
import { optionContractName } from "../utils/options";

type NamingQuote = Pick<Quote, "name" | "listingExchangeName" | "exchangeName">;

/**
 * The company a listing's own quote names: the one name `quote`, `history`,
 * `ticker`, search and the portfolio give a listing, so a fund renamed after a
 * catalogue or a portfolio saved it reads the same everywhere. A quote that
 * prices another venue names another listing's company, so it gives none;
 * neither does one without a name.
 */
export function quotedListingName(exchange: string, quote: NamingQuote | null | undefined): string | null {
  const quoteExchange = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName);
  if (quoteExchange && exchange && quoteExchange !== canonicalExchange(exchange)) return null;
  return quote?.name?.trim() || null;
}

/**
 * The name a saved listing goes by now: its own quote's, else the name it was
 * saved with. A name that is only the symbol is no name; an option contract
 * with none is named by its terms (AAPL Dec 18 '26 $300 Call).
 */
export function currentListingName(ticker: Pick<TickerRecord, "metadata">, quote?: NamingQuote | null): string | null {
  const key = ticker.metadata.ticker;
  const { symbol } = parsePublicTickerKey(key);
  const named = (name: string | null | undefined) => {
    const text = name?.trim();
    return text && text !== symbol && text !== key ? text : null;
  };
  return named(quotedListingName(ticker.metadata.exchange ?? "", quote)) ?? named(ticker.metadata.name) ?? optionContractName(symbol);
}
