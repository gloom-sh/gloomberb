import type { DataProvider, MarketDataRequestContext } from "../../../types/data-provider";
import type { HolderData, TickerFinancials } from "../../../types/financials";
import { holderStakeMarketCap, holderValueCurrency } from "./format";
import { logFailure } from "../../../utils/log-failure";

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

/** The day `classSharesToday` was counted (YYYY-MM-DD), when it is a dated 10-K or 10-Q cover count; null when undated. */
export function classSharesAsOf(financials: Pick<TickerFinancials, "quote" | "fundamentals"> | null | undefined): string | null {
  const fundamentals = financials?.fundamentals;
  if (classSharesToday(financials) == null || !fundamentals?.sharesOutstandingAsOf) return null;
  const receipt = fundamentals.shareBasis === "depositary_receipt"
    || fundamentals.isDepositaryReceipt === true
    || financials?.quote?.isDepositaryReceipt === true;
  return receipt ? null : fundamentals.sharesOutstandingAsOf;
}

export async function loadHolderSnapshot(
  provider: DataProvider,
  symbol: string,
  exchange = "",
): Promise<{ data: HolderData; marketCap?: number; sharesOutstanding?: number | null; sharesOutstandingAsOf?: string | null; price?: number }> {
  const [data, financials] = await Promise.all([
    loadHolderData(provider, symbol, exchange),
    provider.getTickerFinancials(symbol, exchange).catch(logFailure("holders.client", "Read holder reference financials failed", null)),
  ]);
  const quote = financials?.quote;
  return {
    data,
    marketCap: holderStakeMarketCap(quote?.marketCap, quote?.currency, holderValueCurrency(data)),
    sharesOutstanding: classSharesToday(financials),
    sharesOutstandingAsOf: classSharesAsOf(financials),
    ...(quote?.price != null ? { price: quote.price } : {}),
  };
}
