import type { Quote } from "../types/financials";

/** What a stock perpetual's premium to its stock is worked out from: its row, as PERP and the lists read it. */
export interface PerpetualPremiumRow {
  markPrice?: number | null;
  priceMultiplier?: number;
  underlying?: { currency: string } | null;
  /** Gloom Cloud's figure: against the stock's stored price, or its regular close while its market is shut. */
  underlyingPremium: number | null;
}

/**
 * A stock perpetual's premium to its stock. While the stock's market is open, the stored price Gloom Cloud compares a
 * streaming mark with is minutes old, so a live quote of the stock, where the screen has one, is the reference
 * instead. Otherwise (a delayed quote, a shut market, another currency) the row's own figure stands.
 */
export function premiumToUnderlying(row: PerpetualPremiumRow, stock: Quote | null | undefined): number | null {
  const mark = row.markPrice;
  if (
    mark == null || !row.underlying || !stock || stock.stale === true || stock.dataSource !== "live"
    || stock.marketState !== "REGULAR" || stock.currency !== row.underlying.currency
    || !Number.isFinite(stock.price) || stock.price <= 0
  ) return row.underlyingPremium;
  return mark / (row.priceMultiplier ?? 1) / stock.price - 1;
}
