import { logFailure } from "../../../../utils/log-failure";
import { getSharedRegistry } from "../../../registry";
import {
  AmbiguousContractError,
  AmbiguousTickerError,
  resolveTickerSearch,
  type ResolvedTickerSearch,
} from "../../../../tickers/search";
import type { Quote } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { canonicalExchange, parsePublicTickerKey, publicTickerKey } from "../../../../utils/exchanges";
import { isProviderBusy } from "../../../../sources/provider-errors";
import { splitSymbolArgs } from "../../../../cli/symbol-args";
import { readNameEntryGroups } from "../../../../cli/name-entries";
import { mapWithConcurrency } from "../../../../utils/concurrency";
import {
  describeFormerIssuer,
  describeTickerChange,
  isUsSymbolVenue,
  quotedListing,
  startTickerChangeLookup,
  tickerChangeLine,
  type FormerIssuer,
  type TickerChange,
} from "../../../../tickers/ticker-changes";

const QUICK_ADD_MAX_QUERY_LENGTH = 32;
/**
 * The listing syntax `quote` and `watchlist add` take: a slash writes a pair
 * as crypto exchanges and FX desks do (BTC/GBP, EUR/USD), `=X` and `=F` a
 * pair's and a future's listing (EURUSD=X, CL=F), `^` an index (^GSPC), a
 * colon the venue (SAN:EPA), and `&` is in some symbols (M&M.NS).
 */
const QUICK_ADD_SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.\-/=^:&\s]*$/;
/** What a refusal says the row takes. */
export const QUICK_ADD_REFUSAL = "Type a ticker (AAPL, EURUSD=X, ^GSPC) or a list";
/** The separators a pasted list carries; a typed line of symbols has spaces. */
const QUICK_ADD_LIST_SEPARATOR = /[,;\t\r\n]/;
/** Entries of a pasted list looked up at once. */
const QUICK_ADD_LIST_LOOKUPS = 4;
/** The most entries one paste adds; the rest are left out, and the row says so. */
export const QUICK_ADD_LIST_MAX = 50;

export type QuickAddCollectionKind = "portfolio" | "watchlist";

interface ResolvedQuickAdd {
  query: string;
  symbol: string;
  resolved: ResolvedTickerSearch;
  ticker: TickerRecord | null;
  quote: Quote | null;
  /** The symbol changed (FB became META), as `watchlist add` says it. */
  change: TickerChange | null;
  /** The company that last held the symbol merged into another (GOGL, now CMB.Tech's CMBT), as `watchlist add` says it. */
  formerIssuer?: FormerIssuer | null;
}

export type QuickAddValidation =
  | { status: "idle"; query: "" }
  | { status: "checking"; query: string }
  | (ResolvedQuickAdd & { status: "ready" })
  | (ResolvedQuickAdd & { status: "duplicate" })
  /** The symbol names several listings and none is the default: the add row asks which. */
  | { status: "choose"; query: string }
  | { status: "missing"; query: string; message: string }
  | { status: "error"; query: string; message: string }
  /**
   * A pasted list (`usd/jpy, EUR/JPY, gbp-chf`): each entry checked as one typed
   * alone, one per symbol. `total` is how many the paste held when it held more
   * than `QUICK_ADD_LIST_MAX`, the entries being its first.
   */
  | { status: "list"; query: string; entries: QuickAddEntryValidation[]; total?: number };

/** One entry of a pasted list: what was typed and how it checked. */
export type QuickAddEntryValidation = Exclude<QuickAddValidation, { status: "idle" | "checking" | "list" }>;

export const IDLE_VALIDATION: QuickAddValidation = { status: "idle", query: "" };

export function normalizeQuickAddQuery(value: string): string {
  return value.replace(/^\s*\$/, "").trim().toUpperCase().replace(/\s+/g, " ");
}

/**
 * Whether what was typed may be several symbols: a pasted list's separators,
 * or words with spaces between them, which `watchlist add` reads as a
 * company's name or as the symbols it holds.
 */
export function mayBeQuickAddList(value: string): boolean {
  return QUICK_ADD_LIST_SEPARATOR.test(value) || /\S\s+\S/.test(value.trim());
}

/**
 * What a list's entries read and checked as while the row is edited, so a
 * keystroke looks up only the entry it changed, not the whole list again.
 * The row starts a new one when it is cleared.
 */
export interface QuickAddListMemo {
  /** An entry as typed (`Apple Inc`) and what it reads as. */
  read: Map<string, string[]>;
  /** An entry as the row normalizes it and how it checked; a lookup that failed is asked again. */
  checked: Map<string, QuickAddEntryValidation>;
}

export function createQuickAddListMemo(): QuickAddListMemo {
  return { read: new Map(), checked: new Map() };
}

/**
 * The entries of what was typed or pasted, read as `watchlist add` reads its
 * argument (`splitSymbolArgs`, `readNameEntries`), in the case they were
 * typed: split by commas, semicolons, tabs and lines, an entry with spaces a
 * company's name when search finds one (Apple Inc, philip morris intl) or
 * else the symbols it holds (EURUSD=X USDJPY=X), and a terminal's code (VOD
 * LN) one entry. Each comes back as the row normalizes a query, the first
 * `QUICK_ADD_LIST_MAX` of them; `total` counts what the paste held.
 */
export async function readQuickAddEntries(
  value: string,
  memo: QuickAddListMemo = createQuickAddListMemo(),
): Promise<{ entries: string[]; total: number }> {
  const split = splitSymbolArgs([value], { phrases: true });
  const kept = split.slice(0, QUICK_ADD_LIST_MAX);
  const unread = [...new Set(kept.filter((entry) => !memo.read.has(entry)))];
  if (unread.length > 0) {
    const marketData = getSharedRegistry()?.marketData;
    const groups = marketData ? await readNameEntryGroups(unread, marketData) : unread.map((entry) => [entry]);
    unread.forEach((entry, index) => memo.read.set(entry, groups[index] ?? [entry]));
  }
  const read = [...new Set(kept.flatMap((entry) => memo.read.get(entry) ?? [entry]).map(normalizeQuickAddQuery).filter(Boolean))];
  return { entries: read.slice(0, QUICK_ADD_LIST_MAX), total: Math.max(split.length, read.length) };
}

export function isPlausibleTickerQuery(query: string): boolean {
  return query.length > 0
    && query.length <= QUICK_ADD_MAX_QUERY_LENGTH
    && QUICK_ADD_SYMBOL_RE.test(query);
}

function tickerBelongsToCollection(
  ticker: TickerRecord | null,
  collectionKind: QuickAddCollectionKind,
  collectionId: string,
): boolean {
  if (!ticker) return false;
  return collectionKind === "portfolio"
    ? ticker.metadata.portfolios.includes(collectionId)
    : ticker.metadata.watchlists.includes(collectionId);
}

function quoteContextFromResolved(resolved: ResolvedTickerSearch) {
  const instrument = resolved.kind === "provider"
    ? resolved.result.brokerContract
    : resolved.ticker.metadata.broker_contracts?.[0];
  return instrument
    ? {
        brokerId: instrument.brokerId,
        brokerInstanceId: instrument.brokerInstanceId,
        instrument,
      }
    : undefined;
}

function exchangeFromResolved(resolved: ResolvedTickerSearch): string | undefined {
  return resolved.kind === "provider"
    ? resolved.result.exchange
    : resolved.ticker.metadata.exchange;
}

export function tickerNameFromValidation(
  validation: Extract<QuickAddValidation, { status: "ready" | "duplicate" }>,
): string {
  if (validation.ticker?.metadata.name) return validation.ticker.metadata.name;
  return validation.resolved.kind === "provider" ? validation.resolved.result.name : "";
}

export function exchangeLabelFromValidation(
  validation: Extract<QuickAddValidation, { status: "ready" | "duplicate" }>,
): string {
  if (validation.resolved.kind === "provider") {
    const result = validation.resolved.result;
    return result.exchange === "SMART" ? result.primaryExchange || result.exchange : result.exchange || "";
  }
  return validation.ticker?.metadata.exchange || "";
}

/**
 * The symbol key can already store another listing. Only this listing's own
 * record, and its cached quote, belong to this add.
 */
function tickerForResolved(
  resolved: ResolvedTickerSearch,
  tickers: Map<string, TickerRecord>,
): TickerRecord | null {
  if (resolved.kind === "local") return resolved.ticker;
  const result = resolved.result;
  const exchange = canonicalExchange(result.exchange === "SMART" ? result.primaryExchange : result.exchange);
  const bare = parsePublicTickerKey(resolved.symbol).symbol;
  const qualified = publicTickerKey(bare, exchange || undefined);
  const qualifiedTicker = qualified === bare ? undefined : tickers.get(qualified);
  if (qualifiedTicker) return qualifiedTicker;
  const saved = tickers.get(bare) ?? tickers.get(resolved.symbol) ?? null;
  if (!saved) return null;
  const savedExchange = canonicalExchange(saved.metadata.exchange);
  if (exchange && savedExchange && exchange !== savedExchange) return null;
  return saved;
}

export async function resolveQuickAddValidation({
  query,
  collectionId,
  collectionKind,
  tickers,
  financials,
}: {
  query: string;
  collectionId: string;
  collectionKind: QuickAddCollectionKind;
  tickers: Map<string, TickerRecord>;
  financials: Map<string, { quote?: Quote | null }>;
}): Promise<QuickAddValidation> {
  if (!query) return IDLE_VALIDATION;
  if (!isPlausibleTickerQuery(query)) {
    return { status: "missing", query, message: QUICK_ADD_REFUSAL };
  }

  const registry = getSharedRegistry();
  if (!registry) {
    return { status: "error", query, message: "Ticker lookup unavailable" };
  }
  // Beside the search, so a symbol that changed (FB is now META) costs no wait.
  const changes = startTickerChangeLookup(registry.marketData, query);

  try {
    const resolved = await resolveTickerSearch({
      query,
      activeTicker: null,
      tickers,
      dataProvider: registry.marketData,
    });
    if (!resolved) {
      const payload = await changes.settle();
      const line = tickerChangeLine(describeTickerChange(query, payload, null)) ?? describeFormerIssuer(query, payload, null)?.note;
      return { status: "missing", query, message: line ?? "No exact ticker match" };
    }

    const symbol = resolved.symbol;
    const ticker = tickerForResolved(resolved, tickers);
    const cachedQuote = ticker ? financials.get(ticker.metadata.ticker)?.quote ?? null : null;
    // A listing its own quote vouched for comes with it.
    let quote = cachedQuote ?? (resolved.kind === "provider" ? resolved.quote ?? null : null);
    if (!quote) {
      try {
        quote = await registry.marketData.getQuote(
          symbol,
          exchangeFromResolved(resolved),
          quoteContextFromResolved(resolved),
        );
      } catch (error) {
        logFailure("portfolio-list.quick-add.resolution", "Read quick-add quote failed")(error);
        quote = null;
      }
    }

    // A listing abroad is not the US symbol the changes are of.
    const venue = resolved.kind === "provider" && resolved.result.exchange === "SMART"
      ? resolved.result.primaryExchange
      : exchangeFromResolved(resolved);
    const payload = isUsSymbolVenue(venue) ? await changes.settle() : null;
    const name = ticker?.metadata.name || (resolved.kind === "provider" ? resolved.result.name : "");
    return {
      status: tickerBelongsToCollection(ticker, collectionKind, collectionId) ? "duplicate" : "ready",
      query,
      symbol: ticker?.metadata.ticker ?? symbol,
      resolved,
      ticker,
      quote,
      change: describeTickerChange(query, payload, quote ? quotedListing(quote) : { name }),
      formerIssuer: describeFormerIssuer(query, payload, quote ? quotedListing(quote) : { name }),
    };
  } catch (error) {
    if (error instanceof AmbiguousTickerError && !(error instanceof AmbiguousContractError)) {
      return { status: "choose", query };
    }
    return { status: "error", query, message: isProviderBusy(error) ? "Search is busy" : "Ticker lookup failed" };
  }
}

/**
 * A pasted list checked entry by entry, as each would be typed alone, a few
 * at a time, each entry the memo has checked taken from it. Entries that are
 * one symbol (`EURUSD=X, eur/usd`) are that symbol once, as the first of
 * them. One entry is checked as a symbol typed alone.
 */
export async function resolveQuickAddList({
  query,
  entries,
  total = entries.length,
  memo = createQuickAddListMemo(),
  ...collection
}: Omit<Parameters<typeof resolveQuickAddValidation>[0], "query"> & {
  query: string;
  entries: readonly string[];
  total?: number;
  memo?: QuickAddListMemo;
}): Promise<QuickAddValidation> {
  if (entries.length <= 1 && total <= 1) return resolveQuickAddValidation({ ...collection, query: entries[0] ?? query });
  const checked = await mapWithConcurrency(entries, QUICK_ADD_LIST_LOOKUPS, async (entry): Promise<QuickAddEntryValidation> => {
    const known = memo.checked.get(entry);
    if (known) return known;
    const result = await resolveQuickAddValidation({ ...collection, query: entry });
    const settled: QuickAddEntryValidation = result.status === "idle" || result.status === "checking" || result.status === "list"
      ? { status: "error", query: entry, message: "Ticker lookup failed" }
      : result;
    if (settled.status !== "error") memo.checked.set(entry, settled);
    return settled;
  });
  const symbols = new Set<string>();
  const once = checked.filter((entry) => {
    if (entry.status !== "ready" && entry.status !== "duplicate") return true;
    if (symbols.has(entry.symbol)) return false;
    symbols.add(entry.symbol);
    return true;
  });
  return { status: "list", query, entries: once, ...(total > entries.length ? { total } : {}) };
}
