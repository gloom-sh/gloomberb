import type {
  Quote,
  QuoteContribution,
  QuoteContributionMap,
  SessionConfidence,
  TickerFinancials,
} from "../../types/financials";
import { reconcileQuoteDayRange } from "./day-range";

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
  return quote.sessionConfidence === "explicit" || quote.dataSource === "live";
}

export function finalizeSessionFields(
  quote: QuoteContribution,
  options: { allowPriceProjection?: boolean } = {},
): QuoteContribution {
  const allowPriceProjection = options.allowPriceProjection !== false;
  const canProjectSessionPrice = allowPriceProjection && shouldProjectSessionPrice(quote);

  if (quote.marketState === "PRE") {
    return {
      ...quote,
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
      preMarketPrice: undefined,
      preMarketChange: undefined,
      preMarketChangePercent: undefined,
      postMarketPrice: quote.postMarketPrice ?? (canProjectSessionPrice ? quote.price : undefined),
      postMarketChange: quote.postMarketChange ?? (canProjectSessionPrice ? quote.change : undefined),
      postMarketChangePercent: quote.postMarketChangePercent ?? (canProjectSessionPrice ? quote.changePercent : undefined),
    };
  }

  if (quote.marketState != null) {
    return {
      ...quote,
      preMarketPrice: undefined,
      preMarketChange: undefined,
      preMarketChangePercent: undefined,
      postMarketPrice: undefined,
      postMarketChange: undefined,
      postMarketChangePercent: undefined,
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

  return finalizeSessionFields(reconcileQuoteDayRange({
    ...quote,
    providerId,
    listingExchangeName,
    listingExchangeFullName,
    routingExchangeName,
    routingExchangeFullName,
    exchangeName: listingExchangeName ?? quote.exchangeName,
    fullExchangeName: listingExchangeFullName ?? quote.fullExchangeName,
    sessionConfidence: inferSessionConfidence(quote, providerId),
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

  const merged: QuoteContribution = {
    ...current,
    ...reconcileQuoteDayRange(next, current),
  };

  if (next.marketState == null && current.marketState != null) {
    merged.marketState = current.marketState;
  }
  if (next.sessionConfidence == null && current.sessionConfidence != null) {
    merged.sessionConfidence = current.sessionConfidence;
  }

  if ((current.marketState === "PRE" || current.marketState === "POST") && next.marketState == null) {
    const canProjectNextSessionPrice = shouldProjectSessionPrice(next);
    merged.marketState = current.marketState;
    if (current.marketState === "PRE") {
      merged.preMarketPrice = next.preMarketPrice ?? (canProjectNextSessionPrice ? next.price : current.preMarketPrice);
      merged.preMarketChange = next.preMarketChange ?? (canProjectNextSessionPrice ? next.change : current.preMarketChange);
      merged.preMarketChangePercent = next.preMarketChangePercent ?? (canProjectNextSessionPrice ? next.changePercent : current.preMarketChangePercent);
    } else {
      merged.postMarketPrice = next.postMarketPrice ?? (canProjectNextSessionPrice ? next.price : current.postMarketPrice);
      merged.postMarketChange = next.postMarketChange ?? (canProjectNextSessionPrice ? next.change : current.postMarketChange);
      merged.postMarketChangePercent = next.postMarketChangePercent ?? (canProjectNextSessionPrice ? next.changePercent : current.postMarketChangePercent);
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
