import { logFailure } from "../utils/log-failure";
import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { TickerRecord } from "../types/ticker";
import type { AppTickerRepositoryPort } from "../core/app-service-ports";
import { connectionHealth, GLOOM_CLOUD_HTTP_CONNECTION_ID } from "../core/connection-health";
import { mapWithConcurrency } from "../utils/concurrency";
import {
  AmbiguousContractError,
  AmbiguousTickerError,
  resolveTickerSearch,
  upsertTickerFromSearchResult,
  type ResolvedTickerSearch,
} from "../tickers/search";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";
import {
  chosenListingNote,
  ListingArgError,
  listingChoiceNote,
  listingReadNotes,
  listingVenues,
  movedSymbolLine,
  notTradedMessage,
  parseListingArg,
  quoteBareListing,
  resolveCliListing,
  savedListingName,
  type CliListing,
  type ListingChoice,
  type ListingDeps,
} from "./listing-arg";
import { listingChangeLine, loadListingFate, noLongerTradingNote, tradingListing } from "../tickers/listing-fate";
import {
  describeFormerIssuer,
  describeTickerChange,
  movedAwayChange,
  LOOKUP_TIMEOUT_MS,
  startTickerChangeLookup,
  tickerChangeLine,
  tickerChangeSymbol,
  type CurrentListing,
  type FormerIssuer,
  type TickerChange,
  type TickerChangeLookup,
} from "../tickers/ticker-changes";
import { batchedListLookups, type ListLookupPlan } from "../tickers/batched-lookups";
import { providerSearchQueries } from "../tickers/search";
import { coinElsewhereNote, savedListingCoinNote } from "./commands/crypto-hints";

/** The saved ticker for a symbol (`SAN:EPA`, or `SAN` with `--exchange EPA`), saving it from search first if needed. */
export async function resolveTickerForCli(
  symbol: string,
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  exchange?: string,
): Promise<TickerRecord> {
  return (await resolveCliTicker(symbol, store, dataProvider, exchange)).ticker;
}

export interface CliTicker {
  ticker: TickerRecord;
  /**
   * What to say beside it: the venue a bare symbol went to when it has several
   * ("IEO -> BATS (other listings: IEX, BMV)"), and a listing that stopped trading.
   */
  notes: string[];
  /** Of those, the one saying the listing stopped trading; null while it trades. */
  ended: string | null;
  /** How the input was read, when not as typed: a company's name as the listing it names (`listingReadNotes`). */
  readAs: string | null;
  /** The symbol changed (FB became META); when its company left it, the line leads `notes`. */
  change: TickerChange | null;
  /**
   * The company that last held the symbol merged into another (GOGL was
   * Golden Ocean, now CMB.Tech: CMBT); its line leads `notes` when no change does.
   */
  formerIssuer: FormerIssuer | null;
  /**
   * A bare coin ticker (ETH) read as a listing that is not the coin, such as a
   * fund named for it: "ETH is Grayscale Ethereum Mini Trust ETF, not ethereum.
   * For ethereum use ETH-USD." It is also the last of `notes`.
   */
  coinNote: string | null;
  /**
   * The symbol as read when it named no exchange (DFS, not DFS:LSE or DFS
   * --exchange LSE): the listing is the one the lookup chose for it. Null when
   * the input named its listing, or a company's name was read as one.
   */
  bareSymbol: string | null;
}

export interface CliTickerOptions {
  /** The command that takes one listing, for the choices a failure names: `gloom watchlist add Growth 2222:JPX`. */
  retry?: (key: string) => string;
  /** `--exchange` only fills in the symbols that name no exchange of their own, as for a list of symbols. */
  ownExchangeWins?: boolean;
  /** Look up whether the symbol changed (FB became META). True by default. */
  changes?: boolean;
  /**
   * How long the answer waits for that lookup once the listing is found. A
   * command printing one symbol waits a moment and goes on without the note;
   * a list waits for it, since a symbol's company leaving it decides whether
   * the listing is stored.
   */
  changeGraceMs?: number;
  /**
   * Ask a listing already saved for its quote and save the name the quote
   * gives, as `quote` and `portfolio show` name it. True by default.
   */
  refreshName?: boolean;
  /**
   * A bare symbol several listings carry, and no quote settles, fails with the
   * choice instead of going to the first listing that has a quote, for a caller
   * that asks which listing is meant (the command bar's single add does).
   */
  askWhenAmbiguous?: boolean;
}

/**
 * A bare coin ticker several companies list, none of them the coin (SOL): the
 * listings to choose from in `details`, and where the coin is in `hint`, which
 * is also the last line of `details`.
 */
export class CoinListingError extends ListingArgError {
  constructor(message: string, details: string, readonly hint: string) {
    super(message, `${details}\n${hint}`);
    this.name = "CoinListingError";
  }
}

/**
 * A bare symbol several companies list, so it went to none of them: `choices`
 * are the first listings to pick from, of `listingCount`, and `successor` what
 * search says became of the symbol ("NEP became XIFR on 2025-02-03"), often the
 * company meant. `details` has both, each with the command that adds it.
 */
export class ListingChoiceError extends ListingArgError {
  constructor(
    message: string,
    details: string,
    override readonly choices: readonly ListingChoice[],
    readonly listingCount: number,
    readonly successor: string | null,
  ) {
    super(message, details, choices);
    this.name = "ListingChoiceError";
  }
}

/** Search found no listing for the symbol: the message says so, or why (no longer trading, not on that exchange). */
export class TickerNotFoundError extends ListingArgError {
  constructor(
    message: string,
    /** The symbol its company trades as now, when the message says it moved or merged away (PPBI: COLB). */
    readonly successor: string | null = null,
  ) {
    super(message);
    this.name = "TickerNotFoundError";
  }
}

/**
 * `resolveTickerForCli`, saying which listing a bare symbol went to. A bare
 * symbol goes where `quote` reads it: the listing its own quote is on, else,
 * when no quote settles it, the first of its listings with a quote
 * (`quoteBareListing`); a code several companies list asks which. A symbol
 * search no longer lists, whose quote stopped long ago, is no longer trading,
 * and a named exchange the symbol is not on says where it is. Those failures
 * are `ListingArgError`s, with any choices in `details`.
 */
export async function resolveCliTicker(
  symbol: string,
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  exchange?: string,
  options: CliTickerOptions = {},
): Promise<CliTicker> {
  if (!symbol.trim()) {
    throw new Error("Ticker symbol is required.");
  }
  const deps: ListingDeps = { store, dataProvider };
  const listing = await resolveCliListing(symbol, exchange, deps, { ownExchangeWins: options.ownExchangeWins });
  const read = listingReadNotes(listing);
  // Looked up beside the search, so saying FB is now META costs no wait.
  const changes = options.changes === false ? null : startTickerChangeLookup(dataProvider, listing.symbol, listing.exchange);
  const withChange = (resolved: ResolvedListing, current: CurrentListing | null | undefined) =>
    describeResolution(listing, changes, resolved, current, options.changeGraceMs);
  // A listing already saved says, as one search found does, when its quote stopped long ago.
  const withEnded = (named: { ticker: TickerRecord; quote: Quote | null }, notes: string[]): ResolvedListing => {
    const ended = named.quote ? noLongerTradingNote(savedListingName(named.ticker).label, named.quote) : null;
    return { ticker: named.ticker, notes: [...notes, ...ended ? [ended] : []], ended };
  };
  // A saved listing names what lists there; the issuer that left, if it is that one, is its old line.
  if (listing.saved) {
    const saved = options.refreshName === false ? { ticker: listing.saved, quote: null } : await nameFromListingQuote(listing.saved, store, dataProvider, null);
    return withChange(withEnded(saved, read), { name: saved.ticker.metadata.name });
  }

  const localTickers = new Map(
    (await store.loadAllTickers()).map((ticker) => [ticker.metadata.ticker.toUpperCase(), ticker] as const),
  );
  const search = (query: string) => resolveTickerSearch({ query, activeTicker: null, tickers: localTickers, dataProvider });
  let resolved: ResolvedTickerSearch | null;
  let bareNote: string | null = null;
  let bareQuote: Quote | null = null;
  try {
    resolved = await search(listing.key);
  } catch (error) {
    if (!(error instanceof AmbiguousTickerError) || error instanceof AmbiguousContractError || listing.exchange || options.askWhenAmbiguous) throw error;
    // No quote of the bare symbol settles which listing it is: the one `quote` reads instead.
    const bare = await quoteBareListing(listing, deps, { command: "quote", noun: "quote", retry: options.retry ?? null });
    if (!bare) throw error;
    if (bare.kind === "missing") {
      const hint = coinElsewhereNote(listing.symbol, error.listings.map((key) => ({ key, name: error.listingNames[key] ?? "" })));
      if (hint) throw new CoinListingError(bare.message, bare.details, hint);
      if (!bare.choose) throw new ListingArgError(bare.message, bare.details);
      // What search says became of the symbol: a company that moved away (NEP became XIFR) is often the one meant.
      const fate = await loadListingFate(listing, dataProvider, changes ? { changes } : {});
      const successor = listingChangeLine(fate);
      const moved = movedAwayChange(fate.change);
      const successorLine = moved && options.retry ? movedSymbolLine(moved, options.retry(moved.tradesAs)) : successor;
      throw new ListingChoiceError(bare.message, [bare.details, successorLine].filter(Boolean).join("\n"), bare.choices, bare.listings.length, successor);
    }
    resolved = await search(bare.listing.key);
    bareNote = bare.note;
    bareQuote = bare.quote;
  }

  if (!resolved) {
    const message = await missingListingMessage(listing, deps);
    const payload = await changes?.settle(options.changeGraceMs) ?? null;
    const change = describeTickerChange(listing.symbol, payload, null);
    const changeLine = tickerChangeLine(change);
    const formerIssuer = changeLine ? null : describeFormerIssuer(listing.symbol, payload, null);
    const line = changeLine ?? formerIssuer?.note;
    const successor = changeLine ? change?.tradesAs ?? null : formerIssuer?.successor.symbol ?? null;
    throw new TickerNotFoundError(line ? `${message} ${line}.` : message, successor);
  }
  if (resolved.kind === "local") {
    const local = options.refreshName === false ? { ticker: resolved.ticker, quote: null } : await nameFromListingQuote(resolved.ticker, store, dataProvider, bareQuote);
    return withChange(withEnded(local, [...read, ...bareNote ? [bareNote] : []]), { name: local.ticker.metadata.name });
  }

  const { ticker, created } = await upsertTickerFromSearchResult(store, resolved.result);
  const named = created ? await nameFromListingQuote(ticker, store, dataProvider, bareQuote) : { ticker, quote: bareQuote };
  const saved = savedListingName(named.ticker);
  const others = resolved.otherListings?.map((key) => parsePublicTickerKey(key).exchange ?? key) ?? [];
  // Several companies' listings name the company it went to and theirs; one company's name its other venues.
  const venueNote = bareNote ?? (others.length > 0 && saved.exchange
    ? listingChoiceNote(listing.symbol, saved, await listingVenues(listing.symbol, deps).catch(logFailure("cli.ticker-resolution", "Read resolved ticker listing venues failed", [])))
      ?? chosenListingNote(listing.symbol, saved.exchange, others)
    : null);
  const ended = named.quote ? noLongerTradingNote(saved.label, named.quote) : null;
  // Search listed it, so something trades there; its quote says whether that is the issuer that left.
  const current = named.quote ? tradingListing(named.quote) : { name: named.ticker.metadata.name };
  return withChange({
    ticker: named.ticker,
    notes: [...read, venueNote, ended].filter((note): note is string => !!note),
    ended,
  }, current);
}

type ResolvedListing = Omit<CliTicker, "change" | "formerIssuer" | "coinNote" | "readAs" | "bareSymbol">;

/**
 * The resolution with the symbol's change, when it has one, and the coin note
 * for a bare coin ticker on a listing that is not the coin: a company that left
 * the symbol leads the notes, the coin note ends them. A named exchange (ETH:ARCA,
 * --exchange) asked for that listing on purpose and gets no coin note, as in `quote`.
 */
async function describeResolution(
  listing: Pick<CliListing, "symbol" | "exchange" | "readAs">,
  lookup: TickerChangeLookup | null,
  resolved: ResolvedListing,
  current: CurrentListing | null | undefined,
  graceMs?: number,
): Promise<CliTicker> {
  const payload = await lookup?.settle(graceMs) ?? null;
  const change = describeTickerChange(listing.symbol, payload, current);
  const formerIssuer = describeFormerIssuer(listing.symbol, payload, current);
  // One line: a company that left the symbol, else one that merged away from it.
  const line = tickerChangeLine(change) ?? formerIssuer?.note;
  const coinNote = listing.exchange ? null : savedListingCoinNote(listing.symbol, resolved.ticker);
  return { ...resolved, notes: [...line ? [line] : [], ...resolved.notes, ...coinNote ? [coinNote] : []], change, formerIssuer, coinNote,
    readAs: listing.readAs ?? null, bareSymbol: listing.exchange ? null : listing.symbol };
}

/**
 * Why search found no listing: a named exchange the symbol is not on names
 * the ones it is; a symbol search no longer lists, whose quote stopped long
 * ago, is no longer trading (TWTR).
 */
async function missingListingMessage(listing: CliListing, deps: ListingDeps): Promise<string> {
  const notTraded = await notTradedMessage(listing, deps);
  if (notTraded) return notTraded;
  const quote = await deps.dataProvider.getQuote(listing.request.symbol, listing.request.exchange).catch(logFailure("cli.ticker-resolution", "Read missing listing quote failed", null));
  const ended = quote ? noLongerTradingNote(listing.key, quote) : null;
  return ended ? `${ended}.` : `No ticker match found for "${listing.key}".`;
}

/**
 * Search catalogues can file a listing under another company's name, such as
 * BAE Systems' London line (BA:LSE) under Boeing. The listing's own
 * quote names the security it prices, which is the name the ticker command
 * shows, so a record created here takes it. The quote comes back with it,
 * when it is that listing's.
 */
async function nameFromListingQuote(
  ticker: TickerRecord,
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  known: Quote | null,
): Promise<{ ticker: TickerRecord; quote: Quote | null }> {
  const { metadata } = ticker;
  try {
    const quote = known ?? await dataProvider.getQuote(metadata.ticker, metadata.exchange);
    const name = quote.name?.trim();
    // A quote that names no listing may be another venue's line served from cache.
    const quoteExchange = canonicalExchange(quote.listingExchangeName || quote.exchangeName);
    if (!quoteExchange || quoteExchange !== canonicalExchange(metadata.exchange)) return { ticker, quote: null };
    if (!name || name === metadata.name) return { ticker, quote };
    const named: TickerRecord = { ...ticker, metadata: { ...metadata, name } };
    await store.saveTicker(named);
    return { ticker: named, quote };
  } catch {
    // Without a quote the catalogue name stands.
    return { ticker, quote: null };
  }
}

export type CliTickerResolution =
  | ({ input: string; error?: undefined } & CliTicker)
  | { input: string; ticker?: undefined; error: Error };

/** Symbols looked up at once. Each is a catalogue search and a quote, so this bounds the requests in flight. */
const RESOLVE_CONCURRENCY = 8;
/**
 * Symbols looked up at once whose searches a batch already answered: each asks
 * only for a quote, gathered with the others' into batch requests of a hundred.
 */
const ANSWERED_CONCURRENCY = 100;
/** Symbols looked up again at once after requests failed, gently, as the service may be limiting the rate. */
const RETRY_CONCURRENCY = 4;
/** The data service's market requests (search, quotes), as connection health names them. */
const MARKET_OPERATION = /^(?:GET|POST) \/market\//;
/**
 * Waits before each new look at the symbols that failed while requests were
 * failing. The first outlasts the five seconds the router keeps an empty
 * search answer; the service's rate limit is a minute's window.
 */
const RETRY_WAITS_MS = [6_000, 15_000, 30_000];

/**
 * Counts the data service's market requests that fail while it watches. A
 * lookup fails as busy while search refuses it (rate limited), reads a search
 * it cannot reach (offline) as no match, and a refused quote as a listing it
 * cannot settle, so a symbol looked up while one failed may be there after all.
 */
function watchFailedRequests(): { count: () => number; stop: () => void } {
  const dispose = connectionHealth.hasSource(GLOOM_CLOUD_HTTP_CONNECTION_ID)
    ? null
    : connectionHealth.registerSource({ id: GLOOM_CLOUD_HTTP_CONNECTION_ID, name: "Gloom Cloud HTTP", kind: "api" });
  const failures = new Set<string>();
  const unsubscribe = connectionHealth.subscribe(() => {
    const failure = connectionHealth.getSnapshot().sources.find((source) => source.id === GLOOM_CLOUD_HTTP_CONNECTION_ID)?.lastError;
    if (failure && MARKET_OPERATION.test(failure.operation)) failures.add(`${failure.at}|${failure.latencyMs}|${failure.error ?? ""}`);
  });
  return { count: () => failures.size, stop: () => { unsubscribe(); dispose?.(); } };
}

function lookUpTickers(
  symbols: readonly string[],
  concurrency: number,
  resolve: (symbol: string) => Promise<CliTicker>,
): Promise<CliTickerResolution[]> {
  return mapWithConcurrency(symbols, concurrency, async (input): Promise<CliTickerResolution> => {
    try {
      return { input, ...await resolve(input) };
    } catch (error) {
      return { input, error: error instanceof Error ? error : new Error(String(error)) };
    }
  });
}

/**
 * What a symbol of a list asks the sources for, so the whole list's searches
 * and change lookups go out in batches first: a bare symbol searches its
 * spellings (`providerSearchQueries`); one with a venue, or read another way,
 * is searched as it always is.
 */
function listLookupPlan(input: string, exchange: string | undefined): ListLookupPlan {
  try {
    const listing = parseListingArg(input, exchange, { ownExchangeWins: true });
    const searchable = !listing.exchange && /^[A-Z0-9][A-Z0-9.-]{0,11}$/.test(listing.symbol);
    return {
      searches: searchable ? providerSearchQueries(listing.symbol) : [],
      changes: tickerChangeSymbol(listing.symbol, listing.exchange),
    };
  } catch {
    // Intentional ignore: an input that is not a listing fails its own lookup, which says why.
    return { searches: [], changes: null };
  }
}

/**
 * `resolveCliTicker` for a list of symbols, several at a time; a symbol that
 * fails gives its error without failing the rest. `--exchange` names the
 * venue of the symbols that do not name their own. Every symbol's change is
 * looked up and waited for, the searches and changes of the whole list in a
 * few batched requests first (`batchedListLookups`). "Not found" means search
 * found no listing: while the service refuses requests, the symbols that
 * failed are looked up again after a pause, and any it still did not answer
 * for say so.
 */
export async function resolveTickersForCli(
  symbols: readonly string[],
  store: AppTickerRepositoryPort,
  dataProvider: DataProvider,
  exchange?: string,
  {
    retry,
    askWhenAmbiguous,
    onRetry,
    retryWaitsMs = RETRY_WAITS_MS,
  }: Pick<CliTickerOptions, "retry" | "askWhenAmbiguous"> & {
    /** Told before each new look, with how many symbols and how long it waits first. */
    onRetry?: (count: number, waitMs: number) => void;
    retryWaitsMs?: readonly number[];
  } = {},
): Promise<CliTickerResolution[]> {
  const plans = new Map(symbols.map((input) => [input, listLookupPlan(input, exchange)] as const));
  // Each look asks for its symbols' searches and changes in batches first.
  const look = async (inputs: readonly string[], concurrency: number): Promise<Map<string, CliTickerResolution>> => {
    const batched = await batchedListLookups(dataProvider, inputs.map((input) => plans.get(input)!));
    const resolve = (symbol: string) => resolveCliTicker(symbol, store, batched.dataProvider, exchange, {
      retry, askWhenAmbiguous, ownExchangeWins: true, changeGraceMs: LOOKUP_TIMEOUT_MS,
    });
    // Symbols whose searches were answered ask only for quotes, which go out together; the rest ask as before.
    const answered = (input: string) => batched.answered(plans.get(input)!);
    return new Map((await Promise.all([
      lookUpTickers(inputs.filter(answered), ANSWERED_CONCURRENCY, resolve),
      lookUpTickers(inputs.filter((input) => !answered(input)), concurrency, resolve),
    ])).flat().map((entry) => [entry.input, entry] as const));
  };
  const failedRequests = watchFailedRequests();
  try {
    const looked = await look(symbols, RESOLVE_CONCURRENCY);
    let lookups = symbols.map((input) => looked.get(input)!);
    let failing = failedRequests.count() > 0;
    for (const waitMs of retryWaitsMs) {
      const failed = lookups.filter((entry) => entry.error).map((entry) => entry.input);
      if (!failing || failed.length === 0) break;
      onRetry?.(failed.length, waitMs);
      await new Promise((resolveWait) => setTimeout(resolveWait, waitMs));
      const before = failedRequests.count();
      const again = await look(failed, RETRY_CONCURRENCY);
      lookups = lookups.map((entry) => again.get(entry.input) ?? entry);
      failing = failedRequests.count() > before;
    }
    if (!failing) return lookups;
    // Still refused after the last wait: a failure may only be the refusal, so none is called not found.
    return lookups.map((entry) => entry.error
      ? { input: entry.input, error: new Error(`Could not look up ${entry.input}: Gloom Cloud did not answer. Try again in a minute.`) }
      : entry);
  } finally {
    failedRequests.stop();
  }
}
