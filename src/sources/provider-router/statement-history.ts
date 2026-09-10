import type { MarketDataRequestContext } from "../../types/data-provider";
import type { TickerFinancials } from "../../types/financials";

export function financialHistoryVariants(variants: string[], context?: MarketDataRequestContext): string[] {
  return context?.statementHistory === "extended"
    ? variants.map((variant) => `${variant};history=extended:v1`)
    : variants;
}

/** A nominal row count never certifies that the extended source was attempted. */
export function hasReusableExtendedHistory(value: TickerFinancials | null | undefined): boolean {
  const attempt = value?.statementHistory;
  return !!attempt && attempt.status !== "retryable-failure"
    && Date.now() - Date.parse(attempt.fetchedAt) < 6 * 60 * 60_000;
}
