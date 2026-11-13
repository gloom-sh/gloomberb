import type { TickerRecord } from "../../../../types/ticker";
import {
  buildTickerSearchCandidates,
  createLocalTickerSearchCandidates,
  findExactTickerSearchMatch,
  type TickerSearchCandidate,
} from "../../../../tickers/search";
import { MAJOR_COIN_NAMES } from "../../../../utils/crypto-pair";
import {
  assetClassMarketSymbol,
  instrumentClassCode,
  parseAssetClassQuery,
} from "../../../../tickers/search/asset-classes";
import type { ResultItem } from "../../list/model";
import { ASSIST_CATEGORY } from "../../assist/model";
import { currencyPairCode } from "../../../../utils/currency-pair";
import { canonicalExchange, exchangeCodeVenues, isUsListingExchange, parsePublicTickerKey, publicExchange } from "../../../../utils/exchanges";
import { endsInLegalForm, readNearMissListing, readTerminalListingCode, unknownBloombergMarket } from "../../../../tickers/terminal-codes";
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

export function isExactTickerResultMatch(item: ResultItem, rawQuery: string): boolean {
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
    // BTC is how bitcoin is typed; its own symbol is BTC-USD.
    || majorCoinPairSymbol(query) === parsePublicTickerKey(item.label.trim().toUpperCase()).symbol
  ));
}

/** BTC-USD for BTC: the dollar pair of a coin whose bare ticker is how it is typed (`MAJOR_COIN_NAMES`). */
function majorCoinPairSymbol(query: string): string | null {
  const base = query.trim().toUpperCase();
  return MAJOR_COIN_NAMES.has(base) ? `${base}-USD` : null;
}

/**
 * A major coin's bare ticker (BTC, ETH, SOL) is how the coin is asked for, but
 * search lists only the funds and companies of those letters (BTC is
 * Grayscale's Bitcoin Mini Trust), with no coin among them. The bar adds the
 * coin's dollar pair, the row search sends for "bitcoin", as the CLI's quote
 * points to it ("For bitcoin use BTC-USD"); a pair search sends far down its
 * list (ETH-USD after every ETH listing) moves up the same way. It leads when
 * the listing it would follow cannot be what was meant: one named for the coin,
 * or one that stopped trading. A live company of those letters (LINK is
 * Interlink Electronics) keeps the lead, with the coin right after it.
 */
export function withMajorCoinCandidate(
  query: string,
  candidates: TickerSearchCandidate[],
  tickers: ReadonlyMap<string, TickerRecord>,
): TickerSearchCandidate[] {
  const symbol = majorCoinPairSymbol(query);
  const coin = MAJOR_COIN_NAMES.get(query.trim().toUpperCase());
  if (!symbol || !coin) return candidates;
  const isPair = (candidate: TickerSearchCandidate) => parsePublicTickerKey(candidate.symbol).symbol === symbol;
  const sent = candidates.find(isPair);
  const name = coin.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const [pair] = sent ? [sent] : buildTickerSearchCandidates({
    query: symbol,
    tickers,
    providerResults: [{ providerId: "gloomberb-cloud", symbol, name, exchange: "CCC", type: "CRYPTOCURRENCY", currency: "USD" }],
    totalLimit: 1,
    localLimit: 0,
  });
  if (!pair) return candidates;
  const rest = candidates.filter((candidate) => !isPair(candidate));
  const base = query.trim().toUpperCase();
  const at = rest.findIndex((candidate) => parsePublicTickerKey(candidate.symbol).symbol === base);
  if (at < 0) return [pair, ...rest];
  const listing = rest[at]!;
  const listingName = listing.result?.name ?? listing.ticker?.metadata.name ?? "";
  const cannotBeIt = !!listing.result?.delisting || new RegExp(`\\b${coin}\\b`, "i").test(listingName);
  const index = cannotBeIt ? at : at + 1;
  return [...rest.slice(0, index), pair, ...rest.slice(index)];
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
const SEARCH_ERROR_ITEM_ID = "search-error";

/**
 * The busy or failed row among a search's rows: a list left with no
 * instruments keeps it, so a search that did not answer never reads as one
 * that found nothing.
 */
function searchStatusRows(items: readonly ResultItem[]): ResultItem[] {
  return items.filter((item) => item.id === SEARCH_BUSY_ITEM_ID || item.id === SEARCH_ERROR_ITEM_ID);
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
    id: SEARCH_ERROR_ITEM_ID,
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
 * A row search marks with the word as typed under another symbol is the
 * company the word names, as the service listed it, and gets a row of its own:
 * China Construction Bank's 0939 in Hong Kong for "ccb" is no further venue of
 * its 601939 in Shanghai, nor HSBC's 0005 of its HSBA in London.
 * Info rows ("no matches", "search failed") are dropped: the instruments are
 * an extra here, never the answer. With no instruments left, a busy or
 * failed search keeps its row, and one that found nothing leaves the list to
 * say so (`buildNativeListRows`).
 */
export function mergePlainRootTickerResults(
  query: string,
  providerItems: ResultItem[],
  rootItems: ResultItem[],
  /** What the typed text reads as when it is a terminal's code or a near miss (`readRootTickerQuery`). */
  reading: RootTickerReading | null = null,
  /** Listings (`listingRowKey`) already on screen for the text: they keep their rows. */
  shown: readonly string[] = [],
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
  const namedForWord = (item: ResultItem) => !reading && isExact(item) && underAnotherSymbol(item, query);
  const instruments = pickRootInstruments(candidates, isExact, new Set(shown), namedForWord);
  const commandNamed = wordNamesCommand(query, rootItems);
  rootItems = leadWithNamedCommands(query, rootItems);
  if (instruments.length === 0) {
    const status = searchStatusRows(providerItems);
    return status.length > 0 ? [...rootItems, ...status] : rootItems;
  }

  // A listing that stopped trading is still the one its symbol names (SIVB, TWTR), unless a live listing
  // answers it too or the word names one of the bar's commands ("full", not EQ FULL of 2016): then it goes last.
  const live = instruments.filter((item) => isExact(item) && !item.stoppedTrading);
  const exact = live.length > 0 || commandNamed ? live : instruments.filter(isExact);
  // `AAPL GY` names a listing search does not have, `700.HK` nearly names one: the row it was read from is offered.
  const meant = reading && exact.length === 0 ? instruments.find((item) => reading.meant(item) && !item.stoppedTrading) : undefined;
  const rest = instruments.filter((item) => !exact.includes(item) && item !== meant);
  return [
    ...exact.map((item) => ({ ...item, category: "Exact Match" })),
    ...meant ? [{ ...meant, category: DID_YOU_MEAN_CATEGORY }] : [],
    ...rootItems,
    ...[...rest.filter((item) => !item.stoppedTrading), ...rest.filter((item) => item.stoppedTrading)]
      .map((item) => ({ ...item, category: ROOT_INSTRUMENTS_CATEGORY })),
  ];
}

/**
 * Whether a row stands under another symbol than the text typed: one that is
 * an exact match only because search marks it with the word as typed (HSBA and
 * 0005 for "hsbc"), not a line of the symbol on some venue.
 */
export function underAnotherSymbol(item: ResultItem, query: string): boolean {
  const symbol = (text: string) => compactSearchText(parsePublicTickerKey(text.trim().toUpperCase()).symbol);
  return symbol(item.label) !== symbol(query);
}

const nameWords = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The words that name one of the bar's own rows. A function (a code, or a
 * pane it opens) is named by its name's first word, never each word of "Open
 * job postings" nor the examples it takes (EXPO's `NVDA=40%`). An action is
 * named by its `commandWords` alone (Fullscreen Pane's `full`, `maximize`):
 * its label and search text describe it ("Hide Cash Positions", "Open
 * Brokers") and name no ticker away. The AI's rows repeat what was typed
 * ("nvda · Ask Gloom") and name nothing.
 */
function commandWords(item: ResultItem): readonly string[] {
  if (item.category === ASSIST_CATEGORY || item.searchChoice) return [];
  if (item.shortcutQuery || item.id.startsWith("pane-template:")) return nameWords(item.label).slice(0, 1);
  return item.commandWords ?? [];
}

/**
 * Whether a word typed in small letters begins a word that names one of the
 * bar's own commands or actions (`commandWords`): "full" and "maxim" name
 * Fullscreen Pane. Such a word is the command, and a listing the same
 * letters make (EQ FULL) follows it. Capitals keep the symbol first, as a
 * ticker is written, and so does a word under four letters.
 */
export function wordNamesCommand(query: string, items: readonly ResultItem[]): boolean {
  return items.some((item) => commandNamedBy(query, item));
}

function commandNamedBy(query: string, item: ResultItem): boolean {
  const word = query.trim();
  return /^[a-z]{4,}$/.test(word) && (item.kind === "command" || item.kind === "action") && !item.disabled
    && commandWords(item).some((part) => part.startsWith(word));
}

/** The bar's own rows with the commands the word names first ("full": Fullscreen Pane before Research Search's "full text"). */
function leadWithNamedCommands(query: string, items: ResultItem[]): ResultItem[] {
  const named = items.filter((item) => commandNamedBy(query, item));
  return named.length ? [...named, ...items.filter((item) => !named.includes(item))] : items;
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

/** One listing however a row came to name it: a saved ticker, a search row, a broker's richer line of it. */
export function listingRowKey(item: ResultItem): string | null {
  if (!isInstrumentItem(item)) return null;
  const { symbol, exchange } = rowListing(item);
  return `${compactSearchText(symbol)}|${exchange}|${item.contractKey ?? ""}`;
}

/**
 * Search's answer with the listings already on screen leading, in the order
 * they were shown: the rows the index named before the answer stay where the
 * user saw them, and the answer's other rows follow. Search may rank the same
 * lines differently once it holds more of them, which would move the row under
 * the cursor.
 */
export function leadWithShownListings(items: ResultItem[], shown: readonly string[]): ResultItem[] {
  if (shown.length === 0) return items;
  const order = new Map(shown.map((key, index) => [key, index]));
  const leading: Array<{ item: ResultItem; at: number }> = [];
  const rest: ResultItem[] = [];
  for (const item of items) {
    const key = listingRowKey(item);
    const at = key == null ? undefined : order.get(key);
    if (at === undefined) rest.push(item);
    else leading.push({ item, at });
  }
  if (leading.length === 0) return items;
  leading.sort((left, right) => left.at - right.at);
  return [...leading.map(({ item }) => item), ...rest];
}

/**
 * A plain root query written as a Bloomberg code (`VOD LN`, `7203 JP Equity`,
 * `SPX Index`), as one whose market code no venue answers to (`AAPL GP`), or
 * nearly as a listing (`700.HK`, `6758.JP`, `BRK/B`), read by the one parser
 * every command reads them with. A code names its listing; the others only
 * name the symbol they were read from, offered as what was meant. Null for
 * anything else, which the bar searches as typed, and for a name before a
 * legal form (`SAP SE`, `SIEMENS AG`), which search finds as the company.
 */
export function readRootTickerQuery(query: string): RootTickerReading | null {
  const trimmed = query.trim();
  if (endsInLegalForm(trimmed)) return null;
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
  return rows.length > 0 ? rows : searchStatusRows(items);
}

/**
 * Up to the cap, in this order: the rows `shown` before search answered,
 * the first exact row of each security, the exact symbol's other exchanges,
 * then looser hits. The rows keep their
 * ranked order. Exchanges of one security share its issuer name and class;
 * a row `ownRow` names stands for itself.
 */
function pickRootInstruments(
  candidates: ResultItem[],
  isExact: (item: ResultItem) => boolean,
  shown: ReadonlySet<string> = new Set(),
  ownRow: (item: ResultItem) => boolean = () => false,
): ResultItem[] {
  if (candidates.length <= ROOT_INSTRUMENTS_LIMIT) return candidates;
  const exact = candidates.filter(isExact);
  const picked = new Set<ResultItem>();
  const securities = new Set<string>();
  const securityOf = (item: ResultItem) => ownRow(item)
    ? `row:${listingRowKey(item)}`
    : `${getIssuerGroupKey(item.detail) || item.id}|${item.badge ?? item.instrumentType ?? ""}`;
  // The rows on screen before search answered stay, and lead (`leadWithShownListings`):
  // another security the answer adds does not take one's row.
  for (const item of candidates) {
    if (picked.size >= ROOT_INSTRUMENTS_LIMIT) break;
    const key = shown.size > 0 ? listingRowKey(item) : null;
    if (key == null || !shown.has(key)) continue;
    picked.add(item);
    securities.add(securityOf(item));
  }
  for (const item of exact) {
    const security = securityOf(item);
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
