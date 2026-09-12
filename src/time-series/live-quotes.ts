import { canonicalTimeSeriesFieldId, isMarketFieldId } from "./field-catalog";
import type { DataProvider, QuoteSubscriptionTarget } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { BrokerContractRef } from "../types/instrument";
import type { ChartSeriesSpec, ChartSpec, SecuritySeriesSource } from "./types";
import { activeStudyInputSeriesIds } from "./studies";
import { valuationSeriesUsesLiveQuote } from "./fundamentals";

export const LIVE_CHART_REFRESH_INTERVAL_MS = 1_000;

function normalized(value: string | undefined): string {
  return value?.trim().toUpperCase() ?? "";
}

function quoteIdentityKey(identity: {
  symbol: string;
  exchange?: string;
  brokerId?: string;
  brokerInstanceId?: string;
  instrument?: BrokerContractRef | null;
}): string {
  const contractKey = identity.instrument?.conId
    ?? identity.instrument?.localSymbol
    ?? identity.instrument?.symbol
    ?? "";
  return [
    normalized(identity.symbol),
    normalized(identity.exchange),
    identity.brokerId ?? "",
    identity.brokerInstanceId ?? "",
    contractKey,
  ].join("|");
}

export function chartQuoteOverrideKeyForSource(source: SecuritySeriesSource): string {
  return quoteIdentityKey({
    symbol: source.instrument.symbol,
    exchange: source.instrument.exchange,
    brokerId: source.instrument.brokerId,
    brokerInstanceId: source.instrument.brokerInstanceId,
    instrument: source.instrument.instrument,
  });
}

export function chartQuoteOverrideKeyForTarget(target: QuoteSubscriptionTarget): string {
  return quoteIdentityKey({
    symbol: target.symbol,
    exchange: target.exchange,
    brokerId: target.context?.brokerId,
    brokerInstanceId: target.context?.brokerInstanceId,
    instrument: target.context?.instrument,
  });
}

function supportsLiveQuote(
  series: ChartSeriesSpec,
  activeStudyInputs: ReadonlySet<string>,
): series is ChartSeriesSpec & {
  source: SecuritySeriesSource;
} {
  if ((series.visible === false && !activeStudyInputs.has(series.id)) || series.source.kind !== "security") {
    return false;
  }
  const fieldId = canonicalTimeSeriesFieldId(series.source.fieldId);
  return isMarketFieldId(fieldId) || valuationSeriesUsesLiveQuote(fieldId);
}

/** Displayed or study-required quote-sensitive instruments, deduplicated by routing identity. */
export function getLiveChartQuoteTargets(spec: ChartSpec): QuoteSubscriptionTarget[] {
  const targets = new Map<string, QuoteSubscriptionTarget>();
  const activeStudyInputs = activeStudyInputSeriesIds(spec.studies);
  for (const series of spec.series) {
    if (!supportsLiveQuote(series, activeStudyInputs)) continue;
    const target: QuoteSubscriptionTarget = {
      symbol: series.source.instrument.symbol,
      exchange: series.source.instrument.exchange,
      context: {
        brokerId: series.source.instrument.brokerId,
        brokerInstanceId: series.source.instrument.brokerInstanceId,
        instrument: series.source.instrument.instrument ?? null,
      },
      surface: "detail",
      visible: true,
      weight: 1,
    };
    targets.set(chartQuoteOverrideKeyForTarget(target), target);
  }
  return [...targets.values()];
}

export function liveChartQuoteTargetSignature(spec: ChartSpec): string {
  return getLiveChartQuoteTargets(spec)
    .map(chartQuoteOverrideKeyForTarget)
    .sort()
    .join("\n");
}

/** A malformed timestamp cannot outrank a usable source observation forever. */
export function compareChartQuoteRecency(next: Quote, current: Quote): number {
  const sourceTime = (quote: Quote) => Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0
    && Number.isFinite(new Date(quote.lastUpdated).getTime()) ? quote.lastUpdated : -Infinity;
  const nextTime = sourceTime(next);
  const currentTime = sourceTime(current);
  if (nextTime !== currentTime) return nextTime > currentTime ? 1 : -1;
  const receipt = (quote: Quote) => Number.isFinite(quote.receivedAt) ? quote.receivedAt! : 0;
  return receipt(next) - receipt(current);
}

function isNewerQuote(next: Quote, current: Quote | undefined): boolean {
  if (!current) return true;
  const order = compareChartQuoteRecency(next, current);
  // Providers can change status while retaining the original source/receipt
  // timestamps. At that same observation, the incoming status is authoritative.
  // An older source observation or receipt still cannot replace newer data.
  return order > 0 || (order === 0 && next.lastUpdated === current.lastUpdated
    && (next.stale === true) !== (current.stale === true));
}

function hasResolutionRelevantChange(next: Quote, current: Quote | undefined): boolean {
  if (!current) return true;
  return next.lastUpdated !== current.lastUpdated
    || next.price !== current.price
    || next.stale !== current.stale
    || next.currency !== current.currency
    || next.instrumentType !== current.instrumentType
    || next.providerId !== current.providerId
    || next.marketState !== current.marketState
    || next.preMarketPrice !== current.preMarketPrice
    || next.postMarketPrice !== current.postMarketPrice
    || next.exchangeName !== current.exchangeName
    || next.listingExchangeName !== current.listingExchangeName;
}

export interface LiveChartQuoteSubscriptionOptions {
  spec: ChartSpec;
  dataProvider: DataProvider | null;
  onRefresh: (quoteOverrides: ReadonlyMap<string, Quote>) => Promise<void> | void;
  refreshIntervalMs?: number;
}

/**
 * Coalesces streaming quote bursts and serializes engine refreshes. A slow
 * refresh can have at most one follow-up queued, using the latest quote per
 * instrument, so streaming never fans out into overlapping history requests.
 */
export function subscribeToLiveChartQuotes({
  spec,
  dataProvider,
  onRefresh,
  refreshIntervalMs = LIVE_CHART_REFRESH_INTERVAL_MS,
}: LiveChartQuoteSubscriptionOptions): () => void {
  const targets = getLiveChartQuoteTargets(spec);
  if (!dataProvider?.subscribeQuotes || targets.length === 0) return () => {};

  const subscribedKeys = new Set(targets.map(chartQuoteOverrideKeyForTarget));
  const quoteOverrides = new Map<string, Quote>();
  const interval = Math.max(0, refreshIntervalMs);
  let disposed = false;
  let pending = false;
  let inFlight = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const schedule = () => {
    if (disposed || inFlight || timer !== null || !pending) return;
    const delay = Math.max(0, interval - (Date.now() - lastStartedAt));
    timer = setTimeout(() => {
      timer = null;
      if (disposed || inFlight || !pending) return;
      pending = false;
      inFlight = true;
      lastStartedAt = Date.now();
      const snapshot = new Map(quoteOverrides);
      Promise.resolve()
        .then(() => onRefresh(snapshot))
        .catch(() => {
          // A background refresh failure must not stop the live subscription.
        })
        .finally(() => {
          inFlight = false;
          if (pending) schedule();
        });
    }, delay);
  };

  let unsubscribe: () => void;
  try {
    unsubscribe = dataProvider.subscribeQuotes(targets, (target, quote) => {
      if (disposed) return;
      const key = chartQuoteOverrideKeyForTarget(target);
      const previous = quoteOverrides.get(key);
      if (!subscribedKeys.has(key) || !isNewerQuote(quote, previous)) return;
      quoteOverrides.set(key, quote);
      // receivedAt-only updates keep freshness metadata current without
      // rebuilding unchanged series, studies, and chart bitmaps.
      if (!hasResolutionRelevantChange(quote, previous)) return;
      pending = true;
      schedule();
    });
  } catch {
    disposed = true;
    pending = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    return () => {};
  }

  return () => {
    if (disposed) return;
    disposed = true;
    pending = false;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    try {
      unsubscribe();
    } catch {
      // Cleanup remains idempotent even if a provider has already torn down.
    }
  };
}
