import type { DataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { HolderData } from "../../../types/financials";

export async function loadHolderData(
  provider: DataProvider,
  symbol: string,
  exchange = "",
  context?: MarketDataRequestContext,
): Promise<HolderData> {
  if (!provider.getHolders) throw new Error("Holder data unavailable");
  return provider.getHolders(symbol, exchange, context);
}

export async function loadHolderSnapshot(
  provider: DataProvider,
  symbol: string,
  exchange = "",
): Promise<{ data: HolderData; marketCap?: number }> {
  const [data, financials] = await Promise.all([
    loadHolderData(provider, symbol, exchange),
    provider.getTickerFinancials(symbol, exchange).catch(() => null),
  ]);
  const quoteMarketCap = financials?.quote?.marketCap;
  const marketCap = financials?.quote?.currency && data.currency
    && financials.quote.currency !== data.currency
    ? undefined
    : quoteMarketCap;
  return { data, marketCap };
}
