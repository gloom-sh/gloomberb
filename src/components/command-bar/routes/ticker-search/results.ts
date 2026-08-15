import type { TickerRecord } from "../../../../types/ticker";
import {
  createLocalTickerSearchCandidates,
  type TickerSearchCandidate,
} from "../../../../tickers/search";
import type { ResultItem } from "../../list/model";

export const QUICK_LOOK_TICKER_SEARCH_OPTIONS = { includeOptionContracts: false } as const;

export function buildTickerSearchCacheKey(
  query: string,
  brokerId?: string | null,
  brokerInstanceId?: string | null,
): string {
  return [query.trim().toUpperCase(), brokerId || "", brokerInstanceId || ""].join("|");
}

export function createQuickLookTickerCandidates(tickers: Iterable<TickerRecord>): TickerSearchCandidate[] {
  return createLocalTickerSearchCandidates(tickers, new Map(), QUICK_LOOK_TICKER_SEARCH_OPTIONS);
}

export function normalizeCommandTickerSearchText(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function isExactTickerResultMatch(item: ResultItem, query: string): boolean {
  if (item.kind !== "ticker" && item.kind !== "search") return false;
  const normalizedQuery = normalizeCommandTickerSearchText(query);
  if (!normalizedQuery) return false;
  return normalizeCommandTickerSearchText(item.label) === normalizedQuery;
}

export function mergeTickerSearchResultItems(
  query: string,
  rankedItems: ResultItem[],
  fallbackItems: ResultItem[],
): ResultItem[] {
  const merged: ResultItem[] = [];
  const seen = new Set<string>();
  const addItem = (item: ResultItem) => {
    if (item.kind === "info") return;
    const key = `${item.label.trim().toUpperCase()}:${(item.right || "").trim().toUpperCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  };
  rankedItems.forEach(addItem);
  fallbackItems.forEach(addItem);
  if (merged.length === 0) return rankedItems.length > 0 ? rankedItems : fallbackItems;

  return merged.map((item) => isExactTickerResultMatch(item, query) && item.category !== "Saved"
      ? { ...item, category: "Exact Match" }
      : item);
}

export function mergePlainRootTickerResults(
  query: string,
  providerItems: ResultItem[],
  rootItems: ResultItem[],
): ResultItem[] {
  const merged: ResultItem[] = [];
  const seen = new Set<string>();
  const addItem = (item: ResultItem, options?: { skipInfo?: boolean }) => {
    if (options?.skipInfo && item.kind === "info") return;
    const key = (item.kind === "ticker" || item.kind === "search")
      ? `${item.kind}:${item.label.trim().toUpperCase()}:${(item.right || "").trim().toUpperCase()}`
      : `${item.kind}:${item.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  };

  providerItems
    .filter((item) => item.category === "Exact Match" || isExactTickerResultMatch(item, query))
    .forEach((item) => addItem(item, { skipInfo: true }));
  rootItems.forEach((item) => addItem(item));
  providerItems
    .filter((item) => item.category !== "Exact Match" && !isExactTickerResultMatch(item, query))
    .forEach((item) => addItem(item, { skipInfo: true }));
  return merged.length > 0 ? merged : rootItems;
}
