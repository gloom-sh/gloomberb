import type { DataProvider, MarketDataRequestContext, QuoteBatchResult, SearchRequestContext } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { InstrumentSearchResult } from "../types/instrument";
import { logFailure } from "../utils/log-failure";
import { chunked } from "../utils/concurrency";
import { createProviderMiss, isNoProviderMessage, isNoSourceAnswer, isProviderBusy, notATickerSymbol } from "../sources/provider-errors";
import { ApiRequestError } from "../api-client/errors";

/** The service refusing a request for the caller's rate (429). */
const isRateRefusal = (error: unknown) => error instanceof ApiRequestError && error.status === 429;
import { LISTING_SEARCH_LIMIT } from "./search";
import { PERPETUAL_TYPE } from "./perpetual-listing";

/**
 * The searches a list asks for in batches are asked at the listing picker's
 * size, whose rows are also the first rows of a plain search.
 */
const BATCHED_SEARCH_LIMIT = LISTING_SEARCH_LIMIT;
/** A plain search's size when its caller names none, as the sources read it. */
const DEFAULT_SEARCH_LIMIT = 10;
/** How long quote requests gather before they go out as one batch. */
const QUOTE_GATHER_MS = 10;
/** Quotes in one batch request, the most a signed-out batch may ask for. */
const QUOTE_BATCH_SIZE = 100;
/** Queries in one batched search request, as the service runs them. */
const SEARCH_BATCH_SIZE = 100;
/** Symbols in one batched ticker change request, as the service reads them. */
const TICKER_CHANGES_BATCH_SIZE = 500;
/** Symbols of a batched ticker change lookup that cost a signed-out caller one unit. */
const TICKER_CHANGES_PER_UNIT = 100;

/** What one symbol of a list asks the sources for: its searches and its ticker change lookup. */
export interface ListLookupPlan {
  /** The searches its lookup runs (`providerSearchQueries`); none for a symbol looked up some other way. */
  searches: string[];
  /** The symbol its change lookup asks for (`tickerChangeSymbol`), or null for one with none. */
  changes: string | null;
  /**
   * A bare symbol whose own quote its lookup reads first (`listingOfOwnQuote`), asked before any search, as
   * `quote` asks it: what search lists can steer a later quote of the bare symbol to that listing.
   */
  quote?: string | null;
}

export interface BatchedLookups {
  /** The provider the lookups read through. */
  dataProvider: DataProvider;
  /** Whether a symbol's searches were all answered in a batch, so its lookup asks the sources for quotes alone. */
  answered(plan: ListLookupPlan): boolean;
}

const searchKey = (query: string) => query.trim().toUpperCase();

/**
 * The data provider a list of symbols is looked up through: the searches and
 * ticker changes every symbol's lookup will ask for go out first as a few
 * batched requests, and the quotes the lookups then ask for are gathered into
 * batch requests, so a pasted list of hundreds of symbols is a handful of
 * requests rather than several per symbol. Everything else, and anything a
 * batch left unanswered (a service without batches, a query it could not
 * search, a listing a batch has no quote for), is asked as before, one at a
 * time, so each lookup reads what it would have read alone.
 */
export async function batchedListLookups(
  dataProvider: DataProvider,
  plans: readonly ListLookupPlan[],
): Promise<BatchedLookups> {
  // Symbols that are all saved already are looked up with no source at all.
  if (!dataProvider) return { dataProvider, answered: () => false };
  const queries = [...new Set(plans.flatMap((plan) => plan.searches.map(searchKey)))];
  const changeSymbols = [...new Set(plans.flatMap((plan) => plan.changes ? [plan.changes] : []))];
  // The changes first: a request or so for the whole list, which the searches,
  // a unit of a signed-out caller's allowance each, cannot then crowd out.
  // A batch that fails leaves every symbol to be looked up on its own, as before.
  const changes = changeSymbols.length && dataProvider.getTickerChangesBatch
    ? await dataProvider.getTickerChangesBatch(changeSymbols).catch(logFailure("tickers.batched-lookups", "Batched ticker changes failed", null))
    : null;
  const quotes = dataProvider.getQuotesBatch ? new QuoteGatherer(dataProvider) : null;
  const bare = [...new Set(plans.flatMap((plan) => plan.quote ? [plan.quote.toUpperCase()] : []))];
  if (quotes && bare.length) await Promise.allSettled(bare.map((symbol) => quotes.get(symbol, "")));
  const searches = queries.length && dataProvider.searchBatch
    ? await dataProvider.searchBatch(queries, { limit: BATCHED_SEARCH_LIMIT }).catch(logFailure("tickers.batched-lookups", "Batched search failed", null))
    : null;
  if (!searches?.size && !changes?.size && !quotes) return { dataProvider, answered: () => false };

  // An empty answer is asked again on its own, so a fallback source still gets its turn.
  const searched = (query: string) => (searches?.get(searchKey(query))?.length ?? 0) > 0;
  const overrides: Partial<DataProvider> = {
    search: async (query: string, context?: SearchRequestContext): Promise<InstrumentSearchResult[]> => {
      const limit = context?.limit ?? DEFAULT_SEARCH_LIMIT;
      const plain = !context?.brokerId && !context?.brokerInstanceId && context?.preferBroker !== false;
      const rows = plain && limit <= BATCHED_SEARCH_LIMIT ? searches?.get(searchKey(query)) : undefined;
      return rows?.length ? firstRows(rows, limit) : dataProvider.search(query, context);
    },
  };
  if (changes?.size && dataProvider.getTickerChanges) {
    overrides.getTickerChanges = async (symbol, options) => {
      const key = symbol.trim().toUpperCase();
      return changes.has(key) ? changes.get(key) ?? null : dataProvider.getTickerChanges!(symbol, options);
    };
  }
  if (quotes) {
    overrides.getQuote = (ticker, exchange, context) => plainContext(context)
      ? quotes.get(ticker, exchange ?? "")
      : dataProvider.getQuote(ticker, exchange, context);
  }
  return {
    dataProvider: withOverrides(dataProvider, overrides),
    answered: (plan) => plan.searches.length > 0 && plan.searches.every(searched),
  };
}

/**
 * A batched answer cut to a search's size: its first `limit` listings, after
 * the perpetual markets that lead it, which a search adds beyond its size.
 */
function firstRows(rows: readonly InstrumentSearchResult[], limit: number): InstrumentSearchResult[] {
  return [...rows.filter((row) => row.type === PERPETUAL_TYPE), ...rows.filter((row) => row.type !== PERPETUAL_TYPE).slice(0, limit)];
}

/** A quote request that names no broker, contract or refresh (`{ brokerId: undefined }` included), which a batch answers alike. */
function plainContext(context: MarketDataRequestContext | undefined): boolean {
  return !context || Object.entries(context).every(([key, value]) => value == null || (key === "cacheMode" && value === "default"));
}

/** `provider` with some of its methods answered by `overrides`, every other one its own. */
function withOverrides(provider: DataProvider, overrides: Partial<DataProvider>): DataProvider {
  return new Proxy(provider, {
    get(target, key, receiver) {
      if (Object.hasOwn(overrides, key)) return overrides[key as keyof DataProvider];
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** A listing as one key, however it was asked: a row saved under its venue's key (ALRS:NASDAQ on NASDAQ) is ALRS there. */
const listingKey = (symbol: string, exchange: string | undefined) => {
  const venue = (exchange ?? "").toUpperCase();
  const code = symbol.toUpperCase();
  return `${venue && code.endsWith(`:${venue}`) ? code.slice(0, -venue.length - 1) : code}|${venue}`;
};

interface PendingQuote {
  ticker: string;
  exchange: string;
  resolve(quote: Quote): void;
  reject(error: unknown): void;
}

/**
 * Quotes asked for one at a time, sent as batch requests: the asks of a few
 * milliseconds go out together. The batch asks a listing it has no quote for
 * on its own, so the answer, or the error saying why there is none, is the
 * one `getQuote` gives. Each listing is asked once.
 */
class QuoteGatherer {
  private readonly answers = new Map<string, Promise<Quote>>();
  private pending: PendingQuote[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly dataProvider: DataProvider) {}

  get(ticker: string, exchange: string): Promise<Quote> {
    const key = listingKey(ticker, exchange);
    const known = this.answers.get(key);
    if (known) return known;
    const answer = new Promise<Quote>((resolve, reject) => {
      this.pending.push({ ticker, exchange, resolve, reject });
    });
    this.answers.set(key, answer);
    if (this.pending.length >= QUOTE_BATCH_SIZE) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), QUOTE_GATHER_MS);
    return answer;
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.pending.splice(0, QUOTE_BATCH_SIZE);
    if (this.pending.length > 0) this.timer = setTimeout(() => this.flush(), 0);
    if (batch.length === 0) return;
    void this.send(batch);
  }

  private async send(batch: PendingQuote[]): Promise<void> {
    const targets = batch.map(({ ticker, exchange }) => ({ symbol: ticker, ...exchange ? { exchange } : {} }));
    let refused: unknown = null;
    const results: QuoteBatchResult[] = await this.dataProvider.getQuotesBatch!(targets).catch((error: unknown) => {
      // A refused batch is not asked again one listing at a time: each would be refused too, and spend the allowance.
      if (isProviderBusy(error) || isRateRefusal(error)) refused = error;
      else logFailure("tickers.batched-lookups", "Batched quotes failed")(error);
      return [] as QuoteBatchResult[];
    });
    if (refused) {
      for (const ask of batch) ask.reject(refused);
      return;
    }
    // Each answer by the listing it names, never by its place: a source may answer in another order or leave some out.
    const byListing = new Map(results.map((entry) => [listingKey(entry.target.symbol, entry.target.exchange), entry] as const));
    await Promise.all(batch.map(async (ask, index) => {
      const result = results.find((entry) => entry.target === targets[index]) ?? byListing.get(listingKey(ask.ticker, ask.exchange));
      if (result?.quote) {
        ask.resolve(result.quote);
        return;
      }
      // Asked on its own already, and refused or not found: asking again would only be refused again. A batch
      // says both in one message ("No quote provider available for ZION"), which asked alone is told apart.
      if (result?.error && !(typeof result.error === "string" && isNoProviderMessage(result.error))) {
        ask.reject(result.error);
        return;
      }
      try {
        ask.resolve(await this.dataProvider.getQuote(ask.ticker, ask.exchange));
      } catch (error) {
        ask.reject(error);
      }
    }));
  }
}

/**
 * A signed-out caller's allowances of market requests, as the service counts
 * them over a sliding minute. `shared`: a unit per search, per quote (each
 * listing of a batch) and per ticker change lookup, which every read draws
 * on. `listLookups`: a unit per query of a batched search and per hundred
 * symbols of a batched ticker change lookup, a pasted list's own. A little of
 * each is left for the requests a lookup makes beside these (a profile).
 */
const SIGNED_OUT_ALLOWANCE = {
  shared: { units: 280, windowMs: 60_000 },
  listLookups: { units: 280, windowMs: 60_000 },
} as const;

/** The allowances a list's lookups keep to (`SIGNED_OUT_ALLOWANCE`). */
export interface ListAllowances {
  shared: RequestAllowance;
  listLookups: RequestAllowance;
}

/** Fresh allowances of a signed-out caller, for one command. */
export function signedOutAllowances(): ListAllowances {
  const { shared, listLookups } = SIGNED_OUT_ALLOWANCE;
  return {
    shared: new RequestAllowance(shared.units, shared.windowMs),
    listLookups: new RequestAllowance(listLookups.units, listLookups.windowMs),
  };
}
/** Past a window's end a unit is still counted by the service until its request arrives; this covers the trip. */
const ALLOWANCE_MARGIN_MS = 1_000;

/**
 * A lookup by key whose asks of a few milliseconds go out together through
 * `send`, `size` keys a request: each ask resolves with its key's answer, or
 * undefined when the batch left it out or failed, for the caller to ask alone.
 */
function gathered<T>(send: (keys: string[]) => Promise<Map<string, T> | null>, size: number): (key: string) => Promise<T | undefined> {
  let pending: Array<{ key: string; resolve(value: T | undefined): void }> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const batch = pending;
    pending = [];
    for (const chunk of chunked(batch, size)) {
      void send([...new Set(chunk.map((ask) => ask.key))]).then(
        (answers) => { for (const ask of chunk) ask.resolve(answers?.has(ask.key) ? answers.get(ask.key) : undefined); },
        () => { for (const ask of chunk) ask.resolve(undefined); },
      );
    }
  };
  return (key) => new Promise<T | undefined>((resolve) => {
    pending.push({ key, resolve });
    timer ??= setTimeout(flush, QUOTE_GATHER_MS);
  });
}

/** Waits `ms`, or less when `signal` aborts first: no timer is left behind to hold the process open. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Spends a sliding window's allowance in the order asked: a request waits
 * until its cost fits rather than being sent to be refused. A cost above the
 * whole allowance waits for an empty window. A take whose `signal` aborts
 * stops waiting at once, spends nothing and rejects with the signal's reason,
 * so its request is never sent; the takes behind it keep their turn.
 */
export class RequestAllowance {
  private spent: Array<{ at: number; cost: number }> = [];
  private turn: Promise<void> = Promise.resolve();

  constructor(
    private readonly units: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = sleepUnlessAborted,
  ) {}

  take(cost: number, signal?: AbortSignal): Promise<void> {
    const wanted = Math.min(Math.max(1, cost), this.units);
    const next = this.turn.then(async () => {
      for (;;) {
        signal?.throwIfAborted();
        const now = this.now();
        this.spent = this.spent.filter((hit) => hit.at + this.windowMs + ALLOWANCE_MARGIN_MS > now);
        let excess = this.spent.reduce((total, hit) => total + hit.cost, wanted) - this.units;
        if (excess <= 0) {
          this.spent.push({ at: now, cost: wanted });
          return;
        }
        // Until enough of the oldest spends leave the window.
        let until = now;
        for (const hit of this.spent) {
          excess -= hit.cost;
          until = hit.at + this.windowMs + ALLOWANCE_MARGIN_MS;
          if (excess <= 0) break;
        }
        await this.sleep(Math.max(1, until - now), signal);
      }
    });
    this.turn = next.catch(() => {
      // Intentional ignore: the take's own caller gets its rejection; the takes behind it only wait their turn.
    });
    return next;
  }
}

/** A listing's quote answered with none, as `listLookups` keeps it beside the errors that said so. */
const NO_QUOTE = Symbol("no quote");

/**
 * The data provider one command's lookups of a list read through, each
 * answer kept for the command: what reading the list's names asked (their
 * searches and quotes) is not asked again when its symbols are looked up, and
 * a batch asks only what is not known yet. Only answers are kept: a refusal or
 * a failure is asked again. With `allowances` (a signed-out caller's), each
 * search, quote and ticker change request waits for its cost to fit them, so
 * a pasted list of hundreds of names is never refused for its rate.
 */
export function listLookups(dataProvider: DataProvider, { allowances = null }: { allowances?: ListAllowances | null } = {}): DataProvider {
  // A command with every symbol saved already looks them up with no source at all.
  if (!dataProvider) return dataProvider;
  const searches = new Map<string, { limit: number; rows: InstrumentSearchResult[] }>();
  const quotes = new Map<string, Quote>();
  const paced = async <T>(cost: number, ask: () => Promise<T>, allowance: "shared" | "listLookups" = "shared", signal?: AbortSignal): Promise<T> => {
    await allowances?.[allowance].take(cost, signal);
    return ask();
  };
  const known = (query: string, limit: number) => {
    const entry = searches.get(searchKey(query));
    return entry && entry.limit >= limit ? entry.rows : null;
  };
  const keep = (query: string, limit: number, rows: InstrumentSearchResult[]) => {
    if (rows.length > 0) searches.set(searchKey(query), { limit, rows });
  };
  // Searches and ticker change lookups asked one at a time within a few milliseconds go out as one batch.
  const searchBatch = dataProvider.searchBatch ? (queries: string[]) => overrides.searchBatch!(queries, { limit: BATCHED_SEARCH_LIMIT }) : null;
  const gatheredSearch = searchBatch ? gathered(searchBatch, SEARCH_BATCH_SIZE) : null;
  const gatheredChanges = dataProvider.getTickerChangesBatch
    ? gathered((symbols) => overrides.getTickerChangesBatch!(symbols), TICKER_CHANGES_BATCH_SIZE)
    : null;
  const overrides: Partial<DataProvider> = {
    search: async (query, context) => {
      const limit = context?.limit ?? DEFAULT_SEARCH_LIMIT;
      const plain = !context?.brokerId && !context?.brokerInstanceId && context?.preferBroker !== false;
      const rows = plain ? known(query, limit) : null;
      if (rows) return firstRows(rows, limit);
      // An empty answer is asked again on its own, so a fallback source still gets its turn.
      const batched = plain && limit <= BATCHED_SEARCH_LIMIT ? await gatheredSearch?.(query) : undefined;
      if (batched?.length) return firstRows(batched, limit);
      const found = await paced(1, () => dataProvider.search(query, context));
      if (plain) keep(query, limit, found);
      return found;
    },
  };
  if (dataProvider.searchBatch) {
    overrides.searchBatch = async (queries, options) => {
      const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT;
      const asked = [...new Set(queries.map(searchKey))].filter((query) => !known(query, limit));
      // A request per hundred queries, each spending its own share, so the first answers while the rest wait.
      // One that fails (refused for the rate) settles the batch: the chunks still waiting their turn are dropped,
      // never sent later for an answer nobody reads, nor left waiting to hold the command open.
      const failed = new AbortController();
      const answered = await Promise.all(chunked(asked, SEARCH_BATCH_SIZE).map((chunk) =>
        paced(chunk.length, () => dataProvider.searchBatch!(chunk, options), "listLookups", failed.signal)
          .catch((error: unknown) => {
            failed.abort(error);
            throw error;
          })));
      if (asked.length > 0 && answered.every((answer) => !answer)) return null;
      for (const answer of answered) for (const [query, rows] of answer ?? []) keep(query, limit, rows);
      const rowsOf = (query: string) => known(query, limit)
        ?? answered.find((answer) => answer?.has(searchKey(query)))?.get(searchKey(query)) ?? [];
      return new Map(queries.map((query) => [query, firstRows(rowsOf(query), limit)]));
    };
  }
  // A listing no source has a quote for (a source's miss, "Not a ticker"), as answered: asked again it is refused again,
  // so the command's later reads get the same answer without a request. A refusal or a failure is still asked again.
  const missing = new Map<string, unknown>();
  overrides.getQuote = async (ticker, exchange, context) => {
    if (!plainContext(context)) return paced(1, () => dataProvider.getQuote(ticker, exchange, context));
    const key = listingKey(ticker, exchange);
    if (missing.has(key)) {
      const miss = missing.get(key);
      if (miss === NO_QUOTE) return null as unknown as Quote;
      throw miss;
    }
    let quote = quotes.get(key);
    if (!quote) {
      try {
        quote = await paced(1, () => dataProvider.getQuote(ticker, exchange, context));
      } catch (error) {
        if (isNoSourceAnswer(error)) missing.set(key, error);
        throw error;
      }
      // Answered with no quote at all: the same answer next time.
      if (!quote) missing.set(key, NO_QUOTE);
    }
    if (quote) quotes.set(key, quote);
    return quote;
  };
  if (dataProvider.getQuotesBatch) {
    overrides.getQuotesBatch = async (targets, options) => {
      // A batch asked with options of its own (a refresh, deferred follow-ups) is asked as it is.
      if (options && Object.values(options).some((value) => value != null)) return paced(targets.length, () => dataProvider.getQuotesBatch!(targets, options));
      const asked = targets.filter((target) => !quotes.has(listingKey(target.symbol, target.exchange)) && !missing.has(listingKey(target.symbol, target.exchange)));
      const answers = asked.length ? await paced(asked.length, () => dataProvider.getQuotesBatch!(asked)) : [];
      for (const answer of answers) {
        const key = listingKey(answer.target.symbol, answer.target.exchange);
        if (answer.quote) quotes.set(key, answer.quote);
        // The source asked it alone already and none has it: later reads get that answer, not another request.
        else if (answer.error instanceof Error && isNoSourceAnswer(answer.error)) missing.set(key, answer.error);
        // "Not a ticker: MURATA.", the service's own answer that it lists nothing as the symbol.
        else if (typeof answer.error === "string" && notATickerSymbol(answer.error)) missing.set(key, createProviderMiss(answer.error, undefined, { notFound: true }));
        else if (answer.error == null && !answer.followUp) missing.set(key, NO_QUOTE);
      }
      const byTarget = new Map(answers.map((answer) => [answer.target, answer] as const));
      return targets.map((target) => {
        const answer = byTarget.get(target);
        if (answer) return answer;
        const quote = quotes.get(listingKey(target.symbol, target.exchange));
        // A listing already answered with no quote gets that answer; a source that left a target out answers nothing for it.
        const miss = missing.get(listingKey(target.symbol, target.exchange));
        return quote ? { target, quote } : miss && miss !== NO_QUOTE ? { target, quote: null, error: miss } : { target, quote: null };
      });
    };
  }
  if (dataProvider.getTickerChanges) {
    overrides.getTickerChanges = async (symbol, options) => {
      // A lookup given up on (its signal) leaves the batch's answer unread.
      const batched = await gatheredChanges?.(symbol.trim().toUpperCase());
      return batched !== undefined ? batched : paced(1, () => dataProvider.getTickerChanges!(symbol, options), "shared", options?.signal);
    };
  }
  if (dataProvider.getTickerChangesBatch) {
    overrides.getTickerChangesBatch = (symbols, options) =>
      paced(Math.ceil(new Set(symbols.map(searchKey)).size / TICKER_CHANGES_PER_UNIT), () => dataProvider.getTickerChangesBatch!(symbols, options), "listLookups", options?.signal);
  }
  return withOverrides(dataProvider, overrides);
}
