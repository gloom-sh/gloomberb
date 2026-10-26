import { resolvePriceBasis } from "../market/price-basis";
import { isAlwaysOpenExchange } from "../market/freshness";
import type {
  MarketState,
  Quote,
  QuoteContribution,
  QuoteContributionMap,
  SessionConfidence,
  TickerFinancials,
} from "../../types/financials";
import { classifyInstrumentType } from "../../tickers/instrument-kind";
import { quoteTradingDay, reconcileQuoteDayRange } from "./day-range";

const RETAINED_DESCRIPTIVE_FIELDS = ["high52w", "low52w", "marketCap", "name", "instrumentType"] as const;
const PRICE_DENOMINATED_DESCRIPTIVE_FIELDS: ReadonlySet<string> = new Set(["high52w", "low52w", "marketCap"]);
/**
 * Values that belong to one trading day. A quote from another day that leaves
 * them out has no anchor for its own day yet, and keeping the old day's value
 * would show yesterday's close, open or volume as today's. The day range is
 * reconciled separately (reconcileQuoteDayRange).
 */
const TRADING_DAY_FIELDS = [
  "changeSessionDate", "previousClose", "previousCloseDate", "open", "volume", "mark", "bid", "ask", "bidSize", "askSize",
  "lastTradePrice", "lastTradeTime",
] as const;

/**
 * Whether two observations from one source describe different trading days.
 * Only sources that declare the day they anchor to are judged; for the rest a
 * partial tick may legitimately rely on the fields it already sent.
 */
function isOtherTradingDay(current: Quote, next: Quote): boolean {
  if (!current.changeSessionDate && !next.changeSessionDate) return false;
  const currentDay = quoteTradingDay(current);
  const nextDay = quoteTradingDay(next);
  return currentDay !== null && nextDay !== null && nextDay !== currentDay;
}

/** Whether two observations are known to describe the same trading day. */
function isSameTradingDay(current: Quote, next: Quote): boolean {
  const currentDay = quoteTradingDay(current);
  return currentDay !== null && currentDay === quoteTradingDay(next);
}

function inferQuoteProviderId(quote: Quote | QuoteContribution): string {
  if (quote.providerId?.trim()) return quote.providerId;
  return "quote";
}

function inferSessionConfidence(
  quote: Quote | QuoteContribution,
  providerId: string,
): SessionConfidence {
  if (quote.sessionConfidence) return quote.sessionConfidence;
  if (providerId === "ibkr") return "unknown";
  if (quote.marketState) return providerId === "gloomberb-cloud" ? "derived" : "derived";
  return "unknown";
}

/**
 * A CCC coin trades through the equity close. The live tape often leaves the
 * session off, and a copied equity close would paint the coin shut.
 */
function alwaysOpenSession(quote: Pick<Quote, "listingExchangeName" | "exchangeName" | "instrumentType" | "marketState">): { marketState: MarketState; sessionConfidence: SessionConfidence } | null {
  const open = isAlwaysOpenExchange(quote.listingExchangeName ?? quote.exchangeName)
    || classifyInstrumentType(quote.instrumentType) === "crypto";
  if (!open || quote.marketState === "REGULAR") return null;
  return { marketState: "REGULAR", sessionConfidence: "derived" };
}

function normalizeListingExchange(
  quote: Quote | QuoteContribution,
  providerId: string,
): { listingExchangeName?: string; listingExchangeFullName?: string } {
  const listingExchangeName = quote.listingExchangeName ?? quote.exchangeName;
  const listingExchangeFullName = quote.listingExchangeFullName ?? quote.fullExchangeName ?? listingExchangeName;
  if (providerId === "ibkr" && listingExchangeName === "SMART") {
    return {
      listingExchangeName: undefined,
      listingExchangeFullName: undefined,
    };
  }
  return { listingExchangeName, listingExchangeFullName };
}

function shouldProjectSessionPrice(quote: Quote | QuoteContribution): boolean {
  // An explicit market state identifies the session, not which session supplied
  // the last trade. Delayed snapshots can still contain the regular close.
  return quote.dataSource === "live";
}

/** The overnight session's fields cleared: a quote in a session of the exchange's own has none. */
const NO_OVERNIGHT_PRICE = {
  overnightPrice: undefined,
  overnightChange: undefined,
  overnightChangePercent: undefined,
  overnightPriceKind: undefined,
} as const;

export function finalizeSessionFields(
  quote: QuoteContribution,
  options: { allowPriceProjection?: boolean } = {},
): QuoteContribution {
  const allowPriceProjection = options.allowPriceProjection !== false;
  const canProjectSessionPrice = allowPriceProjection && shouldProjectSessionPrice(quote);

  if (quote.marketState === "PRE") {
    return {
      ...quote,
      ...NO_OVERNIGHT_PRICE,
      preMarketPrice: quote.preMarketPrice ?? (canProjectSessionPrice ? quote.price : undefined),
      preMarketChange: quote.preMarketChange ?? (canProjectSessionPrice ? quote.change : undefined),
      preMarketChangePercent: quote.preMarketChangePercent ?? (canProjectSessionPrice ? quote.changePercent : undefined),
      postMarketPrice: undefined,
      postMarketChange: undefined,
      postMarketChangePercent: undefined,
    };
  }

  if (quote.marketState === "POST") {
    return {
      ...quote,
      ...NO_OVERNIGHT_PRICE,
      preMarketPrice: undefined,
      preMarketChange: undefined,
      preMarketChangePercent: undefined,
      postMarketPrice: quote.postMarketPrice ?? (canProjectSessionPrice ? quote.price : undefined),
      // A daily move uses the previous day's close, not the after-hours baseline.
      postMarketChange: quote.postMarketChange,
      postMarketChangePercent: quote.postMarketChangePercent,
    };
  }

  if (quote.marketState != null) {
    return {
      ...quote,
      ...(quote.marketState === "REGULAR" ? NO_OVERNIGHT_PRICE : {}),
      preMarketPrice: undefined,
      preMarketChange: undefined,
      preMarketChangePercent: undefined,
      postMarketPrice: undefined,
      postMarketChange: undefined,
      postMarketChangePercent: undefined,
      extendedSessionPrint: undefined,
    };
  }

  return quote;
}

export function getQuoteContributionKey(quote: Quote | QuoteContribution): string {
  return inferQuoteProviderId(quote);
}

export function normalizeQuoteContribution(
  quote: Quote | QuoteContribution | null | undefined,
): QuoteContribution | undefined {
  if (!quote) return undefined;
  const providerId = inferQuoteProviderId(quote);
  const { listingExchangeName, listingExchangeFullName } = normalizeListingExchange(quote, providerId);
  const routingExchangeName = quote.routingExchangeName;
  const routingExchangeFullName = quote.routingExchangeFullName ?? routingExchangeName;
  const exchangeName = listingExchangeName ?? quote.exchangeName;
  const session = alwaysOpenSession({ ...quote, listingExchangeName, exchangeName });

  return finalizeSessionFields(reconcileQuoteDayRange({
    ...quote,
    providerId,
    listingExchangeName,
    listingExchangeFullName,
    routingExchangeName,
    routingExchangeFullName,
    exchangeName,
    fullExchangeName: listingExchangeFullName ?? quote.fullExchangeName,
    ...session,
    sessionConfidence: session?.sessionConfidence ?? inferSessionConfidence(quote, providerId),
  }));
}

export function mergeQuoteContribution(
  current: QuoteContribution | undefined,
  nextQuote: Quote | QuoteContribution,
): QuoteContribution {
  const next = normalizeQuoteContribution(nextQuote);
  if (!next) {
    throw new Error("Cannot merge an empty quote contribution");
  }
  if (!current) return next;

  // NAV responses are complete dated observations. Never carry an earlier
  // date or intraday session fields into one, or its marker into a later tick.
  if (current.priceObservation != null || next.priceObservation != null) {
    return { ...next, name: next.name ?? current.name };
  }

  const priorBasis = resolvePriceBasis(current.priceBasis, current.instrumentType);
  const samePriceBasis = priorBasis !== null && priorBasis === resolvePriceBasis(next.priceBasis, next.instrumentType || current.instrumentType);
  const merged: QuoteContribution = {
    ...current,
    ...reconcileQuoteDayRange(next, current),
    // Close provenance belongs to this observation; never borrow an anchor
    // from another session, listing or currency when a new quote omits it.
    ...(!samePriceBasis ? {
      previousClose: next.previousClose, previousCloseDate: next.previousCloseDate, bid: next.bid, ask: next.ask,
      open: next.open, mark: next.mark, high52w: next.high52w, low52w: next.low52w,
      lastTradePrice: next.lastTradePrice, lastTradeTime: next.lastTradeTime,
      preMarketPrice: next.preMarketPrice, preMarketChange: next.preMarketChange,
      preMarketChangePercent: next.preMarketChangePercent,
      postMarketPrice: next.postMarketPrice, postMarketChange: next.postMarketChange,
      postMarketChangePercent: next.postMarketChangePercent,
    } : {}),
    priceBasis: next.priceBasis,
    // Said of this observation's price; a tick that does not say leaves it unknown.
    extendedSessionPrint: next.extendedSessionPrint,
    overnightPrice: next.overnightPrice,
    overnightChange: next.overnightChange,
    overnightChangePercent: next.overnightChangePercent,
    overnightPriceKind: next.overnightPriceKind,
    // The board this observation was read on; one read on the listing's own line names none.
    tradingExchangeName: next.tradingExchangeName,
    // Whether the listing no longer trades is said with each observation: a symbol that trades again drops it.
    delisting: next.delisting,
    // So is a pair's price being its bar's close, and why a stale one stands; a bar's close is no trade.
    intradayBar: next.intradayBar,
    staleReason: next.staleReason,
    ...(next.intradayBar ? { lastTradePrice: next.lastTradePrice, lastTradeTime: next.lastTradeTime } : {}),
    regularClose: next.regularClose,
    regularCloseSessionDate: next.regularClose != null ? next.regularCloseSessionDate : undefined,
    regularChange: next.regularClose != null ? next.regularChange : undefined,
    regularChangePercent: next.regularClose != null ? next.regularChangePercent : undefined,
  };

  // What this observation's move is from, when not its previous close (a coin's
  // 24 hours), is said with each one: a quote back on its
  // previous close drops an earlier "24h", and one on 24 hours drops the
  // earlier close its move no longer runs from.
  if (next.changeBasis == null) {
    delete merged.changeBasis;
  } else if (next.previousClose === undefined) {
    delete merged.previousClose;
    delete merged.previousCloseDate;
  }
  // The day a previous close is from is said of that close and that session: a tick that names
  // none keeps it while both are the same, and drops it otherwise. A close can repeat across
  // sessions (a flat day), so the trading day decides, not the close alone.
  if (next.previousCloseDate === undefined) {
    const sameClose = next.previousClose === undefined || next.previousClose === current.previousClose;
    if (samePriceBasis && sameClose && merged.previousClose === current.previousClose && current.previousCloseDate && isSameTradingDay(current, next)) {
      merged.previousCloseDate = current.previousCloseDate;
    } else {
      delete merged.previousCloseDate;
    }
  }

  if (isOtherTradingDay(current, next)) {
    const record = merged as unknown as Record<string, unknown>;
    for (const field of TRADING_DAY_FIELDS) {
      if (next[field] === undefined) delete record[field];
    }
  }

  // Leaving a descriptive field out is not a retraction. Price-denominated
  // ones only carry over while the price convention is unchanged.
  for (const field of RETAINED_DESCRIPTIVE_FIELDS) {
    if (merged[field] === undefined && current[field] !== undefined && (samePriceBasis || !PRICE_DENOMINATED_DESCRIPTIVE_FIELDS.has(field))) {
      (merged as unknown as Record<string, unknown>)[field] = current[field];
    }
  }

  if (next.marketState == null && current.marketState != null) {
    merged.marketState = current.marketState;
  }
  if (next.sessionConfidence == null && current.sessionConfidence != null) {
    merged.sessionConfidence = current.sessionConfidence;
  }

  if ((current.marketState === "PRE" || current.marketState === "POST") && next.marketState == null
    && samePriceBasis) {
    const canProjectNextSessionPrice = shouldProjectSessionPrice(next);
    merged.marketState = current.marketState;
    if (current.marketState === "PRE") {
      merged.preMarketPrice = next.preMarketPrice ?? (canProjectNextSessionPrice ? next.price : current.preMarketPrice);
      merged.preMarketChange = next.preMarketChange ?? (canProjectNextSessionPrice ? next.change : current.preMarketChange);
      merged.preMarketChangePercent = next.preMarketChangePercent ?? (canProjectNextSessionPrice ? next.changePercent : current.preMarketChangePercent);
    } else {
      merged.postMarketPrice = next.postMarketPrice ?? (canProjectNextSessionPrice ? next.price : current.postMarketPrice);
      const changesPostPrice = next.postMarketPrice != null || canProjectNextSessionPrice;
      merged.postMarketChange = next.postMarketChange ?? (changesPostPrice ? undefined : current.postMarketChange);
      merged.postMarketChangePercent = next.postMarketChangePercent ?? (changesPostPrice ? undefined : current.postMarketChangePercent);
    }
  }

  return finalizeSessionFields(merged);
}

export function mergeQuoteContributionMaps(
  preferred: QuoteContributionMap | undefined,
  fallback: QuoteContributionMap | undefined,
): QuoteContributionMap | undefined {
  const entries = new Map<string, QuoteContribution>();

  for (const source of [fallback, preferred]) {
    if (!source) continue;
    for (const [key, quote] of Object.entries(source)) {
      const normalized = normalizeQuoteContribution(quote);
      if (!normalized) continue;
      const contributionKey = key || getQuoteContributionKey(normalized);
      entries.set(
        contributionKey,
        mergeQuoteContribution(entries.get(contributionKey), normalized),
      );
    }
  }

  if (entries.size === 0) return undefined;
  return Object.fromEntries(entries.entries());
}

function cloneQuoteContributionMap(map: QuoteContributionMap | undefined): QuoteContributionMap | undefined {
  return mergeQuoteContributionMaps(map, undefined);
}

export function quoteContributionValues(map: QuoteContributionMap | undefined): QuoteContribution[] {
  return Object.values(map ?? {});
}

export function seedQuoteContributions(financials: TickerFinancials | null | undefined): QuoteContributionMap | undefined {
  if (!financials) return undefined;
  if (financials.quoteContributions && Object.keys(financials.quoteContributions).length > 0) {
    return cloneQuoteContributionMap(financials.quoteContributions);
  }
  const normalizedQuote = normalizeQuoteContribution(financials.quote);
  if (!normalizedQuote) return undefined;
  const key = getQuoteContributionKey(normalizedQuote);
  return { [key]: normalizedQuote };
}
