import type { DataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { HolderData, TickerFinancials } from "../../../types/financials";
import { holderStakeMarketCap, holderValueCurrency } from "./format";

export async function loadHolderData(
  provider: DataProvider,
  symbol: string,
  exchange = "",
  context?: MarketDataRequestContext,
): Promise<HolderData> {
  if (!provider.getHolders) throw new Error("Holder data unavailable");
  return provider.getHolders(symbol, exchange, context);
}

/**
 * Today's shares outstanding in ordinary shares, the count a 13D/13G percent
 * of class divides; on a depositary receipt the ordinary shares behind it,
 * or null when they are not given.
 */
export function classSharesToday(financials: Pick<TickerFinancials, "quote" | "fundamentals"> | null | undefined): number | null {
  const fundamentals = financials?.fundamentals;
  if (!fundamentals) return null;
  const receipt = fundamentals.shareBasis === "depositary_receipt"
    || fundamentals.isDepositaryReceipt === true
    || financials?.quote?.isDepositaryReceipt === true;
  const count = receipt ? fundamentals.underlyingOrdinaryShares : fundamentals.sharesOutstanding;
  return count != null && Number.isFinite(count) && count > 0 ? count : null;
}

export async function loadHolderSnapshot(
  provider: DataProvider,
  symbol: string,
  exchange = "",
): Promise<{ data: HolderData; marketCap?: number; sharesOutstanding?: number | null }> {
  const [data, financials] = await Promise.all([
    loadHolderData(provider, symbol, exchange),
    provider.getTickerFinancials(symbol, exchange).catch(() => null),
  ]);
  const quote = financials?.quote;
  return {
    data,
    marketCap: holderStakeMarketCap(quote?.marketCap, quote?.currency, holderValueCurrency(data)),
    sharesOutstanding: classSharesToday(financials),
  };
}
