import { hasUnknownBondHistoryBasis } from "../time-series/chart-data";
import type { Fundamentals, TickerFinancials } from "../types/financials";
import { appendQuoteToPriceReturnHistory, buildPriceReturnFields } from "./performance";

/** Summary return fields have no dated coverage. Rebuild them from observations,
 * including when an older cached summary supplied a since-inception return. */
export function computeTickerPriceReturns(
  financials: TickerFinancials | null,
  assetCategory?: string,
): Pick<Fundamentals, "return1Y" | "return3Y"> {
  const quote = hasUnknownBondHistoryBasis(financials?.quote, assetCategory, financials?.quoteMetadata?.instrumentType)
    ? undefined : financials?.quote;
  // Bars and the quote are dated on the listing's clock.
  const venue = financials?.quote?.listingExchangeName || financials?.quote?.exchangeName || undefined;
  const fields = buildPriceReturnFields(appendQuoteToPriceReturnHistory(financials?.priceHistory ?? [], quote), venue);
  return {
    return1Y: fields.find((field) => field.id === "1Y")?.value ?? undefined,
    return3Y: fields.find((field) => field.id === "3Y")?.value ?? undefined,
  };
}
