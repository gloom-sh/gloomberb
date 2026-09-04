import type {
  DataProvider,
  MarketDataRequestContext,
  SecFilingItem,
} from "../../../types/data-provider";

export async function loadSecFilings(
  provider: DataProvider,
  symbol: string,
  count: number,
  exchange = "",
  context?: MarketDataRequestContext,
): Promise<SecFilingItem[]> {
  if (!provider.getSecFilings) throw new Error("SEC filing data unavailable");
  return provider.getSecFilings(symbol, count, exchange, context);
}
