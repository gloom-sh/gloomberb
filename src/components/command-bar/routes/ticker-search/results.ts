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

/** Provider type or saved asset category, whichever classified the candidate. */
function rawInstrumentType(candidate: Pick<TickerSearchCandidate, "result" | "ticker">): string {
  return candidate.result?.brokerContract?.secType
    || candidate.result?.type
    || candidate.ticker?.metadata.assetCategory
    || "";
}

/**
 * Class tag for the badge column. An unclassified instrument gets none: the
 * row lifts its exchange code there instead when the code is short enough.
 */
export function formatInstrumentBadge(
  candidate: Pick<TickerSearchCandidate, "instrumentClass" | "result" | "ticker">,
): string | undefined {
  switch (candidate.instrumentClass) {
    case "equity":
      return "EQ";
    case "fund":
      return /\bET[FNP]\b/i.test(rawInstrumentType(candidate)) ? "ETF" : "FUND";
    case "derivative":
      return "DERIV";
    case "other":
      return undefined;
  }
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

export const ROOT_INSTRUMENTS_CATEGORY = "Instruments";

/** Enough to surface the listing the user means without burying the sections below. */
const ROOT_INSTRUMENTS_LIMIT = 5;

function isInstrumentItem(item: ResultItem): boolean {
  return item.kind === "ticker" || item.kind === "search";
}

/**
 * Fold symbol-search rows into a plain root query's list. An exact symbol hit
 * is promoted ahead of everything; the rest collapse into one Instruments
 * section with one row per symbol, since the listing split of the DES route
 * is noise next to panes and commands. Info rows ("no matches", "search
 * failed") are dropped: the instruments are an extra here, never the answer.
 */
export function mergePlainRootTickerResults(
  query: string,
  providerItems: ResultItem[],
  rootItems: ResultItem[],
): ResultItem[] {
  const seenSymbols = new Set<string>();
  const instruments: ResultItem[] = [];
  for (const item of providerItems) {
    if (!isInstrumentItem(item)) continue;
    const symbol = item.label.trim().toUpperCase();
    if (seenSymbols.has(symbol)) continue;
    seenSymbols.add(symbol);
    instruments.push(item);
    if (instruments.length >= ROOT_INSTRUMENTS_LIMIT) break;
  }
  if (instruments.length === 0) return rootItems;

  const isExact = (item: ResultItem) => item.category === "Exact Match" || isExactTickerResultMatch(item, query);
  return [
    ...instruments.filter(isExact).map((item) => ({ ...item, category: "Exact Match" })),
    ...rootItems,
    ...instruments.filter((item) => !isExact(item)).map((item) => ({ ...item, category: ROOT_INSTRUMENTS_CATEGORY })),
  ];
}
