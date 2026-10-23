import { logFailure } from "../../utils/log-failure";
import type { SearchRequestContext, DataProvider } from "../../types/data-provider";
import type { InstrumentSearchResult } from "../../types/instrument";
import type { TickerRecord } from "../../types/ticker";
import { canonicalExchange, isSharedExchangeCode, isUsListingExchange, parsePublicTickerKey, publicTickerKey, typedExchangeCode } from "../../utils/exchanges";
import { getListingSymbol, listingSuffixConflictsWithExchange, tickerHasListingSuffix } from "../../sources/listing-symbols";
import { parseOptionSymbol } from "../../utils/options";
import { resolveCurrencyUnit } from "../../utils/currency-units";
import { currencyPairSpelling } from "../../utils/currency-pair";
import { assetClassMarketSymbol, parseAssetClassQuery } from "./asset-classes";
import { bareFuturesCode, futuresContractByCode } from "../../market-data/futures-board";
import { searchContractKey, searchInstrumentKey } from "./identity";
import { tickerInstrumentLabel } from "../instrument-label";
import {
  answersOnlyByKeyword,
  buildSymbolAliases,
  classifyInstrumentKind,
  findExactTickerSearchMatch,
  getForexQuoteCurrency,
  isExplicitMarketSymbol,
  isCryptoInstrumentType,
  normalizeSearchText,
  normalizeTickerSymbol,
  rankTickerSearchItems,
  themeQueryWord,
} from "./ranking";
import type {
  ResolvedTickerSearch,
  TickerSearchCandidate,
} from "./types";
import {
  getSearchResultSymbol,
  isLowQualityTickerName,
} from "./result";

import { typedPerpetualListing } from "../perpetual-listing";
import { readTerminalListingCode } from "../terminal-codes";
import { isProviderBusy, ProviderBusyError, SEARCH_BUSY_MESSAGE } from "../../sources/provider-errors";
import { settleWithin } from "../../utils/async-deadline";
import { companyNameExtraWords } from "../company-name";
import { withHomeListingLead } from "./home-listing";
import { delistingLabel } from "../../market-data/quotes/delisting";
export type {
  ResolvedTickerSearch,
  TickerSearchCandidate,
  TickerSearchInstrumentClass,
} from "./types";
export {
  findExactTickerSearchMatch,
  rankTickerSearchItems,
} from "./ranking";
export { upsertTickerFromSearchResult } from "./upsert";
export { candidateExchange, listingDistance } from "./home-listing";

const MAX_NAMED_LISTINGS = 6;

/**
 * Search rows a symbol's listings are read from, by the command bar's `SAN:`
 * venue list and the CLI's venue list alike. A keystroke's ten stop short of a
 * symbol several companies use: CAR's ASX line is its eleventh.
 */
export const LISTING_SEARCH_LIMIT = 30;

/**
 * A listing's name as a choice between listings gives it: a listing that no
 * longer trades says so and when ("First Republic Bank · Last traded Apr 28,
 * 2023"), and drops a name that only repeats its symbol.
 */
function listingChoiceName(result: InstrumentSearchResult): string {
  if (!result.delisting) return result.name;
  const name = result.name && normalizeTickerSymbol(result.name) !== normalizeTickerSymbol(result.symbol) ? result.name : "";
  return [name, delistingLabel(result.delisting)].filter(Boolean).join(" · ");
}

export class AmbiguousTickerError extends Error {
  constructor(readonly query: string, readonly listings: readonly string[], readonly listingNames: Readonly<Record<string, string>> = {}) {
    // Every listing is a choice: a list cut short could leave out the one meant.
    const more = listings.length - MAX_NAMED_LISTINGS;
    const named = `${listings.slice(0, MAX_NAMED_LISTINGS).join(", ")}${more > 0 ? ` or one of ${more} more in search` : ""}`;
    super(`Multiple listings match ${query}. Choose an exchange in search or use ${named}.`);
    this.name = "AmbiguousTickerError";
  }
}

export class AmbiguousContractError extends AmbiguousTickerError {
  constructor(query: string, contracts: readonly string[]) {
    super(query, contracts);
    this.name = "AmbiguousContractError";
    this.message = `Multiple contracts match ${query}. Choose a contract in search.`;
  }
}

const OPTION_TYPES = new Set(["OPT", "OPTION", "OPTIONS"]);

const SHARE_CLASS_SUFFIXES = new Set(["A", "B", "C", "D", "K"]);

/**
 * Venue codes people type after a dot in place of the listing suffix:
 * TTALO.HEL or TTALO.XHEL for TTALO.HE. Only tried once the literal symbol
 * finds nothing, so class shares such as BRK.B never reach them.
 */
const DOTTED_VENUE_CODES = new Set([
  "HEL", "XHEL", "STO", "XSTO", "CPH", "XCSE", "OSL", "XOSL",
  "AMS", "XAMS", "PAR", "XPAR", "LON", "XLON", "ETR", "XETR",
]);

/** The listing-suffix and colon spellings of `SYM.<venue code>`, in that order. */
function dottedVenueQueries(symbol: string): string[] {
  const dot = symbol.lastIndexOf(".");
  if (dot <= 0) return [];
  const base = symbol.slice(0, dot);
  const venue = symbol.slice(dot + 1);
  if (!DOTTED_VENUE_CODES.has(venue)) return [];
  return [...new Set([getListingSymbol(base, venue), `${base}:${venue}`])];
}

interface TickerSearchCandidateOptions {
  includeOptionContracts?: boolean;
  providerRanks?: ReadonlyMap<string, number>;
  providerPopularity?: ReadonlyMap<string, number>;
}

/**
 * The ticker typed, upper case; a perpetual's market id (`binance:BZUSDT`) as its listing (`BZUSDT:BINANCE`),
 * and a terminal's code for a US listing (`WFC.N`, `JPM US Equity`) as that listing (`WFC:NYSE`, `JPM`).
 */
export function normalizeTickerInput(activeTicker: string | null, arg?: string): string | null {
  const explicitTicker = arg ? (typedPerpetualListing(arg)?.key ?? readTerminalListingCode(arg)?.key ?? arg).trim().toUpperCase() : "";
  if (explicitTicker) return explicitTicker;
  return activeTicker;
}

export function createLocalTickerSearchCandidates(
  tickers: Iterable<TickerRecord>,
  providerHints: ReadonlyMap<string, InstrumentSearchResult> = new Map(),
  options: TickerSearchCandidateOptions = {},
): TickerSearchCandidate[] {
  return Array.from(tickers).flatMap((ticker) => {
    const symbol = normalizeTickerSymbol(ticker.metadata.ticker);
    const savedExchange = canonicalExchange(ticker.metadata.exchange);
    // The same symbol on another venue can be another security (MSFT's BYMA
    // receipt, NVO on Warsaw); it must not type or route the saved listing.
    const venueHint = providerHints.get(symbol);
    const hint = venueHint && savedExchange && isOtherVenue(venueHint, savedExchange) ? undefined : venueHint;
    const exchangeLabel = ticker.metadata.exchange || hint?.exchange || hint?.primaryExchange;
    const hintPrimaryExchange = canonicalExchange(hint?.primaryExchange);
    const primaryExchangeLabel = !savedExchange || !hintPrimaryExchange || savedExchange === hintPrimaryExchange
      ? hint?.primaryExchange
      : undefined;
    const contractResults = (ticker.metadata.broker_contracts ?? [])
      .filter((brokerContract) => searchContractKey({ brokerContract, type: ticker.metadata.assetCategory || "" }))
      .map((brokerContract): InstrumentSearchResult => ({
        providerId: brokerContract.brokerId, brokerInstanceId: brokerContract.brokerInstanceId,
        symbol: ticker.metadata.ticker, name: tickerInstrumentLabel(ticker.metadata.ticker, brokerContract),
        exchange: brokerContract.exchange || "", primaryExchange: brokerContract.primaryExchange, currency: brokerContract.currency,
        type: brokerContract.secType || ticker.metadata.assetCategory || "", brokerContract,
      }));
    if (!contractResults.length && options.includeOptionContracts === false && isOptionTickerRecord(ticker)) return [];
    return (contractResults.length ? contractResults : [hint])
      .filter((result) => options.includeOptionContracts !== false || !result || !isOptionSearchResult(result))
      .map((result) => {
        const contractKey = result ? searchContractKey(result) : null;
        const instrumentType = contractKey ? result!.type : hint?.brokerContract?.secType || hint?.type || ticker.metadata.assetCategory;
        const venue = contractKey ? result!.exchange : exchangeLabel;
        return {
          id: `goto:${ticker.metadata.ticker}`,
          label: ticker.metadata.ticker,
          symbol,
          detail: contractKey ? result!.name : resolveLocalSearchName(ticker, hint),
          right: venue,
          exchangeLabel: venue,
          primaryExchangeLabel: contractKey ? result!.primaryExchange : primaryExchangeLabel,
          providerRank: options.providerRanks?.get(symbol)
            ?? options.providerRanks?.get(publicTickerKey(symbol, ticker.metadata.exchange)),
          popularity: options.providerPopularity?.get(symbol),
          category: "Saved",
          kind: "ticker",
          saved: true,
          instrumentClass: classifyInstrumentKind(instrumentType),
          instrumentType,
          searchAliases: buildSymbolAliases(symbol),
          ticker,
          result,
          ...(contractKey ? { contractKey, id: `goto:${ticker.metadata.ticker}:${contractKey}` } : {}),
        } as TickerSearchCandidate;
      });
  });
}

function createProviderTickerSearchCandidates(
  searchResults: InstrumentSearchResult[],
  localTickers: ReadonlyMap<string, TickerRecord>,
  options: TickerSearchCandidateOptions = {},
): TickerSearchCandidate[] {
  return searchResults.flatMap((result, providerRank) => {
    if (options.includeOptionContracts === false && isOptionSearchResult(result)) return [];
    const symbol = getSearchResultSymbol(result);
    const currency = result.currency || getForexQuoteCurrency(symbol);
    if (currency && !result.currency) result = { ...result, currency };
    const listingKey = publicTickerKey(symbol, listingExchange(result));
    const savedTicker = localTickers.get(listingKey) ?? localTickers.get(symbol);
    const saved = !!savedTicker
      && publicTickerKey(savedTicker.metadata.ticker, savedTicker.metadata.exchange) === listingKey;
    return [{
      id: buildProviderCandidateId(result, symbol),
      contractKey: searchContractKey(result),
      label: symbol,
      symbol,
      detail: [result.name, result.brokerLabel, result.type].filter(Boolean).join(" | "),
      right: result.exchange || result.primaryExchange || result.type || undefined,
      exchangeLabel: result.exchange,
      primaryExchangeLabel: result.primaryExchange,
      providerRank,
      popularity: searchResultPopularity(result),
      category: saved ? "Saved" : "Other Listings",
      kind: "search",
      saved,
      instrumentClass: classifyInstrumentKind(result.brokerContract?.secType || result.type),
      instrumentType: result.brokerContract?.secType || result.type,
      searchAliases: buildSearchResultAliases(result),
      ...(searchResultKeywords(result) ? { searchKeywords: searchResultKeywords(result) } : {}),
      result,
    }];
  });
}

export async function searchTickerCandidates({
  query: rawQuery,
  tickers,
  dataProvider,
  searchContext,
  localLimit = 6,
  totalLimit = 8,
  includeOptionContracts = true,
  onPartial,
}: {
  query: string;
  tickers: ReadonlyMap<string, TickerRecord>;
  dataProvider: DataProvider;
  searchContext?: SearchRequestContext;
  localLimit?: number;
  totalLimit?: number;
  includeOptionContracts?: boolean;
  /** Called when a slower, richer source improves results already returned. */
  onPartial?: (candidates: TickerSearchCandidate[]) => void;
}): Promise<TickerSearchCandidate[]> {
  const query = symbolSearchQuery(rawQuery);
  const assemble = (providerResults: InstrumentSearchResult[]) => buildTickerSearchCandidates({
    query,
    tickers,
    providerResults,
    localLimit,
    totalLimit,
    // A search that hides contracts still shows them when asked: "AAPL OPT".
    includeOptionContracts: includeOptionContracts || parseAssetClassQuery(query)?.code === "OPT",
  });
  const { results, busy } = await searchProviderResults(
    dataProvider,
    query,
    searchContext,
    onPartial ? (found) => onPartial(assemble(found)) : undefined,
    true,
  );
  const candidates = assemble(results);
  // Saved tickers or another source's rows still answer. Nothing at all, because a source was busy, is no answer.
  if (busy && candidates.length === 0) throw new ProviderBusyError(SEARCH_BUSY_MESSAGE);
  return candidates;
}

export function buildTickerSearchCandidates({
  query,
  tickers,
  providerResults,
  localLimit = 6,
  totalLimit = 8,
  includeOptionContracts = true,
}: {
  query: string;
  tickers: ReadonlyMap<string, TickerRecord>;
  providerResults: InstrumentSearchResult[];
  localLimit?: number;
  totalLimit?: number;
  includeOptionContracts?: boolean;
}): TickerSearchCandidate[] {
  const filteredProviderResults = includeOptionContracts
    ? providerResults
    : providerResults.filter((result) => !isOptionSearchResult(result));
  const providerHints = buildProviderHints(filteredProviderResults, tickers);
  const candidateOptions = {
    includeOptionContracts,
    providerRanks: providerHints.ranks,
    providerPopularity: providerHints.popularity,
  };
  const localItems = rankTickerSearchItems(
    createLocalTickerSearchCandidates(tickers.values(), providerHints.results, candidateOptions),
    query,
  );
  const providerItems = createProviderTickerSearchCandidates(filteredProviderResults, tickers, candidateOptions);
  const ranked = withHomeListingLead(withSuccessorFirst(rankTickerSearchItems([...localItems, ...providerItems], query), query), query);
  return limitTickerSearchCandidates(assignTickerSearchCategories(ranked, query), totalLimit, localLimit);
}

/** Whether a query is the start of a merged company's name, as the service matched it ("Golden Ocean"). */
function namesFormerIssuer(query: string, former: InstrumentSearchResult["formerIssuer"]): boolean {
  const asked = normalizeSearchText(query);
  return !!former?.name && asked.length > 0 && normalizeSearchText(former.name).startsWith(asked);
}

/**
 * A query naming a company that merged away ("Golden Ocean") lists the
 * company it merged into first (CMB.Tech's CMBT, the row the service added
 * for the old name), so it is the primary listing, though a leftover line of
 * the old company (GOLDEN OCEAN GROUP, GOGLC on BYMA) matches the name
 * better. The old company's lines follow it, each linked to it when its name
 * is the merged company's, so they say what it became; a line search cannot
 * link keeps its place below. Saved tickers keep theirs.
 */
function withSuccessorFirst<T extends TickerSearchCandidate>(items: T[], query: string): T[] {
  const successor = items.find((item) => item.kind === "search" && !item.saved && item.instrumentClass === "equity"
    && namesFormerIssuer(query, item.result?.formerIssuer));
  const former = successor?.result?.formerIssuer;
  if (!successor || !former) return items;
  // The successor as the service names it beside a quote too, so both print the same line.
  const linked = { ...former, successor: former.successor ?? { symbol: successor.symbol, name: successor.result?.name ?? null } };
  const leftovers = items.filter((item) => item !== successor && item.kind === "search" && !item.saved
    && !item.result?.formerIssuer && companyNameExtraWords(former.name, item.result?.name) === 0);
  const at = items.findIndex((item) => item.kind === "search" && !item.saved);
  const rest = items.filter((item) => item !== successor && !leftovers.includes(item));
  return [
    ...rest.slice(0, at),
    successor,
    ...leftovers.map((item) => ({ ...item, result: { ...item.result!, formerIssuer: linked } })),
    ...rest.slice(at),
  ];
}

interface ResolveTickerSearchOptions {
  query?: string;
  activeTicker: string | null;
  tickers: ReadonlyMap<string, TickerRecord>;
  dataProvider: DataProvider;
  searchContext?: SearchRequestContext;
}

/** `NET:` asks which NET. `NET:N` narrows that list. `NET:XNYS` already names one. An index (`^VIX:`) is asked the same way. */
const LISTING_PICKER_QUERY = /^[A-Z0-9^][A-Z0-9.\-]{0,20}:$/;
const LISTING_CHOICE_QUERY = /^([A-Z0-9^][A-Z0-9.\-]{0,20}):([A-Z0-9.\-]*)$/;

function isListingPickerQuery(query: string): boolean {
  return LISTING_PICKER_QUERY.test(query.trim().toUpperCase());
}

/** `NET:` and `NET:N` name a symbol plus the exchange prefix still being typed. */
export function listingChoiceQuery(query: string): { symbol: string; suffix: string } | null {
  const match = LISTING_CHOICE_QUERY.exec(query.trim().toUpperCase());
  if (!match?.[1]) return null;
  return { symbol: match[1], suffix: match[2] ?? "" };
}

/** Search text for a ticker query. A trailing colon searches the symbol it qualifies. */
export function symbolSearchQuery(query: string): string {
  const trimmed = query.trim();
  if (!isListingPickerQuery(trimmed)) return trimmed;
  return trimmed.slice(0, -1).toUpperCase();
}

export function resolveTickerSearch(options: ResolveTickerSearchOptions): Promise<ResolvedTickerSearch | null> {
  const requested = normalizeTickerInput(options.activeTicker, options.query);
  if (!requested) return Promise.resolve(null);
  // `NET:` lists NET's venues instead of settling on one.
  const pickListing = isListingPickerQuery(requested);
  const typed = symbolSearchQuery(requested);
  // A futures board code no security uses is its future (TTF is TTF=F), unless a saved ticker holds it.
  const future = pickListing || options.tickers.has(typed) ? null : bareFuturesCode(typed);
  // A currency pair is the one listing the service has for it, however it is written: EUR/USD and
  // JPY=X are EURUSD=X and USDJPY=X. USD-NGN and USDNGN, which a security could also be written as
  // (MNT-USD is a coin), are the pair only when nothing is listed under those letters.
  const pair = pickListing || future ? null : currencyPairSpelling(typed);
  const symbol = future?.symbol ?? (pair && !pair.ambiguous ? pair.symbol : typed);
  const literal = resolveTickerSymbol(symbol, options, pickListing ? requested : null);
  const alternatives = pickListing ? [] : [...dottedVenueQueries(symbol), ...pair?.ambiguous ? [pair.symbol] : []];
  // A listing suffix search does not carry (CEZ.PR) is read from its own quote, as `quote` reads it.
  const quoted = !pickListing && tickerHasListingSuffix(symbol) && !parsePublicTickerKey(symbol).exchange;
  // Most input has no venue code to retry: hand back the literal lookup
  // itself, so it settles no later than it did before the retry existed.
  if (alternatives.length === 0 && !quoted) return literal;
  // A spelling search was too busy to answer is no miss: the others still get
  // their turn, and only when none resolves does the lookup say search was busy.
  let busy: ProviderBusyError | null = null;
  const unlessBusy = (lookup: Promise<ResolvedTickerSearch | null>) => lookup.catch((error: unknown) => {
    if (!isProviderBusy(error)) throw error;
    busy ??= error;
    return null;
  });
  return unlessBusy(literal).then(async (resolved) => {
    for (const alternative of resolved ? [] : alternatives) {
      const match = await unlessBusy(resolveTickerSymbol(alternative, options, null));
      if (match) return match;
    }
    const found = resolved ?? (quoted ? await quotedSuffixListing(symbol, options) : null);
    if (!found && busy) throw busy;
    return found;
  });
}

/** As long as a search source gets: past it, the key reads as unmatched. */
const SUFFIX_QUOTE_TIMEOUT_MS = 5_000;

/**
 * A suffixed listing (CEZ.PR, PETR4.SA, VOLV-B.ST) that search does not list,
 * vouched for by its own quote: the quote answers for that key, prices it, and
 * names a venue the suffix belongs to. This is how `quote` and opening the
 * key from the command bar read it, so adding it to a watchlist, a portfolio
 * or the first-run positions takes the same listing.
 */
async function quotedSuffixListing(
  symbol: string,
  { dataProvider, searchContext }: ResolveTickerSearchOptions,
): Promise<ResolvedTickerSearch | null> {
  // No source prices the key, or none answers in time: it stays unmatched.
  const quote = await settleWithin(dataProvider.getQuote(symbol, "", {
    brokerId: searchContext?.brokerId,
    brokerInstanceId: searchContext?.brokerInstanceId,
  }), SUFFIX_QUOTE_TIMEOUT_MS);
  if (!quote) return null;
  const exchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
  if (!exchange || normalizeTickerSymbol(quote.symbol || "") !== symbol
    || !Number.isFinite(quote.price) || quote.price === 0
    || listingSuffixConflictsWithExchange(symbol, exchange)) return null;
  return {
    kind: "provider",
    symbol,
    result: {
      providerId: dataProvider.id,
      symbol,
      name: quote.name?.trim() || symbol,
      exchange,
      currency: quote.currency || undefined,
      type: quote.instrumentType || "",
    },
    quote,
  };
}

async function resolveTickerSymbol(
  symbol: string,
  { tickers, dataProvider, searchContext }: ResolveTickerSearchOptions,
  /** The `NET:` text that asked for every venue, or null to settle on one. */
  pickerQuery: string | null,
): Promise<ResolvedTickerSearch | null> {
  const local = tickers.get(symbol)
    ?? findExactTickerSearchMatch(createLocalTickerSearchCandidates(tickers.values()), symbol)?.ticker
    ?? null;
  if (local) {
    const contracts = new Map((local.metadata.broker_contracts ?? []).flatMap((brokerContract) => {
      const key = searchContractKey({ brokerContract, type: local.metadata.assetCategory || "" });
      return key ? [[key, brokerContract] as const] : [];
    }));
    if (contracts.size > 1) throw new AmbiguousContractError(symbol,
      [...contracts.values()].map((contract) => tickerInstrumentLabel(local.metadata.ticker, contract)));
  }
  // A saved symbol keeps its company. The colon still offers the others.
  const saved: ResolvedTickerSearch | null = local ? { kind: "local", symbol: local.metadata.ticker, ticker: local } : null;
  if (saved && !pickerQuery) return saved;

  const { results, busy } = await searchProviderResults(dataProvider, symbol, searchContext);
  const providerItems = createProviderTickerSearchCandidates(results, tickers);
  const literalMatches = providerItems.filter((item) => normalizeTickerSymbol(item.symbol) === symbol);
  const matches = literalMatches.length ? literalMatches
    : providerItems.filter((item) => findExactTickerSearchMatch([item], symbol));
  let exactMatch = matches[0];
  if (!exactMatch?.result) {
    // Nothing matched while a source was too busy to answer: that is no answer, not a miss.
    if (busy && !saved) throw new ProviderBusyError(SEARCH_BUSY_MESSAGE);
    return saved;
  }

  const contracts = new Set(matches.map((item) => item.contractKey).filter(Boolean));
  if (contracts.size > 1 || (contracts.size && matches.some((item) => !item.contractKey))) {
    throw new AmbiguousContractError(symbol, matches.map((item) => tickerInstrumentLabel(item.symbol, item.result?.brokerContract)));
  }
  const listings = new Set(matches.map((item) => publicTickerKey(item.symbol, listingExchange(item.result!))));
  const ambiguity = (query: string) => new AmbiguousTickerError(query, [...listings], Object.fromEntries(matches.map((item) => [
    publicTickerKey(item.symbol, listingExchange(item.result!)), listingChoiceName(item.result!),
  ])));
  if (pickerQuery && listings.size > 1) throw ambiguity(pickerQuery);
  // A code that names several venues (TSE) the symbol trades on more than one of is a choice.
  if (!saved && isSharedExchangeCode(typedExchangeCode(symbol))
    && new Set(matches.map((item) => canonicalExchange(listingExchange(item.result!)))).size > 1) throw ambiguity(symbol);
  if (saved) return saved;
  if (listings.size > 1 && !parsePublicTickerKey(symbol).exchange && !tickerHasListingSuffix(symbol)) {
    // Search order is relevance, not a canonical listing identifier. Align bare
    // symbols with the quote source only when it supplies the exact identity.
    let verified: TickerSearchCandidate[] = [];
    try {
      const quote = await dataProvider.getQuote(symbol, "", {
        brokerId: searchContext?.brokerId,
        brokerInstanceId: searchContext?.brokerInstanceId,
      });
      const exchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
      const currency = resolveCurrencyUnit(quote.currency).currency;
      const ended = quote.delisting;
      if (ended) {
        // The symbol's own quote is a US listing that no longer trades (a bare FRC, whose
        // venue is not on record): it is the run search offers with the same last session.
        verified = matches.filter((item) => item.result?.delisting?.lastTradeDate === ended.lastTradeDate);
      } else if (exchange && currency && Number.isFinite(quote.price) && quote.price !== 0
        && Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0) {
        const sameSecurity = matches.filter((item) => {
          const result = item.result!;
          const candidateCurrency = resolveCurrencyUnit(result.currency).currency;
          return (!candidateCurrency || candidateCurrency === currency)
            && findExactTickerSearchMatch([{ label: quote.symbol, right: exchange, instrumentType: quote.instrumentType }], item.symbol)
            && (!isCryptoInstrumentType(result.type) || quote.price > 0);
        });
        verified = quotedListings(sameSecurity, exchange).map((item) => ({ ...item, result: { ...item.result!, currency } }));
      }
    } catch (error) {
      logFailure("tickers-search", "Could not verify default listing")(error);
    }
    if (new Set(verified.map((item) => publicTickerKey(item.symbol, listingExchange(item.result!)))).size !== 1) {
      throw ambiguity(symbol);
    }
    exactMatch = verified[0]!;
    const chosen = publicTickerKey(exactMatch.symbol, listingExchange(exactMatch.result!));
    return { kind: "provider", symbol: exactMatch.symbol, result: exactMatch.result!, otherListings: [...listings].filter((key) => key !== chosen) };
  }

  return {
    kind: "provider",
    symbol: exactMatch.symbol,
    result: exactMatch.result!,
  };
}

/**
 * The listings a bare symbol's own quote is on: those on the venue it names.
 * The US exchanges share one symbol namespace, so a quote on any of them is
 * the symbol's one US listing, whichever venue the feed labels it with (ET's
 * NYSE line comes back as NYSE American).
 */
function quotedListings(items: TickerSearchCandidate[], exchange: string): TickerSearchCandidate[] {
  const venue = (item: TickerSearchCandidate) => canonicalExchange(listingExchange(item.result!));
  const named = items.filter((item) => venue(item) === exchange);
  if (named.length > 0 || !isUsListingExchange(exchange)) return named;
  return items.filter((item) => isUsListingExchange(venue(item)));
}

/** The venue a search row is a listing on: the primary exchange when a broker routes through SMART. */
export function listingExchange(result: InstrumentSearchResult): string {
  return result.exchange === "SMART" ? result.primaryExchange || result.exchange
    : result.exchange || result.primaryExchange || "";
}

function buildProviderHints(
  searchResults: InstrumentSearchResult[],
  localTickers: ReadonlyMap<string, TickerRecord>,
): {
  results: Map<string, InstrumentSearchResult>;
  ranks: Map<string, number>;
  popularity: Map<string, number>;
} {
  const results = new Map<string, InstrumentSearchResult>();
  const ranks = new Map<string, number>();
  const popularity = new Map<string, number>();
  for (const [rank, result] of searchResults.entries()) {
    const symbol = getSearchResultSymbol(result);
    if (!ranks.has(symbol)) ranks.set(symbol, rank);
    // A saved second listing is keyed with its venue (SAP:XETR); it takes
    // that venue's place instead of the end of the issuer's listings.
    const listingKey = publicTickerKey(symbol, listingExchange(result));
    if (listingKey !== symbol && !ranks.has(listingKey)) ranks.set(listingKey, rank);
    const score = searchResultPopularity(result);
    if (score != null) popularity.set(symbol, Math.max(score, popularity.get(symbol) ?? score));
    const existing = results.get(symbol);
    const preferredExchange = localTickers.get(symbol)?.metadata.exchange;
    if (
      !existing
      || getProviderHintScore(result, preferredExchange) > getProviderHintScore(existing, preferredExchange)
    ) {
      results.set(symbol, result);
    }
  }
  return { results, ranks, popularity };
}

/** Older servers and other providers send no popularity; ignore anything else malformed. */
function searchResultPopularity(result: InstrumentSearchResult): number | undefined {
  return typeof result.popularity === "number" && Number.isFinite(result.popularity) ? result.popularity : undefined;
}

interface ProviderSearch {
  results: InstrumentSearchResult[];
  /** A spelling went unanswered because a source was busy, so an empty list may not mean nothing matches. */
  busy: boolean;
}

async function searchProviderResults(
  dataProvider: DataProvider,
  rawQuery: string,
  searchContext?: SearchRequestContext,
  onPartial?: (results: InstrumentSearchResult[]) => void,
  /** Also look for the funds of a sector word, for a list of matches rather than one resolved symbol. */
  withThemeFunds = false,
): Promise<ProviderSearch> {
  const assetClass = parseAssetClassQuery(rawQuery);
  const query = assetClass?.symbolQuery ?? rawQuery;
  // The variants are independent lookups of the same words, so they run
  // together. Awaited in turn they multiplied every per-source timeout by the
  // number of spellings tried. Their rows list in the order the spellings
  // are, not as they arrive. Only keyword-tagged whole-query matches lead
  // the spelling answers; a loose name match must not displace an exact listing.
  const searchQueries = providerSearchQueries(rawQuery);
  const answers: InstrumentSearchResult[][] = searchQueries.map(() => []);
  const wholeIndex = assetClass && (assetClass.code === "ETF" || assetClass.code === "FUND")
    ? searchQueries.findIndex((asked) => sameSearchText(asked, rawQuery)) : -1;
  const taggedWhole = (result: InstrumentSearchResult) =>
    searchResultKeywords(result)?.some((keyword) => sameSearchText(keyword, rawQuery)) ?? false;
  // A later source can send back a richer version of a row already recorded;
  // it replaces the row in its place, so an upgrade does not reorder the list.
  const upgrades = new Map<string, InstrumentSearchResult>();
  // A sector word's funds, which lead, and a market symbol verified by its quote, which follows (both below).
  let leading: InstrumentSearchResult[] = [];
  let verified: InstrumentSearchResult[] = [];
  const byKey = new Map<string, InstrumentSearchResult>();
  const merge = () => {
    const named = new Map<string, InstrumentSearchResult>();
    const whole = answers[wholeIndex] ?? [];
    const ordered = [
      ...whole.filter(taggedWhole),
      ...answers.flatMap((rows, index) => index === wholeIndex ? [] : rows),
      ...whole.filter((result) => !taggedWhole(result)),
      ...verified,
    ];
    for (const result of ordered) {
      const key = buildProviderSearchResultKey(result);
      if (!named.has(key)) named.set(key, upgrades.get(key) ?? result);
    }
    byKey.clear();
    for (const result of leading) {
      const key = buildProviderSearchResultKey(result);
      if (!byKey.has(key)) byKey.set(key, result);
    }
    // A row both found keeps the funds' place and the name search's richer version of it (its theme).
    for (const [key, result] of named) byKey.set(key, result);
  };
  let busy = false;
  await Promise.all(searchQueries.map(async (searchQuery, index) => {
    try {
      const results = await dataProvider.search(searchQuery, {
        ...searchContext,
        ...(onPartial
          ? {
            onPartial: (upgraded: InstrumentSearchResult[]) => {
              answers[index] = upgraded;
              for (const result of upgraded) upgrades.set(buildProviderSearchResultKey(result), result);
              merge();
              onPartial([...byKey.values()]);
            },
          }
          : {}),
      });
      answers[index] = results;
      merge();
    } catch (error) {
      if (isProviderBusy(error)) busy = true;
      else logFailure("tickers-search", "Could not search ticker spelling")(error);
    }
  }));

  // Catalogues can omit exact market symbols or return a crypto pair from a
  // different venue. Verify the requested quote before accepting an alias.
  const requested = parsePublicTickerKey(normalizeTickerSymbol(query));
  const possibleCryptoPair = /^[A-Z0-9]{1,15}-[A-Z]{3,5}$/.test(requested.symbol);
  if ((isExplicitMarketSymbol(query) || possibleCryptoPair)
    && !findExactTickerSearchMatch([...byKey.values()].map((result) => ({
      label: getSearchResultSymbol(result), instrumentType: result.type, right: result.exchange,
    })), query)) {
    const { symbol, exchange } = requested;
    const marketType = /=F$/.test(symbol) ? "FUTURE"
      : /^(?:[A-Z]{3}(?:\/[A-Z]{3}|(?:[A-Z]{3})?=X))$/.test(symbol) ? "CURRENCY"
      : /^\^[A-Z0-9.-]+$/.test(symbol) ? "INDEX" : null;
    if (marketType || possibleCryptoPair) {
      try {
        const quote = await dataProvider.getQuote(symbol, exchange);
        const type = isCryptoInstrumentType(quote.instrumentType) ? quote.instrumentType : marketType;
        if (Number.isFinite(quote.price) && quote.price !== 0
          && Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0
          && quote.currency?.trim()
          && type
          && (!isCryptoInstrumentType(type) || quote.price > 0)
          && (!exchange || canonicalExchange(quote.listingExchangeName || quote.exchangeName) === exchange)
          && (possibleCryptoPair ? normalizeTickerSymbol(quote.symbol) === symbol
            : findExactTickerSearchMatch([{ label: quote.symbol }], symbol))) {
          verified = [{
            providerId: quote.providerId || dataProvider.id,
            symbol,
            name: quote.name || symbol,
            exchange: exchange || quote.listingExchangeName || quote.exchangeName || "",
            currency: quote.currency,
            type,
          }];
          merge();
        }
      } catch (error) {
        logFailure("tickers-search", "Could not verify market symbol")(error);
      }
    }
  }

  // A sector word ("defense", which the server answers with rows tagged with it) lists its small companies by
  // name; the server orders "defense ETF" by size, which a name search does not. Those funds lead the list.
  // So do they when the funds are asked for by name: "defense etf" searches "defense", whose answer holds
  // only the few funds tagged with it (not ITA), and "gold miners etf" a phrase no symbol is.
  const fundsAsked = assetClass?.code === "ETF" || assetClass?.code === "FUND";
  const theme = withThemeFunds && (!assetClass || fundsAsked)
    && (themeQueryWord([...byKey.values()], query) || (fundsAsked && /\s/.test(query.trim())));
  if (theme) {
    try {
      // "spot bitcoin ETF" was asked whole above, and its answer is these funds: not asked twice.
      const themeQuery = `${query.trim()} ETF`;
      const askedAt = searchQueries.findIndex((asked) => sameSearchText(asked, themeQuery));
      const { onPartial: _ignored, ...context } = searchContext ?? {};
      leading = askedAt >= 0 ? answers[askedAt]! : await dataProvider.search(themeQuery, context);
      merge();
    } catch (error) {
      logFailure("tickers-search", "Could not search theme funds")(error);
    }
  }

  return { results: [...byKey.values()], busy };
}

/** Two search texts the server answers alike: its search ignores case and runs of spaces. */
function sameSearchText(left: string, right: string): boolean {
  const key = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
  return key(left) === key(right);
}

/**
 * The searches a lookup of `rawQuery` asks the sources for: its spellings (BRK.B,
 * BRK-B), and the future a board code or an asset class names. A list of symbols
 * asks for all of them at once beforehand (`batchedListLookups`).
 */
export function providerSearchQueries(rawQuery: string): string[] {
  // "ES FUT" looks up ES, and ES=F as well: the catalogue answers a bare root
  // with stocks only. The ranking keeps the futures.
  const assetClass = parseAssetClassQuery(rawQuery);
  const query = assetClass?.symbolQuery ?? rawQuery;
  const marketSymbol = assetClass ? assetClassMarketSymbol(assetClass) : null;
  const searchQueries = buildProviderSearchQueries(query);
  if (marketSymbol && !searchQueries.includes(marketSymbol)) searchQueries.push(marketSymbol);
  // Words before ETF or FUND name a kind of fund as well as a name ("bitcoin ETF", "spot ether ETF"), which
  // the server answers whole with the funds of that kind. merge() promotes its keyword-tagged rows.
  if (assetClass && (assetClass.code === "ETF" || assetClass.code === "FUND") && /\p{L}{2}/u.test(query)) {
    const whole = rawQuery.trim().replace(/\s+/g, " ");
    if (!searchQueries.includes(whole)) searchQueries.unshift(whole);
  }
  // A futures board code also finds its future, which the catalogue files under
  // the continuous symbol only: NG finds NovaGold and NG=F.
  const boardFuture = assetClass ? null : futuresContractByCode(query)?.symbol;
  if (boardFuture && !searchQueries.includes(boardFuture)) searchQueries.push(boardFuture);
  return searchQueries;
}

function buildProviderSearchQueries(query: string): string[] {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];
  const qualified = parsePublicTickerKey(trimmedQuery);
  if (qualified.exchange) return [trimmedQuery.toUpperCase(), qualified.symbol];
  if (tickerHasListingSuffix(trimmedQuery.toUpperCase())) return [trimmedQuery.toUpperCase()];

  const symbolLike = /^[A-Za-z0-9.^=\-/]+$/.test(trimmedQuery);
  const queries = new Set<string>();

  if (!symbolLike) queries.add(trimmedQuery);
  for (const alias of buildSymbolAliases(trimmedQuery)) queries.add(alias);
  for (const alias of buildCompactShareClassAliases(trimmedQuery)) queries.add(alias);
  queries.add(trimmedQuery);
  return [...queries].slice(0, 4);
}

function buildCompactShareClassAliases(query: string): string[] {
  const normalized = normalizeTickerSymbol(query);
  if (!/^[A-Z]{4,5}$/.test(normalized)) return [];
  const shareClass = normalized.slice(-1);
  if (!SHARE_CLASS_SUFFIXES.has(shareClass)) return [];
  const base = normalized.slice(0, -1);
  if (base.length < 2) return [];
  return [`${base}-${shareClass}`, `${base}.${shareClass}`];
}

function buildProviderSearchResultKey(result: InstrumentSearchResult): string {
  return searchInstrumentKey(result);
}

function buildProviderCandidateId(result: InstrumentSearchResult, symbol: string): string {
  return [
    "search",
    normalizeTickerSymbol(symbol),
    normalizeSearchText(result.exchange || result.primaryExchange || result.type || ""),
    normalizeSearchText(result.currency || ""),
    normalizeSearchText(result.providerId || ""),
    searchContractKey(result),
  ].filter(Boolean).join(":");
}

function getProviderHintRichness(result: InstrumentSearchResult): number {
  let score = 0;
  if (result.name) score += Math.min(120, result.name.length);
  if (result.exchange) score += 60;
  if (result.primaryExchange) score += 40;
  if (result.currency) score += 20;
  return score;
}

function resultVenues(result: InstrumentSearchResult): string[] {
  return [
    result.exchange,
    result.primaryExchange,
    result.brokerContract?.exchange,
    result.brokerContract?.primaryExchange,
  ].map((exchange) => canonicalExchange(exchange)).filter(Boolean);
}

/** A result that names a listing venue, none of them the saved one. Broker
 * routing (SMART) names no venue. */
function isOtherVenue(result: InstrumentSearchResult, savedExchange: string): boolean {
  if (savedExchange === "SMART") return false;
  const venues = resultVenues(result).filter((exchange) => exchange !== "SMART");
  return venues.length > 0 && !venues.includes(savedExchange);
}

function getProviderHintScore(result: InstrumentSearchResult, preferredExchange?: string): number {
  const canonicalPreferredExchange = canonicalExchange(preferredExchange);
  const matchesPreferredExchange = !!canonicalPreferredExchange
    && resultVenues(result).includes(canonicalPreferredExchange);
  return getProviderHintRichness(result) + (matchesPreferredExchange ? 10_000 : 0);
}

/** Older servers send none; anything malformed is ignored. */
function searchResultKeywords(result: InstrumentSearchResult): string[] | undefined {
  const keywords = Array.isArray(result.searchKeywords)
    ? result.searchKeywords.filter((keyword): keyword is string => typeof keyword === "string" && !!keyword.trim())
    : [];
  return keywords.length > 0 ? keywords : undefined;
}

function assignTickerSearchCategories<T extends TickerSearchCandidate>(items: T[], query: string): T[] {
  let assignedPrimaryListing = false;

  return items.map((item) => {
    // A company the theme's funds hold is not another listing of the one searched for.
    if (!item.saved && item.kind === "search" && item.instrumentClass === "equity" && answersOnlyByKeyword(item, query)) {
      return { ...item, category: "Related" };
    }
    if (item.saved || item.kind === "ticker") {
      if (item.instrumentClass !== "fund" && item.instrumentClass !== "derivative") {
        assignedPrimaryListing = true;
      }
      return { ...item, category: "Saved" };
    }
    if (item.instrumentClass === "fund" || item.instrumentClass === "derivative") {
      return { ...item, category: "Funds & Derivatives" };
    }
    if (!assignedPrimaryListing) {
      assignedPrimaryListing = true;
      return { ...item, category: "Primary Listing" };
    }
    return { ...item, category: "Other Listings" };
  }) as T[];
}

function limitTickerSearchCandidates<T extends TickerSearchCandidate>(
  items: T[],
  totalLimit: number,
  savedLimit: number,
): T[] {
  const limited: T[] = [];
  let savedCount = 0;

  for (const item of items) {
    if (limited.length >= totalLimit) break;
    if (item.category === "Saved") {
      if (savedCount >= savedLimit) continue;
      savedCount += 1;
    }
    limited.push(item);
  }

  return limited;
}

function resolveLocalSearchName(ticker: TickerRecord, hint?: InstrumentSearchResult): string {
  if (hint?.name && isLowQualityTickerName(ticker.metadata.name, ticker.metadata.ticker)) {
    return hint.name;
  }
  return ticker.metadata.name;
}

function isOptionTickerRecord(ticker: TickerRecord): boolean {
  return isOptionType(ticker.metadata.assetCategory)
    || parseOptionSymbol(ticker.metadata.ticker) != null
    || (ticker.metadata.broker_contracts ?? []).some(isOptionBrokerContract);
}

function isOptionSearchResult(result: InstrumentSearchResult): boolean {
  return isOptionType(result.type)
    || parseOptionSymbol(result.symbol) != null
    || isOptionBrokerContract(result.brokerContract);
}

function isOptionBrokerContract(contract: InstrumentSearchResult["brokerContract"]): boolean {
  if (!contract) return false;
  return isOptionType(contract.secType)
    || parseOptionSymbol(contract.localSymbol || "") != null
    || contract.right === "C"
    || contract.right === "P"
    || contract.strike != null;
}

function isOptionType(rawType?: string): boolean {
  return OPTION_TYPES.has(normalizeSearchText(rawType || ""));
}

function buildSearchResultAliases(result: InstrumentSearchResult): string[] {
  const aliases = new Set(buildSymbolAliases(result.symbol));
  const resolvedSymbol = getSearchResultSymbol(result);
  for (const alias of buildSymbolAliases(resolvedSymbol)) aliases.add(alias);
  if (result.brokerContract?.symbol) {
    for (const alias of buildSymbolAliases(result.brokerContract.symbol)) aliases.add(alias);
  }
  // Older servers send none. Anything else malformed is ignored.
  if (Array.isArray(result.searchAliases)) {
    for (const alias of result.searchAliases) {
      if (typeof alias === "string" && alias.trim()) aliases.add(alias.trim());
    }
  }
  return [...aliases];
}
