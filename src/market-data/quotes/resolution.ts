import type {
  Quote,
  QuoteContribution,
  QuoteContributionMap,
  QuoteDataSource,
  QuoteFieldProvenance,
  QuoteProvenance,
  SessionConfidence,
  TickerFinancials,
} from "../../types/financials";
import { hasLikelyQuoteUnitMismatch } from "../../utils/currency-units";
import { debugLog } from "../../utils/debug-log";
import { hasFreshQuoteForCurrentSession, isQuoteStaleForCurrentSession } from "./freshness";
import {
  finalizeSessionFields,
  getQuoteContributionKey,
  mergeQuoteContribution,
  normalizeQuoteContribution,
  quoteContributionValues,
  seedQuoteContributions,
} from "./contributions";

export {
  mergeQuoteContributionMaps,
  seedQuoteContributions,
} from "./contributions";

const quoteResolutionLog = debugLog.createLogger("quote-resolution");

const PRICE_FIELD_KEYS = [
  "symbol",
  "price",
  "currency",
  "bid",
  "ask",
  "bidSize",
  "askSize",
  "open",
  "high",
  "low",
  "mark",
  "lastUpdated",
  "receivedAt",
  "delivery",
  "stale",
] as const;

const SESSION_FIELD_KEYS = [
  "marketState",
  "sessionConfidence",
 ] as const;

const PRE_SESSION_FIELD_KEYS = [
  "preMarketPrice",
  "preMarketChange",
  "preMarketChangePercent",
 ] as const;

const POST_SESSION_FIELD_KEYS = [
  "postMarketPrice",
  "postMarketChange",
  "postMarketChangePercent",
] as const;

const DESCRIPTIVE_FIELD_KEYS = [
  "high52w",
  "low52w",
  "marketCap",
  "volume",
  "name",
] as const;

function isBrokerProvider(providerId?: string): boolean {
  return providerId === "ibkr";
}

function providerKindRank(providerId?: string): number {
  switch (providerId) {
    case "gloomberb-cloud":
      return 0;
    case "yahoo":
      return 1;
    case "ibkr":
      return 2;
    default:
      return 3;
  }
}

function dailyReferenceRank(providerId?: string): number {
  switch (providerId) {
    case "yahoo":
      return 0;
    case "gloomberb-cloud":
      return 1;
    case "ibkr":
      return 2;
    default:
      return 3;
  }
}

function priceRank(quote: QuoteContribution): number {
  if (quote.providerId === "ibkr" && quote.dataSource === "live") return 0;
  return 1;
}

function priceProviderTieRank(providerId?: string): number {
  switch (providerId) {
    case "gloomberb-cloud":
      return 0;
    case "yahoo":
      return 1;
    case "ibkr":
      return 2;
    default:
      return 3;
  }
}

function quoteUpdateTime(quote: QuoteContribution): number {
  return quote.lastUpdated ?? quote.receivedAt ?? 0;
}

function sessionConfidenceRank(confidence?: SessionConfidence): number {
  switch (confidence) {
    case "explicit":
      return 0;
    case "derived":
      return 1;
    case "unknown":
    default:
      return 2;
  }
}

function toProvenance(quote: QuoteContribution | undefined): QuoteFieldProvenance | undefined {
  if (!quote?.providerId) return undefined;
  return {
    providerId: quote.providerId,
    dataSource: quote.dataSource,
  };
}

function assignField(
  target: Partial<Quote>,
  provenance: QuoteProvenance,
  field: string,
  quote: QuoteContribution | undefined,
): void {
  if (!quote) return;
  const value = (quote as unknown as Record<string, unknown>)[field];
  if (value === undefined) return;
  (target as Record<string, unknown>)[field] = value;
  provenance.fields ??= {};
  provenance.fields[field] = toProvenance(quote)!;
}

function pickField(
  target: Partial<Quote>,
  provenance: QuoteProvenance,
  field: string,
  candidates: QuoteContribution[],
): QuoteContribution | undefined {
  for (const candidate of candidates) {
    if ((candidate as unknown as Record<string, unknown>)[field] === undefined) continue;
    assignField(target, provenance, field, candidate);
    return candidate;
  }
  return undefined;
}

function finitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function buildDailyReferenceCandidates(
  candidates: QuoteContribution[],
  priceProvider: QuoteContribution | undefined,
): QuoteContribution[] {
  return [...candidates]
    .filter((quote) => finitePositiveNumber(quote.previousClose))
    .sort((left, right) => {
      if (priceProvider) {
        const leftMismatch = hasLikelyQuoteUnitMismatch(priceProvider, left) ? 1 : 0;
        const rightMismatch = hasLikelyQuoteUnitMismatch(priceProvider, right) ? 1 : 0;
        if (leftMismatch !== rightMismatch) return leftMismatch - rightMismatch;
      }
      const providerDelta = dailyReferenceRank(left.providerId) - dailyReferenceRank(right.providerId);
      if (providerDelta !== 0) return providerDelta;
      return (right.lastUpdated ?? 0) - (left.lastUpdated ?? 0);
    });
}

function assignDailyChangeFields(
  target: Partial<Quote>,
  provenance: QuoteProvenance,
  priceProvider: QuoteContribution | undefined,
  candidates: QuoteContribution[],
): void {
  const referenceProvider = buildDailyReferenceCandidates(candidates, priceProvider)[0];
  if (!referenceProvider) {
    pickField(target, provenance, "previousClose", candidates);
    pickField(target, provenance, "change", candidates);
    pickField(target, provenance, "changePercent", candidates);
    return;
  }

  assignField(target, provenance, "previousClose", referenceProvider);
  const price = target.price;
  const previousClose = target.previousClose;
  if (!finitePositiveNumber(price) || !finitePositiveNumber(previousClose)) {
    pickField(target, provenance, "change", candidates);
    pickField(target, provenance, "changePercent", candidates);
    return;
  }

  target.change = price - previousClose;
  target.changePercent = (target.change / previousClose) * 100;
  provenance.fields ??= {};
  const referenceProvenance = toProvenance(referenceProvider);
  if (referenceProvenance) {
    provenance.fields.change = referenceProvenance;
    provenance.fields.changePercent = referenceProvenance;
  }
}

function buildAcceptedPriceCandidates(contributions: QuoteContribution[]): {
  accepted: QuoteContribution[];
  rejectedProviders: string[];
} {
  const sorted = [...contributions]
    .filter((quote) => Number.isFinite(quote.price))
    .sort((left, right) => {
      const rankDelta = priceRank(left) - priceRank(right);
      if (rankDelta !== 0) return rankDelta;
      if (priceRank(left) > 0) {
        const updateDelta = quoteUpdateTime(right) - quoteUpdateTime(left);
        if (updateDelta !== 0) return updateDelta;
      }
      const providerDelta = priceProviderTieRank(left.providerId) - priceProviderTieRank(right.providerId);
      if (providerDelta !== 0) return providerDelta;
      return quoteUpdateTime(right) - quoteUpdateTime(left);
    });

  const accepted: QuoteContribution[] = [];
  const rejectedProviders: string[] = [];
  let referenceQuote: QuoteContribution | undefined;

  for (const candidate of sorted) {
    if (referenceQuote && hasLikelyQuoteUnitMismatch(referenceQuote, candidate)) {
      rejectedProviders.push(candidate.providerId);
      quoteResolutionLog.warn("Rejected quote contribution due to likely unit mismatch", {
        acceptedProviderId: referenceQuote.providerId,
        acceptedPrice: referenceQuote.price,
        rejectedProviderId: candidate.providerId,
        rejectedPrice: candidate.price,
        symbol: candidate.symbol,
        currency: candidate.currency,
      });
      continue;
    }
    accepted.push(candidate);
    referenceQuote ??= candidate;
  }

  return { accepted, rejectedProviders };
}

function filterFreshQuoteCandidates(
  contributions: QuoteContribution[],
  now: number,
): { accepted: QuoteContribution[]; rejectedProviders: string[] } {
  if (!hasFreshQuoteForCurrentSession(contributions, now)) {
    return { accepted: contributions, rejectedProviders: [] };
  }

  const accepted: QuoteContribution[] = [];
  const rejectedProviders = new Set<string>();

  for (const contribution of contributions) {
    if (isQuoteStaleForCurrentSession(contribution, now)) {
      rejectedProviders.add(contribution.providerId);
      quoteResolutionLog.warn("Rejected stale quote contribution for the current session", {
        providerId: contribution.providerId,
        price: contribution.price,
        marketState: contribution.marketState,
        lastUpdated: contribution.lastUpdated,
        exchange: contribution.listingExchangeName ?? contribution.exchangeName,
        symbol: contribution.symbol,
      });
      continue;
    }
    accepted.push(contribution);
  }

  return {
    accepted,
    rejectedProviders: [...rejectedProviders],
  };
}

function buildSessionCandidates(contributions: QuoteContribution[]): QuoteContribution[] {
  return [...contributions]
    .filter((quote) => (
      quote.marketState !== undefined
      || quote.sessionConfidence !== undefined
      || quote.preMarketPrice !== undefined
      || quote.postMarketPrice !== undefined
    ))
    .sort((left, right) => {
      const confidenceDelta = sessionConfidenceRank(left.sessionConfidence) - sessionConfidenceRank(right.sessionConfidence);
      if (confidenceDelta !== 0) return confidenceDelta;
      const providerDelta = providerKindRank(left.providerId) - providerKindRank(right.providerId);
      if (providerDelta !== 0) return providerDelta;
      return (right.lastUpdated ?? 0) - (left.lastUpdated ?? 0);
    });
}

function matchesPreMarketState(state?: QuoteContribution["marketState"]): boolean {
  return state === "PRE" || state === "PREPRE";
}

function matchesPostMarketState(state?: QuoteContribution["marketState"]): boolean {
  return state === "POST" || state === "POSTPOST";
}

function buildListingCandidates(contributions: QuoteContribution[]): QuoteContribution[] {
  return [...contributions]
    .filter((quote) => quote.listingExchangeName || quote.listingExchangeFullName)
    .sort((left, right) => {
      const providerDelta = providerKindRank(left.providerId) - providerKindRank(right.providerId);
      if (providerDelta !== 0) return providerDelta;
      return (right.lastUpdated ?? 0) - (left.lastUpdated ?? 0);
    });
}

function buildRoutingCandidates(contributions: QuoteContribution[]): QuoteContribution[] {
  return [...contributions]
    .filter((quote) => isBrokerProvider(quote.providerId) && (quote.routingExchangeName || quote.routingExchangeFullName))
    .sort((left, right) => (right.lastUpdated ?? 0) - (left.lastUpdated ?? 0));
}

function buildDescriptiveCandidates(contributions: QuoteContribution[]): QuoteContribution[] {
  return [...contributions]
    .sort((left, right) => {
      const providerDelta = providerKindRank(left.providerId) - providerKindRank(right.providerId);
      if (providerDelta !== 0) return providerDelta;
      return (right.lastUpdated ?? 0) - (left.lastUpdated ?? 0);
    });
}

export function resolveCanonicalQuote(
  quoteContributions: QuoteContributionMap | undefined,
  now = Date.now(),
): { quote?: Quote; provenance?: QuoteProvenance } {
  const contributions = quoteContributionValues(quoteContributions);
  if (contributions.length === 0) return {};

  const { accepted: freshQuoteCandidates } = filterFreshQuoteCandidates(contributions, now);
  const effectiveQuoteCandidates = freshQuoteCandidates.length > 0 ? freshQuoteCandidates : contributions;
  const { accepted: acceptedPriceCandidates, rejectedProviders } = buildAcceptedPriceCandidates(effectiveQuoteCandidates);
  if (acceptedPriceCandidates.length === 0) return {};

  const sessionCandidates = buildSessionCandidates(effectiveQuoteCandidates);
  const listingCandidates = buildListingCandidates(contributions);
  const routingCandidates = buildRoutingCandidates(contributions);
  const descriptiveCandidates = buildDescriptiveCandidates(contributions);

  const resolved: Partial<Quote> = {};
  const provenance: QuoteProvenance = {
    rejectedPriceProviders: rejectedProviders.length > 0 ? rejectedProviders : undefined,
  };

  const priceProvider = pickField(resolved, provenance, "price", acceptedPriceCandidates);
  for (const field of PRICE_FIELD_KEYS) {
    if (field === "price") continue;
    pickField(resolved, provenance, field, acceptedPriceCandidates);
  }
  assignDailyChangeFields(resolved, provenance, priceProvider, acceptedPriceCandidates);
  provenance.price = toProvenance(priceProvider);

  const sessionProvider = sessionCandidates[0];
  if (sessionProvider) {
    for (const field of SESSION_FIELD_KEYS) {
      assignField(resolved, provenance, field, sessionProvider);
    }
    provenance.session = toProvenance(sessionProvider);
  }

  const preSessionCandidates = sessionCandidates.filter((quote) => matchesPreMarketState(quote.marketState));
  for (const field of PRE_SESSION_FIELD_KEYS) {
    pickField(resolved, provenance, field, preSessionCandidates);
  }

  const postSessionCandidates = sessionCandidates.filter((quote) => matchesPostMarketState(quote.marketState));
  for (const field of POST_SESSION_FIELD_KEYS) {
    pickField(resolved, provenance, field, postSessionCandidates);
  }

  const listingProvider = listingCandidates[0];
  if (listingProvider) {
    assignField(resolved, provenance, "listingExchangeName", listingProvider);
    assignField(resolved, provenance, "listingExchangeFullName", listingProvider);
    resolved.exchangeName = resolved.listingExchangeName;
    resolved.fullExchangeName = resolved.listingExchangeFullName;
    provenance.fields ??= {};
    if (resolved.exchangeName !== undefined) {
      provenance.fields.exchangeName = toProvenance(listingProvider)!;
    }
    if (resolved.fullExchangeName !== undefined) {
      provenance.fields.fullExchangeName = toProvenance(listingProvider)!;
    }
    provenance.listing = toProvenance(listingProvider);
  }

  const routingProvider = routingCandidates[0];
  if (routingProvider) {
    assignField(resolved, provenance, "routingExchangeName", routingProvider);
    assignField(resolved, provenance, "routingExchangeFullName", routingProvider);
    provenance.routing = toProvenance(routingProvider);
  }

  let descriptiveProvider: QuoteContribution | undefined;
  for (const field of DESCRIPTIVE_FIELD_KEYS) {
    const provider = pickField(resolved, provenance, field, descriptiveCandidates);
    descriptiveProvider ??= provider;
  }
  provenance.descriptive = toProvenance(descriptiveProvider);

  const canonical = finalizeSessionFields({
    symbol: String(resolved.symbol ?? priceProvider?.symbol ?? contributions[0]!.symbol ?? ""),
    providerId: priceProvider?.providerId ?? contributions[0]!.providerId,
    price: Number(resolved.price ?? priceProvider?.price ?? 0),
    currency: String(resolved.currency ?? priceProvider?.currency ?? contributions[0]!.currency ?? ""),
    change: Number(resolved.change ?? priceProvider?.change ?? 0),
    changePercent: Number(resolved.changePercent ?? priceProvider?.changePercent ?? 0),
    previousClose: resolved.previousClose as Quote["previousClose"],
    high52w: resolved.high52w as Quote["high52w"],
    low52w: resolved.low52w as Quote["low52w"],
    marketCap: resolved.marketCap as Quote["marketCap"],
    volume: resolved.volume as Quote["volume"],
    name: resolved.name as Quote["name"],
    lastUpdated: Number(resolved.lastUpdated ?? priceProvider?.lastUpdated ?? sessionProvider?.lastUpdated ?? now),
    receivedAt: resolved.receivedAt as Quote["receivedAt"],
    delivery: resolved.delivery as Quote["delivery"],
    stale: resolved.stale as Quote["stale"],
    exchangeName: resolved.exchangeName as Quote["exchangeName"],
    fullExchangeName: resolved.fullExchangeName as Quote["fullExchangeName"],
    listingExchangeName: resolved.listingExchangeName as Quote["listingExchangeName"],
    listingExchangeFullName: resolved.listingExchangeFullName as Quote["listingExchangeFullName"],
    routingExchangeName: resolved.routingExchangeName as Quote["routingExchangeName"],
    routingExchangeFullName: resolved.routingExchangeFullName as Quote["routingExchangeFullName"],
    marketState: resolved.marketState as Quote["marketState"],
    sessionConfidence: resolved.sessionConfidence as Quote["sessionConfidence"],
    preMarketPrice: resolved.preMarketPrice as Quote["preMarketPrice"],
    preMarketChange: resolved.preMarketChange as Quote["preMarketChange"],
    preMarketChangePercent: resolved.preMarketChangePercent as Quote["preMarketChangePercent"],
    postMarketPrice: resolved.postMarketPrice as Quote["postMarketPrice"],
    postMarketChange: resolved.postMarketChange as Quote["postMarketChange"],
    postMarketChangePercent: resolved.postMarketChangePercent as Quote["postMarketChangePercent"],
    bid: resolved.bid as Quote["bid"],
    ask: resolved.ask as Quote["ask"],
    bidSize: resolved.bidSize as Quote["bidSize"],
    askSize: resolved.askSize as Quote["askSize"],
    open: resolved.open as Quote["open"],
    high: resolved.high as Quote["high"],
    low: resolved.low as Quote["low"],
    mark: resolved.mark as Quote["mark"],
    dataSource: (resolved.dataSource as QuoteDataSource | undefined) ?? priceProvider?.dataSource,
    provenance,
  }, {
    allowPriceProjection: false,
  });

  return {
    quote: canonical,
    provenance,
  };
}

export function upsertQuoteContributionMap(
  current: QuoteContributionMap | undefined,
  quote: Quote | QuoteContribution,
  options: { rejectUnitMismatch?: boolean; now?: number } = {},
): QuoteContributionMap {
  const normalized = normalizeQuoteContribution(quote);
  if (!normalized) return current ?? {};
  const now = options.now ?? Date.now();
  if (isQuoteStaleForCurrentSession(normalized, now) && hasFreshQuoteForCurrentSession(quoteContributionValues(current), now)) {
    quoteResolutionLog.warn("Rejected incoming stale quote contribution for the current session", {
      incomingProviderId: normalized.providerId,
      incomingPrice: normalized.price,
      lastUpdated: normalized.lastUpdated,
      marketState: normalized.marketState,
      exchange: normalized.listingExchangeName ?? normalized.exchangeName,
      symbol: normalized.symbol,
    });
    return current ?? {};
  }
  if (options.rejectUnitMismatch) {
    const acceptedQuote = resolveCanonicalQuote(current).quote;
    if (acceptedQuote && hasLikelyQuoteUnitMismatch(acceptedQuote, normalized)) {
      quoteResolutionLog.warn("Rejected incoming quote contribution due to likely unit mismatch", {
        acceptedProviderId: acceptedQuote.providerId,
        acceptedPrice: acceptedQuote.price,
        incomingProviderId: normalized.providerId,
        incomingPrice: normalized.price,
        symbol: normalized.symbol,
        currency: normalized.currency,
      });
      return current ?? {};
    }
  }
  const key = getQuoteContributionKey(normalized);
  const nextMap = { ...(current ?? {}) };
  let baseContribution = nextMap[key];

  if (!baseContribution && key !== "quote") {
    const genericContribution = nextMap.quote;
    if (genericContribution?.providerId === "quote") {
      baseContribution = genericContribution;
      delete nextMap.quote;
    }
  }

  return {
    ...nextMap,
    [key]: mergeQuoteContribution(baseContribution, normalized),
  };
}

export function resolveTickerFinancialsQuoteState(
  financials: TickerFinancials | null | undefined,
  incomingQuote?: Quote | QuoteContribution | null,
): TickerFinancials | null {
  if (!financials && !incomingQuote) return null;

  const baseFinancials: TickerFinancials = financials ?? {
    annualStatements: [],
    quarterlyStatements: [],
    priceHistory: [],
  };

  let quoteContributions = seedQuoteContributions(baseFinancials);
  if (incomingQuote) {
    quoteContributions = upsertQuoteContributionMap(quoteContributions, incomingQuote, {
      rejectUnitMismatch: true,
    });
  }

  const { quote } = resolveCanonicalQuote(quoteContributions);
  return {
    ...baseFinancials,
    quote,
    quoteContributions,
  };
}
