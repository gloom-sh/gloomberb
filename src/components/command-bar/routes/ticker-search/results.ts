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
import { currencyPairCode } from "../../../../utils/currency-pair";
import { canonicalExchange, exchangeCodeVenues, isUsListingExchange, parsePublicTickerKey, publicExchange } from "../../../../utils/exchanges";
import { readNearMissListing, readTerminalListingCode, unknownBloombergMarket } from "../../../../tickers/terminal-codes";
import { listingSuffixExchange, tickerHasListingSuffix } from "../../../../sources/listing-symbols";
import { answersToFutureName, answersToIndexCode, compactSearchText, getIssuerGroupKey, isExplicitMarketSymbol } from "../../../../tickers/search/ranking";
import { isProviderBusy } from "../../../../sources/provider-errors";

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
 * Class tag for the badge column. A query can end with the same code: EQ,
 * CUR, CRYP, OPT, FUT, IDX, ETF, FUND. A fund or derivative whose type string
 * did not classify still badges FUND or DERIV. Anything else gets none, and
 * the row shows its exchange code there when the code is short enough.
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
    // IBOV is how the Ibovespa is typed; its own symbol is ^BVSP.
    || answersToIndexCode(item, query)
    // "brent" and "oil" are how a benchmark future is typed; its own symbol is BZ=F or CL=F.
    || answersToFutureName(item, query)
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

const SEARCH_BUSY_ITEM_ID = "search-busy";

/** The busy row among a search's rows: a list left with no instruments keeps it, so nothing there reads as no listing. */
function searchBusyRows(items: readonly ResultItem[]): ResultItem[] {
  return items.filter((item) => item.id === SEARCH_BUSY_ITEM_ID);
}

/**
 * The rows for a ticker search that threw. A busy service says so rather
 * than "No matches", unless saved tickers still match, which then answer on
 * their own; any other failure is a failed search.
 */
export function tickerSearchFailureItems(error: unknown, query: string, localItems: ResultItem[]): ResultItem[] {
  if (isProviderBusy(error)) {
    return mergeTickerSearchResultItems(query, [{
      id: SEARCH_BUSY_ITEM_ID,
      label: "Search is busy",
      detail: "Try again in a moment",
      category: "Search",
      kind: "info",
      action: () => {},
    }], localItems);
  }
  return [{
    id: "search-error",
    label: "Search failed",
    detail: "Check your connection",
    category: "Search",
    kind: "info",
    action: () => {},
  }];
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
  /** What the typed text reads as when it is a terminal's code or a near miss (`readRootTickerQuery`). */
  reading: RootTickerReading | null = null,
): ResultItem[] {
  const seenExactVenues = new Set<string>();
  const seenLooseSymbols = new Set<string>();
  const symbolsWithExact = new Set<string>();
  const candidates: ResultItem[] = [];
  const isExact = reading
    ? (item: ResultItem) => reading.names(item)
    : (item: ResultItem) => item.category === "Exact Match" || isExactTickerResultMatch(item, query);
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
  if (instruments.length === 0) {
    const busy = searchBusyRows(providerItems);
    return busy.length > 0 ? [...rootItems, ...busy] : rootItems;
  }

  const exact = instruments.filter(isExact);
  // `AAPL GY` names a listing search does not have, `700.HK` nearly names one: the row it was read from is offered.
  const meant = reading && exact.length === 0 ? instruments.find(reading.meant) : undefined;
  return [
    ...exact.map((item) => ({ ...item, category: "Exact Match" })),
    ...meant ? [{ ...meant, category: DID_YOU_MEAN_CATEGORY }] : [],
    ...rootItems,
    ...instruments.filter((item) => !isExact(item) && item !== meant).map((item) => ({ ...item, category: ROOT_INSTRUMENTS_CATEGORY })),
  ];
}

/** The section of the row a near-miss or a terminal's code was read as, when it names no listing outright. */
export const DID_YOU_MEAN_CATEGORY = "Did you mean";

/** What a plain root query reads as when it is written the way a terminal or a broker writes a listing. */
export interface RootTickerReading {
  /** The symbol search is asked for: the code's ticker (VOD for `VOD LN`), or the working form of a near miss (0700.HK). */
  search: string;
  /** Rows on the listing the text names: VOD on LSE for `VOD LN`. They are the exact match. */
  names: (item: ResultItem) => boolean;
  /** Rows of the symbol it was read from, the first offered as what it meant when no row is named: AAPL for `AAPL GY`. */
  meant: (item: ResultItem) => boolean;
}

/** The symbol and venue a ticker row stands for: SAP:XETR's or SAP on the XETRA row, in canonical codes. */
function rowListing(item: ResultItem): { symbol: string; exchange: string } {
  const label = parsePublicTickerKey(item.label.trim().toUpperCase());
  return { symbol: label.symbol.replace(/[-/]/g, "."), exchange: canonicalExchange(label.exchange || item.right) };
}

/**
 * A plain root query written as a Bloomberg code (`VOD LN`, `7203 JP Equity`,
 * `SPX Index`), as one whose market code no venue answers to (`AAPL GP`), or
 * nearly as a listing (`700.HK`, `6758.JP`, `BRK/B`), read by the one parser
 * every command reads them with. A code names its listing; the others only
 * name the symbol they were read from, offered as what was meant. Null for
 * anything else, which the bar searches as typed.
 */
export function readRootTickerQuery(query: string): RootTickerReading | null {
  const trimmed = query.trim();
  const isInstrument = (item: ResultItem) => item.kind === "ticker" || item.kind === "search";
  const ofSymbol = (symbol: string) => {
    const wanted = symbol.toUpperCase().replace(/[-/]/g, ".");
    return (item: ResultItem) => isInstrument(item) && rowListing(item).symbol === wanted;
  };
  const code = readTerminalListingCode(trimmed);
  if (code?.terminal === "bloomberg") {
    const listings = [code, ...code.alternatives ?? []];
    const named = (item: ResultItem) => {
      const row = rowListing(item);
      return isInstrument(item) && listings.some((listing) => row.symbol === listing.symbol.replace(/[-/]/g, ".")
        && (!code.market ? true : listing.exchange ? row.exchange === listing.exchange : isUsListingExchange(row.exchange)));
    };
    return { search: code.symbol, names: named, meant: ofSymbol(code.symbol) };
  }
  const unknown = unknownBloombergMarket(trimmed);
  if (unknown) return { search: unknown.symbol, names: () => false, meant: ofSymbol(unknown.symbol) };
  const nearMiss = readNearMissListing(trimmed);
  if (!nearMiss) return null;
  // 0700.HK is listed as 0700 on HKEX: the row of the symbol before its suffix.
  const { symbol } = parsePublicTickerKey(nearMiss.symbol);
  const root = tickerHasListingSuffix(symbol) ? symbol.slice(0, symbol.indexOf(".")) : symbol;
  const suffixVenue = listingSuffixExchange(symbol);
  const meant = (item: ResultItem) => (ofSymbol(root)(item) && (!suffixVenue || rowListing(item).exchange === suffixVenue))
    || (isInstrument(item) && isExactTickerResultMatch(item, nearMiss.symbol));
  return { search: nearMiss.symbol, names: () => false, meant };
}

function venueMatchesSuffix(item: ResultItem, suffix: string): boolean {
  if (!suffix) return true;
  const displayed = (item.right ?? "").trim().toUpperCase();
  const fromLabel = parsePublicTickerKey(item.label.trim().toUpperCase()).exchange ?? "";
  const canonicalDisplayed = canonicalExchange(displayed);
  const targets = [displayed, canonicalDisplayed, fromLabel, publicExchange(canonicalDisplayed || displayed)];
  if (targets.some((value) => value.startsWith(suffix))) return true;
  // Another spelling of the venue (XPAR, PAR), or a code that names several (TSE: Toronto or Tokyo).
  const venues = exchangeCodeVenues(suffix).filter((venue) => venue !== suffix);
  return targets.some((value) => venues.includes(canonicalExchange(value)));
}

/** On the currency venue a pair's code is the pair: EURUSD's CCY row is EURUSD=X. */
function isCurrencyVenuePair(item: ResultItem, symbol: string): boolean {
  const pair = currencyPairCode(symbol, "CCY");
  return pair != null && canonicalExchange(item.right) === "CCY" && currencyPairCode(item.label) === pair;
}

/**
 * The colon query's dropdown: one row per exact venue, in ranked order. A
 * typed exchange prefix keeps the rows it matches.
 */
export function venueDropdownResults(symbol: string, items: ResultItem[], suffix: string): ResultItem[] {
  const rows: ResultItem[] = [];
  for (const item of items) {
    if (item.kind !== "ticker" && item.kind !== "search") continue;
    if (!isExactTickerResultMatch(item, symbol) && !isCurrencyVenuePair(item, symbol)) continue;
    if (!venueMatchesSuffix(item, suffix)) continue;
    rows.push(item.category === "Exact Match" ? item : { ...item, category: "Exact Match" });
  }
  return rows.length > 0 ? rows : searchBusyRows(items);
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
