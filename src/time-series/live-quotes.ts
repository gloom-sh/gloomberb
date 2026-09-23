import { canonicalTimeSeriesFieldId, isMarketFieldId } from "./field-catalog";
import type { QuoteSubscriptionTarget } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { ChartSeriesSpec, ChartSpec, SecuritySeriesSource } from "./types";
import { activeStudyInputSeriesIds } from "./studies";
import { valuationSeriesUsesLiveQuote } from "./fundamentals";
import { hasValidQuoteObservationTime } from "../market-data/quotes/freshness";
import type { InstrumentRef } from "../market-data/request-types";
import type { QueryEntry } from "../market-data/result-types";
import { buildQuoteKey, resolveEntryData } from "../market-data/selectors";
import { instrumentIdentityKey } from "../utils/instrument-identity";
import { LIVE_QUOTE_FUTURE_TOLERANCE_MS } from "./chart-data";

/**
 * A terminal chart re-rasterizes its whole bitmap for each redraw. It follows
 * the shared quote cadence but never redraws faster than this.
 */
export const LIVE_CHART_TERMINAL_FRAME_MS = 250;

export function chartQuoteOverrideKeyForSource(source: SecuritySeriesSource): string {
  return instrumentIdentityKey({
    symbol: source.instrument.symbol,
    exchange: source.instrument.exchange,
    brokerId: source.instrument.brokerId,
    brokerInstanceId: source.instrument.brokerInstanceId,
    instrument: source.instrument.instrument,
  });
}

export function chartQuoteOverrideKeyForTarget(target: QuoteSubscriptionTarget): string {
  return instrumentIdentityKey({
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
export function getLiveChartQuoteTargets(spec: ChartSpec, priority: { selected?: boolean } = {}): QuoteSubscriptionTarget[] {
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
      ...(priority.selected ? { selected: true } : {}),
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

/**
 * A malformed timestamp cannot outrank a usable source observation forever. A
 * stamp just ahead of the local clock is a clock difference, not a malformed one.
 */
export function compareChartQuoteRecency(next: Quote, current: Quote): number {
  const now = Date.now() + LIVE_QUOTE_FUTURE_TOLERANCE_MS;
  const sourceTime = (quote: Quote) => hasValidQuoteObservationTime(quote, now) ? quote.lastUpdated : -Infinity;
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

/** Every chart bar boundary, intraday or calendar, is a whole minute. */
const QUOTE_TIME_BUCKET_MS = 60_000;

function quoteTimeBucket(quote: Quote): number {
  return Number.isFinite(quote.lastUpdated) ? Math.floor(quote.lastUpdated / QUOTE_TIME_BUCKET_MS) : Number.NaN;
}

function hasResolutionRelevantChange(next: Quote, current: Quote | undefined): boolean {
  if (!current) return true;
  // Bid/ask updates restamp a quote many times a second without moving its
  // price or volume. The stamp alone matters only when it crosses into
  // another minute, where it can open a bar at the same price.
  return !Object.is(quoteTimeBucket(next), quoteTimeBucket(current))
    || next.price !== current.price
    || next.volume !== current.volume
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

/** The shared quote store, as exposed by the market data coordinator. */
export interface ChartQuoteStore {
  subscribeKeys(keys: readonly string[], listener: () => void): () => void;
  getQuoteEntry(instrument: InstrumentRef): QueryEntry<Quote>;
}

export interface LiveChartQuoteObserverOptions {
  spec: ChartSpec;
  store: ChartQuoteStore;
  /** Latest quote per chart instrument, after any change that affects the chart. */
  onChange: (quoteOverrides: ReadonlyMap<string, Quote>) => void;
}

function targetInstrument(target: QuoteSubscriptionTarget): InstrumentRef {
  return {
    symbol: target.symbol,
    exchange: target.exchange,
    brokerId: target.context?.brokerId,
    brokerInstanceId: target.context?.brokerInstanceId,
    instrument: target.context?.instrument ?? null,
  };
}

/**
 * Follows the chart's instruments in the shared quote store. The store is fed
 * by the one deduplicated stream every pane shares, so a chart opens no
 * connection of its own and updates at the same cadence as the rest of the app.
 * Receipt-only heartbeats keep freshness metadata current without rebuilding
 * unchanged series, studies and chart bitmaps.
 */
export function observeLiveChartQuotes({ spec, store, onChange }: LiveChartQuoteObserverOptions): () => void {
  const entries = getLiveChartQuoteTargets(spec).map((target) => ({
    key: chartQuoteOverrideKeyForTarget(target),
    instrument: targetInstrument(target),
  }));
  if (entries.length === 0) return () => {};
  const quoteOverrides = new Map<string, Quote>();
  let disposed = false;
  const read = () => {
    if (disposed) return;
    let changed = false;
    for (const { key, instrument } of entries) {
      const quote = resolveEntryData(store.getQuoteEntry(instrument));
      const previous = quoteOverrides.get(key);
      if (!quote || quote === previous || !isNewerQuote(quote, previous)) continue;
      quoteOverrides.set(key, quote);
      if (hasResolutionRelevantChange(quote, previous)) changed = true;
    }
    if (changed) onChange(new Map(quoteOverrides));
  };
  const unsubscribe = store.subscribeKeys(entries.map(({ instrument }) => buildQuoteKey(instrument)), read);
  read();
  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe();
  };
}

export interface LiveChartRefresher {
  /** Ask for a refresh; requests made while one runs collapse into one follow-up. */
  request: () => void;
  dispose: () => void;
}

/**
 * Serializes chart refreshes. A slow refresh has at most one follow-up queued,
 * which runs with the latest inputs, so a quote burst never fans out into
 * overlapping resolves. `minIntervalMs` spaces refresh starts on surfaces
 * where each redraw is expensive.
 */
export function createLiveChartRefresher(
  run: () => Promise<void> | void,
  minIntervalMs = 0,
): LiveChartRefresher {
  let disposed = false;
  let pending = false;
  let inFlight = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pump = () => {
    if (disposed || inFlight || !pending || timer !== null) return;
    const wait = lastStartedAt + minIntervalMs - Date.now();
    if (wait > 0) {
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, wait);
      return;
    }
    pending = false;
    inFlight = true;
    lastStartedAt = Date.now();
    Promise.resolve()
      .then(run)
      .catch(() => {
        // A background refresh failure must not stop live updates.
      })
      .finally(() => {
        inFlight = false;
        pump();
      });
  };
  return {
    request: () => {
      if (disposed) return;
      pending = true;
      pump();
    },
    dispose: () => {
      disposed = true;
      pending = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
