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

const QUICK_ADD_MAX_QUERY_LENGTH = 32;
const QUICK_ADD_SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-\s]*$/;

export type QuickAddCollectionKind = "portfolio" | "watchlist";

interface ResolvedQuickAdd {
  query: string;
  symbol: string;
  resolved: ResolvedTickerSearch;
  ticker: TickerRecord | null;
  quote: Quote | null;
}

export type QuickAddValidation =
  | { status: "idle"; query: "" }
  | { status: "checking"; query: string }
  | (ResolvedQuickAdd & { status: "ready" })
  | (ResolvedQuickAdd & { status: "duplicate" })
  /** The symbol names several listings and none is the default: the add row asks which. */
  | { status: "choose"; query: string }
  | { status: "missing"; query: string; message: string }
  | { status: "error"; query: string; message: string };

export const IDLE_VALIDATION: QuickAddValidation = { status: "idle", query: "" };

export function normalizeQuickAddQuery(value: string): string {
  return value.replace(/^\s*\$/, "").trim().toUpperCase().replace(/\s+/g, " ");
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
    return { status: "missing", query, message: "Use a ticker symbol" };
  }

  const registry = getSharedRegistry();
  if (!registry) {
    return { status: "error", query, message: "Ticker lookup unavailable" };
  }

  try {
    const resolved = await resolveTickerSearch({
      query,
      activeTicker: null,
      tickers,
      dataProvider: registry.marketData,
    });
    if (!resolved) {
      return { status: "missing", query, message: "No exact ticker match" };
    }

    const symbol = resolved.symbol;
    const ticker = tickerForResolved(resolved, tickers);
    const cachedQuote = ticker ? financials.get(ticker.metadata.ticker)?.quote ?? null : null;
    let quote = cachedQuote;
    if (!quote) {
      try {
        quote = await registry.marketData.getQuote(
          symbol,
          exchangeFromResolved(resolved),
          quoteContextFromResolved(resolved),
        );
      } catch {
        quote = null;
      }
    }

    return {
      status: tickerBelongsToCollection(ticker, collectionKind, collectionId) ? "duplicate" : "ready",
      query,
      symbol: ticker?.metadata.ticker ?? symbol,
      resolved,
      ticker,
      quote,
    };
  } catch (error) {
    if (error instanceof AmbiguousTickerError && !(error instanceof AmbiguousContractError)) {
      return { status: "choose", query };
    }
    return { status: "error", query, message: "Ticker lookup failed" };
  }
}
