import type { TickerRecord } from "../../../../types/ticker";
import {
  createLocalTickerSearchCandidates,
  findExactTickerSearchMatch,
  type TickerSearchCandidate,
} from "../../../../tickers/search";
import {
  assetClassMarketSymbol,
  instrumentClassCode,
  parseAssetClassQuery,
} from "../../../../tickers/search/asset-classes";
import type { ResultItem } from "../../list/model";
import { canonicalExchange, parsePublicTickerKey } from "../../../../utils/exchanges";
import { compactSearchText, getIssuerGroupKey, isExplicitMarketSymbol } from "../../../../tickers/search/ranking";

export const QUICK_LOOK_TICKER_SEARCH_OPTIONS = { includeOptionContracts: false } as const;

/**
 * The command bar ranks a full page of symbol search (Cloud answers ten), so
 * a second security on the same symbol is still in hand when the root list
 * picks its exact rows.
 */
export const COMMAND_BAR_TICKER_SEARCH_LIMIT = 10;

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
 * Class tag for the badge column: the class code a query can end with (EQ,
 * CUR, OPT, FUT, IDX, ETF), else FUND or DERIV. An unclassified instrument
 * gets none: the row lifts its exchange code there instead when the code is
 * short enough.
 */
export function formatInstrumentBadge(
  candidate: Pick<TickerSearchCandidate, "instrumentClass" | "result" | "ticker">
    & Partial<Pick<TickerSearchCandidate, "symbol" | "exchangeLabel">>,
): string | undefined {
  const code = instrumentClassCode({
    instrumentClass: candidate.instrumentClass,
    instrumentType: rawInstrumentType(candidate),
    symbol: candidate.symbol ?? candidate.result?.symbol ?? candidate.ticker?.metadata.ticker ?? "",
    exchange: candidate.exchangeLabel ?? candidate.result?.exchange ?? candidate.ticker?.metadata.exchange,
  });
  if (code) return code;
  switch (candidate.instrumentClass) {
    case "fund":
      return "FUND";
    case "derivative":
      return "DERIV";
    default:
      return undefined;
  }
}

export function normalizeCommandTickerSearchText(value: string): string {
  const normalized = value.trim().toUpperCase();
  return isExplicitMarketSymbol(normalized) ? normalized : normalized.replace(/[^A-Z0-9]+/g, "");
}

function isExactTickerResultMatch(item: ResultItem, rawQuery: string): boolean {
  if (item.kind !== "ticker" && item.kind !== "search") return false;
  // "ES FUT" names ES, and the future's own spelling ES=F.
  const assetClass = parseAssetClassQuery(rawQuery);
  const marketSymbol = assetClass ? assetClassMarketSymbol(assetClass) : null;
  return [assetClass?.symbolQuery ?? rawQuery, ...(marketSymbol ? [marketSymbol] : [])].some((query) => (
    findExactTickerSearchMatch([item], query) != null
    || parsePublicTickerKey(item.label).symbol === query.trim().toUpperCase()
  ));
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
    const key = `${item.label.trim().toUpperCase()}:${(item.right || "").trim().toUpperCase()}:${item.contractKey ?? ""}`;
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

const ROOT_INSTRUMENTS_CATEGORY = "Instruments";

/** Enough to surface the listing the user means without burying the sections below. */
const ROOT_INSTRUMENTS_LIMIT = 5;

function isInstrumentItem(item: ResultItem): boolean {
  return item.kind === "ticker" || item.kind === "search";
}

/**
 * Fold symbol-search rows into a plain root query's list. An exact symbol
 * keeps one row per exchange: a saved listing written with its venue
 * (`SAP:XETR`) counts as that exchange, and share-class spellings of one
 * listing (BRK.B and BRK-B on NYSE) are one row. Looser hits stay one row per
 * symbol.
 * When the rows outnumber the cap, each distinct security gets a row before a
 * further exchange of one already shown, so Saputo's SAP on Toronto is not
 * pushed out by SAP SE's fourth German venue; the rows keep their ranked order.
 * Info rows ("no matches", "search failed") are dropped: the instruments are
 * an extra here, never the answer.
 */
export function mergePlainRootTickerResults(
  query: string,
  providerItems: ResultItem[],
  rootItems: ResultItem[],
): ResultItem[] {
  const seenExactVenues = new Set<string>();
  const seenLooseSymbols = new Set<string>();
  const symbolsWithExact = new Set<string>();
  const candidates: ResultItem[] = [];
  const isExact = (item: ResultItem) => item.category === "Exact Match" || isExactTickerResultMatch(item, query);
  for (const item of providerItems) {
    if (!isInstrumentItem(item)) continue;
    const label = item.label.trim().toUpperCase();
    const symbol = parsePublicTickerKey(label).symbol || label;
    if (isExact(item)) {
      const venue = canonicalExchange(parsePublicTickerKey(label).exchange || item.right);
      const key = `${compactSearchText(symbol)}|${venue}|${item.contractKey ?? ""}`;
      if (seenExactVenues.has(key)) continue;
      seenExactVenues.add(key);
      symbolsWithExact.add(label);
      symbolsWithExact.add(symbol);
    } else if (symbolsWithExact.has(label) || symbolsWithExact.has(symbol) || seenLooseSymbols.has(label)) {
      continue;
    } else {
      seenLooseSymbols.add(label);
    }
    candidates.push(item);
  }
  const instruments = pickRootInstruments(candidates, isExact);
  if (instruments.length === 0) return rootItems;

  return [
    ...instruments.filter(isExact).map((item) => ({ ...item, category: "Exact Match" })),
    ...rootItems,
    ...instruments.filter((item) => !isExact(item)).map((item) => ({ ...item, category: ROOT_INSTRUMENTS_CATEGORY })),
  ];
}

/**
 * Up to the cap, in this order: the first exact row of each security, the
 * exact symbol's other exchanges, then looser hits. The rows keep their
 * ranked order. Exchanges of one security share its issuer name and class.
 */
function pickRootInstruments(candidates: ResultItem[], isExact: (item: ResultItem) => boolean): ResultItem[] {
  if (candidates.length <= ROOT_INSTRUMENTS_LIMIT) return candidates;
  const exact = candidates.filter(isExact);
  const picked = new Set<ResultItem>();
  const securities = new Set<string>();
  for (const item of exact) {
    const security = `${getIssuerGroupKey(item.detail) || item.id}|${item.badge ?? item.instrumentType ?? ""}`;
    if (securities.has(security)) continue;
    securities.add(security);
    picked.add(item);
  }
  for (const item of [...exact, ...candidates]) {
    if (picked.size >= ROOT_INSTRUMENTS_LIMIT) break;
    picked.add(item);
  }
  return candidates.filter((item) => picked.has(item)).slice(0, ROOT_INSTRUMENTS_LIMIT);
}
