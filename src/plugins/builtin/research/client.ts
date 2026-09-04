import type { DataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { AnalystResearchData } from "../../../types/financials";

export async function loadAnalystResearch(
  provider: DataProvider,
  symbol: string,
  exchange = "",
  context?: MarketDataRequestContext,
): Promise<AnalystResearchData> {
  if (!provider.getAnalystResearch) throw new Error("Analyst data unavailable");
  return provider.getAnalystResearch(symbol, exchange, context);
}
