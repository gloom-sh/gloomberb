import type { CollectionSortPreference } from "../../../state/app/context";

export type { ColumnContext } from "./column-values";
export { getColumnValue, getSortValue, resolvePortfolioPriceValue } from "./column-values";
export type { PortfolioSummaryTotals } from "./summary/totals";
export { calculatePortfolioSummaryTotals, resolvePortfolioTotalsCurrency } from "./summary/totals";

const EMPTY_SORT_PREFERENCE: CollectionSortPreference = {
  columnId: null,
  direction: "asc",
};

const DEFAULT_PORTFOLIO_SORT_PREFERENCE: CollectionSortPreference = {
  columnId: "mkt_value",
  direction: "desc",
};

export function resolveCollectionSortPreference(
  collectionId: string | null,
  isPortfolio: boolean,
  collectionSorts: Record<string, CollectionSortPreference>,
): CollectionSortPreference {
  if (!collectionId) return EMPTY_SORT_PREFERENCE;
  return collectionSorts[collectionId] ?? (isPortfolio ? DEFAULT_PORTFOLIO_SORT_PREFERENCE : EMPTY_SORT_PREFERENCE);
}
