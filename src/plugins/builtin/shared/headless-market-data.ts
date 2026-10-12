import type { IssuerListingParams } from "../../../api-client/paths";
import type { DataProvider } from "../../../types/data-provider";
import type { HeadlessPaneContext } from "../../../types/headless";
import type { TimeRange } from "../../../time-series/range";
import { clipPriceHistoryToRange } from "../../../time-series/history-window";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { nonUsSecListingVenue } from "../../../utils/sec";

export async function resolveHeadlessInstrument(ctx: HeadlessPaneContext, symbol: string) {
  return ctx.resolveInstrument ? ctx.resolveInstrument(symbol) : parsePublicTickerKey(symbol);
}

/**
 * The venue and company an issuer lookup names for a listing abroad: the
 * venue from the key or the saved listing, the company from the listing's own
 * quote. A US listing or a symbol with no venue names neither.
 */
export async function resolveIssuerListing(
  key: string,
  exchange: string | undefined,
  marketData: Pick<DataProvider, "getQuote">,
): Promise<IssuerListingParams> {
  const venue = nonUsSecListingVenue(key, exchange);
  if (!venue) return {};
  try {
    const quote = await marketData.getQuote(parsePublicTickerKey(key).symbol, venue);
    const quoteVenue = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
    // A quote that prices another venue names another listing's company.
    const name = !quoteVenue || quoteVenue === venue ? quote.name?.trim() : undefined;
    return name ? { exchange: venue, name } : { exchange: venue };
  } catch {
    return { exchange: venue };
  }
}

/** `resolveIssuerListing` for a report's ticker, with the venue of the saved listing when the key has none. */
export async function resolveHeadlessIssuerListing(ctx: HeadlessPaneContext, key: string): Promise<IssuerListingParams> {
  const { exchange } = await resolveHeadlessInstrument(ctx, key);
  return resolveIssuerListing(key, exchange, ctx.marketData);
}

export async function loadHeadlessFinancials(ctx: HeadlessPaneContext, key: string) {
  const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
  return ctx.marketData.getTickerFinancials(symbol, exchange ?? "");
}

export async function loadHeadlessPriceHistory(ctx: HeadlessPaneContext, key: string, range: TimeRange) {
  const { symbol, exchange } = await resolveHeadlessInstrument(ctx, key);
  return clipPriceHistoryToRange(await ctx.marketData.getPriceHistory(symbol, exchange ?? "", range), range);
}

/** One failed input must not hide the peers that loaded successfully. */
export async function loadHeadlessSymbols<T>(
  symbols: string[],
  ctx: HeadlessPaneContext,
  load: (symbol: string) => Promise<T>,
) {
  const results = await Promise.allSettled(symbols.map(load));
  ctx.signal.throwIfAborted();
  const entries: Array<{ symbol: string; data: T }> = [];
  const unavailableSymbols: string[] = [];
  const errors: string[] = [];
  results.forEach((result, index) => {
    const symbol = symbols[index]!;
    if (result.status === "fulfilled") entries.push({ symbol, data: result.value });
    else {
      unavailableSymbols.push(symbol);
      errors.push(`${symbol}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });
  return { entries, unavailableSymbols, errors };
}
