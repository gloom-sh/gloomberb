// Which fundamental and valuation metrics exist, and which of them read the live quote or the price history.
import { canonicalTimeSeriesFieldId } from "../field-catalog";
import type { SeriesPeriod } from "../types";

export const FUNDAMENTAL_IDS = new Set([
  "totalRevenue",
  "grossProfit",
  "grossMargin",
  "operatingIncome",
  "operatingMargin",
  "netIncome",
  "netMargin",
  "ebitda",
  "depreciationAndAmortization",
  "operatingCashFlow",
  "freeCashFlow",
  "freeCashFlowMargin",
  "totalAssets",
  "totalDebt",
  "totalEquity",
  "eps",
]);

export const VALUATION_IDS = new Set([
  "trailingPE",
  "forwardPE",
  "realizedNtmPE",
  "pegRatio",
  "priceSales",
  "evSales",
  "evEbitda",
  "priceFcf",
]);

/** Statement-based multiples whose latest point is the regular session price over the latest trailing period. */
export const QUOTE_DERIVED_VALUATION_IDS = new Set([
  "trailingPE",
  "priceSales",
  "evSales",
  "evEbitda",
  "priceFcf",
]);

/** Multiples priced from history at each observation date; forward P/E also ends on the live quote. */
const PRICE_HISTORY_VALUATION_IDS = new Set([
  ...QUOTE_DERIVED_VALUATION_IDS,
  "forwardPE",
  "realizedNtmPE",
]);

/** Whether a valuation field derives a current point from the latest quote. */
export function valuationSeriesUsesLiveQuote(fieldId: string): boolean {
  const [namespace, metric = ""] = canonicalTimeSeriesFieldId(fieldId).split(".");
  return namespace === "valuation" && (QUOTE_DERIVED_VALUATION_IDS.has(metric) || metric === "forwardPE");
}

/** Whether a valuation field needs the full price history to date its observations. */
export function valuationSeriesUsesPriceHistory(fieldId: string, period?: SeriesPeriod): boolean {
  const [namespace, metric = ""] = canonicalTimeSeriesFieldId(fieldId).split(".");
  return namespace === "valuation" && (PRICE_HISTORY_VALUATION_IDS.has(metric) || (metric === "pegRatio" && period === "daily"));
}
