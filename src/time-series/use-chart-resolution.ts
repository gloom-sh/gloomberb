import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  ChartResolveCache,
  chartSeedResolution,
  reconcileChartTail,
  resolveChartSpecData,
  seedChartResolutionResult,
  type ChartResolveOptions,
  type ChartResolveSources,
} from "./resolve";
import type { ChartResolutionResult, ChartSpec } from "./types";
import {
  chartQuoteOverrideKeyForSource,
  createLiveChartRefresher,
  getLiveChartQuoteTargets,
  liveChartQuoteTargetSignature,
  observeLiveChartQuotes,
} from "./live-quotes";
import type { PricePoint, Quote } from "../types/financials";
import type { PriceHistoryResult } from "../types/price-history";
import type { InstrumentRef } from "../market-data/request-types";
import { getSharedMarketDataCoordinator } from "../market-data/coordinator";
import { resolveEntryData } from "../market-data/selectors";
import { usePaneVisible } from "../state/app/activity";
import { DEFAULT_QUOTE_POLL_INTERVAL_MS, useQuoteUpdates } from "../state/hooks/quote-streaming";
import { isMarketFieldId } from "./field-catalog";
import { CHART_RESOLUTION_STEP_MS, getNextBufferRange, isIntradayResolution, type ManualChartResolution } from "./resolution";
import { normalizeHistoryResult } from "../sources/history-result";
import { publicListingTarget } from "../sources/listing-target";
import { isPriceHistoryStaleForCurrentWindow, normalizePriceHistory } from "../utils/price-history";
import {
  parsedPriceHistoryKey,
  readParsedHistoryResult,
} from "./parsed-history-cache";

export interface UseChartResolutionResult extends ChartResolutionResult {
  reload: () => void;
}

export interface UseChartResolutionOptions {
  snapshot?: ChartResolutionResult | null;
  /**
   * Minimum spacing between live redraws. Live updates otherwise follow the
   * shared quote cadence; terminals pass LIVE_CHART_TERMINAL_FRAME_MS.
   */
  liveRefreshIntervalMs?: number;
  /** Off: quotes refresh on a shared poll instead of the stream. */
  liveStreaming?: boolean;
  /** The chart has the user's attention, so its quotes stream at selected priority. */
  selected?: boolean;
  quotePollingIntervalMs?: number;
  autoViewport?: ChartResolveOptions["autoViewport"];
  requestViewport?: ChartResolveOptions["requestViewport"];
  targetPointCount?: number;
  currentResolution?: ChartResolveOptions["currentResolution"];
}

/** Provider bars settle a few seconds after their boundary. */
const TAIL_RECONCILE_SETTLE_MS = 5_000;
/** Recent-window refreshes stay at least this far apart, whatever the bar size. */
const TAIL_RECONCILE_MIN_SPACING_MS = 30_000;
/** Broker history endpoints are paced per account. */
const BROKER_TAIL_RECONCILE_MIN_SPACING_MS = 120_000;
/** A window that keeps settling nothing is requested ever less often, down to this. */
const TAIL_RECONCILE_MAX_SPACING_MS = 10 * 60_000;
/** Points compared at each end of a series after a live pass that loaded no source data. */
const LIVE_COMPARE_EDGE_POINTS = 8;
/** A moving viewport end below this is invisible at any bar size. */
const VIEWPORT_SLIDE_TOLERANCE_MS = 1_000;

const EMPTY_RESULT: ChartResolutionResult = {
  series: [],
  loading: false,
  errors: [],
  warnings: [],
};

function hasRenderableData(result: ChartResolutionResult): boolean {
  return (result.bufferedSeries ?? result.series).some((series) => series.points.length > 0);
}

function seedWindowIsCurrent(spec: ChartSpec, now: number, options: ChartResolveOptions): boolean {
  const requestStart = options.requestViewport?.start.getTime();
  const requestEnd = options.requestViewport?.end.getTime();
  if (typeof requestStart === "number" && Number.isFinite(requestStart)
    && typeof requestEnd === "number" && Number.isFinite(requestEnd) && requestStart <= requestEnd) {
    return now - (requestEnd + 1) < 3_600_000;
  }
  const window = spec.viewport.dateWindow;
  if (!window) return true;
  const start = Date.parse(window.start);
  const end = Date.parse(window.end) + (/^\d{4}-\d{2}-\d{2}$/.test(window.end.trim()) ? 86_400_000 - 1 : 0);
  return !Number.isFinite(start) || !Number.isFinite(end) || start > end || now - (end + 1) < 3_600_000;
}

function freshSeedPoints(
  value: PriceHistoryResult | undefined, instrument: InstrumentRef,
  resolution: ManualChartResolution, now: number, currentWindow: boolean,
): PricePoint[] | null {
  if (!value || (value.resolution !== null && value.resolution !== resolution)) return null;
  const target = publicListingTarget(instrument.symbol, instrument.exchange);
  const result = normalizeHistoryResult(value, { symbol: target.symbol, exchange: target.exchange ?? "" });
  if (!result) return null;
  const points = normalizePriceHistory(result.points);
  // Broker contract/session interpretation remains unproven, as at acquisition.
  const session = instrument.instrument ? undefined : result.session;
  if (currentWindow && isIntradayResolution(resolution) && isPriceHistoryStaleForCurrentWindow(points, now, {
    exchange: target.exchange, intervalMs: CHART_RESOLUTION_STEP_MS[resolution], session,
  })) return null;
  return points.length ? points : null;
}

function collectSeedHistory(spec: ChartSpec, now: Date, options: ChartResolveOptions): Map<string, PricePoint[]> {
  const history = new Map<string, PricePoint[]>();
  const coordinator = getSharedMarketDataCoordinator();
  const resolution = chartSeedResolution(spec, now, options);
  const currentWindow = seedWindowIsCurrent(spec, now.getTime(), options);
  const ranges = [...new Set([spec.viewport.range, getNextBufferRange(spec.viewport.range), "ALL"] as const)];
  for (const series of spec.series) {
    if (series.source.kind !== "security" || !isMarketFieldId(series.source.fieldId)) continue;
    const source = series.source;
    const key = chartQuoteOverrideKeyForSource(source);
    if (history.has(key)) continue;
    // Cached bars retain their acquisition cadence. An ALL/weekly baseline
    // cannot supply daily prices, volume or study inputs under daily controls.
    for (const range of ranges) {
      const parsed = readParsedHistoryResult(parsedPriceHistoryKey(source.instrument, range, resolution));
      let data = freshSeedPoints(parsed, source.instrument, resolution, now.getTime(), currentWindow);
      if (!data && coordinator) {
        const entry = coordinator.getChartEntry({ instrument: source.instrument, bufferRange: range,
          granularity: "resolution", resolution });
        const points = resolveEntryData(entry);
        if (points) data = freshSeedPoints({ ...entry.history, points, resolution: entry.history?.resolution ?? null },
          source.instrument, resolution, now.getTime(), currentWindow);
      }
      if (data?.length) {
        history.set(key, data);
        break;
      }
    }
  }
  return history;
}

function withQuoteOverrides(
  sources: ChartResolveSources,
  liveOverrides: ReadonlyMap<string, Quote>,
  liveSince: number | undefined,
): ChartResolveSources {
  const live = liveSince === undefined ? sources : { ...sources, liveSince };
  if (liveOverrides.size === 0) return live;
  if (!sources.quoteOverrides || sources.quoteOverrides.size === 0) {
    return { ...live, quoteOverrides: liveOverrides };
  }
  const combined = new Map(sources.quoteOverrides);
  for (const [key, quote] of liveOverrides) combined.set(key, quote);
  return { ...live, quoteOverrides: combined };
}

/**
 * Structural equality over plain chart data. Arrays compare from the end, where
 * live changes land. With `edge`, longer arrays compare only that many items at
 * each end: the caller knows nothing in between can have changed.
 */
function sameChartData(left: unknown, right: unknown, edge = Number.POSITIVE_INFINITY): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime());
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const length = left.length;
    const bounded = length > 2 * edge;
    for (let index = length - 1; index >= (bounded ? length - edge : 0); index -= 1) {
      if (!sameChartData(left[index], right[index], edge)) return false;
    }
    for (let index = 0; bounded && index < edge; index += 1) {
      if (!sameChartData(left[index], right[index], edge)) return false;
    }
    return true;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every((key) => Object.hasOwn(rightRecord, key) && sameChartData(leftRecord[key], rightRecord[key], edge));
}

/** A live pass that produced the same chart must not re-render it. */
function sameChartResolution(current: ChartResolutionResult, next: ChartResolutionResult, edge?: number): boolean {
  const { viewport: currentViewport, ...currentRest } = current;
  const { viewport: nextViewport, ...nextRest } = next;
  if (!currentViewport !== !nextViewport) return false;
  if (currentViewport && nextViewport && (
    Math.abs(currentViewport.start.getTime() - nextViewport.start.getTime()) >= VIEWPORT_SLIDE_TOLERANCE_MS
    || Math.abs(currentViewport.end.getTime() - nextViewport.end.getTime()) >= VIEWPORT_SLIDE_TOLERANCE_MS
  )) return false;
  return sameChartData(currentRest, nextRest, edge);
}

function latestMarketBarTime(result: ChartResolutionResult): number {
  let latest = Number.NaN;
  for (const series of result.bufferedSeries ?? result.series) {
    if (series.observationKind !== "market") continue;
    const time = series.points.at(-1)?.date.getTime();
    if (time !== undefined && Number.isFinite(time) && !(time <= latest)) latest = time;
  }
  return latest;
}

export function useChartResolution(
  spec: ChartSpec,
  sources: ChartResolveSources,
  options: UseChartResolutionOptions = {},
): UseChartResolutionResult {
  const snapshot = options.snapshot;
  const coordinator = getSharedMarketDataCoordinator();
  const specKey = JSON.stringify(spec);
  const seedResult = () => {
    const now = sources.now ?? new Date();
    return seedChartResolutionResult(spec, collectSeedHistory(spec, now, options), now, options);
  };
  const [state, setState] = useState(() => ({
    key: specKey,
    result: snapshot ?? seedResult() ?? EMPTY_RESULT,
  }));
  // A selected range, listing or transform owns its displayed data. A pending
  // request must not keep another specification's result under the new controls.
  const result = state.key === specKey ? state.result : EMPTY_RESULT;
  // A seed bridges an in-flight request. Once that request settles, an empty
  // or failed result must not be replaced with a fresh loading seed forever.
  const needsSeed = !snapshot && !hasRenderableData(result)
    && (state.key !== specKey || result.loading);
  const subscribeSeed = useCallback((listener: () => void) => {
    if (!needsSeed || !coordinator) return () => {};
    return coordinator.subscribe(listener);
  }, [coordinator, needsSeed]);
  const getSeedSnapshot = useCallback(() => {
    if (!needsSeed || !coordinator) return 0;
    return coordinator.getVersion();
  }, [coordinator, needsSeed]);
  useSyncExternalStore(subscribeSeed, getSeedSnapshot, () => 0);
  const seeded = needsSeed
    ? seedResult()
    : null;
  const displayed = hasRenderableData(result) ? result : (seeded ?? result);
  const resultRef = useRef(displayed);
  resultRef.current = displayed;
  const [revision, setRevision] = useState(0);
  // Bumped when a chart painted with the placeholder interval list and the
  // real one has since landed. Unlike a reload it keeps the cache, so the
  // pass only re-picks Auto and refreshes the interval tabs.
  const [supportRevision, setSupportRevision] = useState(0);
  const generationRef = useRef(0);
  const liveSubscriptionGenerationRef = useRef(0);
  const liveQuoteOverridesRef = useRef<ReadonlyMap<string, Quote>>(new Map());
  const liveSinceRef = useRef<number | undefined>(undefined);
  // Quote changes seen, and the latest ones any resolve has started with.
  const liveQuoteVersionRef = useRef(0);
  const resolvedQuoteVersionRef = useRef(0);
  const resolveCacheRef = useRef(new ChartResolveCache());
  // The cache revision each result is known to show. Only a result built from
  // the same source data can be compared by its newest points alone.
  const resultRevisionsRef = useRef(new WeakMap<ChartResolutionResult, { cache: ChartResolveCache; revision: number }>());
  const cacheIdentityRef = useRef<{
    spec: ChartSpec | null;
    sources: ChartResolveSources | null;
    revision: number;
  }>({ spec: null, sources: null, revision: -1 });
  const autoViewportStart = options.autoViewport?.start.getTime();
  const autoViewportEnd = options.autoViewport?.end.getTime();
  const validAutoViewport = typeof autoViewportStart === "number"
      && Number.isFinite(autoViewportStart)
      && typeof autoViewportEnd === "number"
      && Number.isFinite(autoViewportEnd)
      && autoViewportStart <= autoViewportEnd
    ? { start: new Date(autoViewportStart), end: new Date(autoViewportEnd) }
    : null;
  const requestViewportStart = options.requestViewport?.start.getTime();
  const requestViewportEnd = options.requestViewport?.end.getTime();
  const validRequestViewport = typeof requestViewportStart === "number"
      && Number.isFinite(requestViewportStart)
      && typeof requestViewportEnd === "number"
      && Number.isFinite(requestViewportEnd)
      && requestViewportStart <= requestViewportEnd
    ? { start: new Date(requestViewportStart), end: new Date(requestViewportEnd) }
    : null;
  const adaptiveTargetPointCount = validAutoViewport ? options.targetPointCount : undefined;
  // Read at resolve time only: hysteresis breaks ties when the viewport moves,
  // and echoing the chosen resolution back must not trigger another resolve.
  const currentResolution = validAutoViewport ? options.currentResolution ?? null : null;
  const onResolutionSupportSettled = useCallback(() => setSupportRevision((current) => current + 1), []);
  const resolveOptions: ChartResolveOptions = {
    autoViewport: validAutoViewport,
    requestViewport: validRequestViewport,
    targetPointCount: adaptiveTargetPointCount,
    currentResolution,
    onResolutionSupportSettled,
  };
  const latestRequestRef = useRef({ spec, sources, options: resolveOptions });
  latestRequestRef.current = { spec, sources, options: resolveOptions };
  const reload = useCallback(() => setRevision((current) => current + 1), []);

  // A covered chart keeps its quotes arriving at the off-screen cadence but
  // builds no live bars; coming back into view catches up from the store.
  const paneVisible = usePaneVisible();
  const liveTargetSignature = liveChartQuoteTargetSignature(spec);
  const selected = options.selected === true;
  const liveTargets = useMemo(
    () => snapshot ? [] : getLiveChartQuoteTargets(spec, { selected, visible: paneVisible }),
    // The signature is the targets' identity; a new spec object alone must not resubscribe.
    [snapshot, liveTargetSignature, paneVisible, selected],
  );
  const liveStreaming = options.liveStreaming !== false;
  const quotePollingIntervalMs = options.quotePollingIntervalMs ?? DEFAULT_QUOTE_POLL_INTERVAL_MS;
  // One deduplicated stream shared by every pane feeds the quote store; with
  // streaming off, the shared quote poll does. Both pause while the app is hidden.
  useQuoteUpdates(liveTargets, { liveStreaming, pollIntervalMs: quotePollingIntervalMs });

  const liveFrameMs = Math.max(0, options.liveRefreshIntervalMs ?? 0);
  const liveKey = !snapshot && paneVisible && coordinator && liveTargetSignature ? liveTargetSignature : null;
  // Declared before the resolve effect so a first resolve already carries the stored quotes.
  useEffect(() => {
    if (liveKey === null || !coordinator) return;
    const subscriptionGeneration = ++liveSubscriptionGenerationRef.current;
    const liveSince = Date.now();
    // Freshly loaded history needs no refresh; after a pause it is behind.
    const resumed = resolvedQuoteVersionRef.current > 0;
    liveSinceRef.current = liveSince;
    liveQuoteOverridesRef.current = new Map();
    let disposed = false;
    let forced = false;
    let quoteActivityAt = 0;
    let lastReconcileAt = resumed ? Number.NEGATIVE_INFINITY : liveSince;
    let unchangedReconciles = 0;
    let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    let reconcileDue = Number.NaN;

    const resolveLive = async () => {
      if (disposed || liveSubscriptionGenerationRef.current !== subscriptionGeneration) return;
      // A resolve that already started with these quotes covers this request.
      if (!forced && resolvedQuoteVersionRef.current === liveQuoteVersionRef.current) return;
      forced = false;
      resolvedQuoteVersionRef.current = liveQuoteVersionRef.current;
      const request = latestRequestRef.current;
      const cache = resolveCacheRef.current;
      const dataRevision = cache.revision;
      const generation = ++generationRef.current;
      const current = () => !disposed
        && liveSubscriptionGenerationRef.current === subscriptionGeneration
        && generationRef.current === generation;
      try {
        const next = await resolveChartSpecData(
          request.spec,
          withQuoteOverrides(request.sources, liveQuoteOverridesRef.current, liveSince),
          cache,
          request.options,
        );
        if (!current()) return;
        const requestKey = JSON.stringify(request.spec);
        // A pass that brought in no source data changed at most the newest points.
        const settled = cache.revision === dataRevision;
        const revisions = resultRevisionsRef.current;
        if (settled) revisions.set(next, { cache, revision: dataRevision });
        setState((state) => {
          if (state.key !== requestKey) return { key: requestKey, result: next };
          if ((request.options.autoViewport || request.options.requestViewport)
            && !state.result.loading
            && hasRenderableData(state.result)
            && !hasRenderableData(next)) return state;
          const shown = revisions.get(state.result);
          const edge = settled && shown?.cache === cache && shown.revision === dataRevision ? LIVE_COMPARE_EDGE_POINTS : undefined;
          if (!sameChartResolution(state.result, next, edge)) return { key: requestKey, result: next };
          if (settled) revisions.set(state.result, { cache, revision: dataRevision });
          return state;
        });
      } catch (error) {
        if (!current()) return;
        const requestKey = JSON.stringify(request.spec);
        setState((state) => state.key !== requestKey ? state : ({
          ...state,
          result: {
            ...state.result,
            loading: false,
            errors: [error instanceof Error ? error.message : String(error)],
          },
        }));
      } finally {
        if (!disposed) scheduleReconcile(cache.takeTailReconcileRequest());
      }
    };
    const refresher = createLiveChartRefresher(resolveLive, liveFrameMs);

    // Intraday bars formed from quotes settle to the provider's bars shortly
    // after each boundary. Only the recent window is requested, and a quiet
    // market with no new quotes requests nothing.
    const runReconcile = async () => {
      reconcileTimer = null;
      reconcileDue = Number.NaN;
      if (disposed || quoteActivityAt <= lastReconcileAt) return;
      lastReconcileAt = Date.now();
      const changed = await reconcileChartTail(latestRequestRef.current.sources, resolveCacheRef.current)
        .catch(() => false);
      if (disposed) return;
      if (!changed) {
        // A window that settles nothing, or that this history cannot take, is not asked for again at once.
        unchangedReconciles += 1;
        scheduleReconcile(false);
        return;
      }
      unchangedReconciles = 0;
      forced = true;
      refresher.request();
    };
    function scheduleReconcile(soon: boolean) {
      const resolution = resultRef.current.resolution;
      if (disposed || !resolution || !isIntradayResolution(resolution) || quoteActivityAt <= lastReconcileAt) return;
      const step = CHART_RESOLUTION_STEP_MS[resolution];
      const now = Date.now();
      const latestBar = latestMarketBarTime(resultRef.current);
      const boundary = Number.isFinite(latestBar)
        ? latestBar + (Math.max(0, Math.floor((now - latestBar) / step)) + 1) * step
        : Math.ceil(now / step) * step;
      const spacing = Math.min(TAIL_RECONCILE_MAX_SPACING_MS, 2 ** Math.min(unchangedReconciles, 8)
        * (resolveCacheRef.current.liveTailsUseBroker ? BROKER_TAIL_RECONCILE_MIN_SPACING_MS : TAIL_RECONCILE_MIN_SPACING_MS));
      const due = Math.max(
        soon ? now : boundary + TAIL_RECONCILE_SETTLE_MS,
        lastReconcileAt + spacing,
      );
      if (reconcileTimer !== null && due >= reconcileDue) return;
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      reconcileDue = due;
      reconcileTimer = setTimeout(() => void runReconcile(), Math.max(0, due - now));
    }

    const stopQuotes = observeLiveChartQuotes({
      spec: latestRequestRef.current.spec,
      store: coordinator,
      onChange: (quoteOverrides) => {
        liveQuoteOverridesRef.current = quoteOverrides;
        liveQuoteVersionRef.current += 1;
        quoteActivityAt = Date.now();
        refresher.request();
      },
    });

    return () => {
      disposed = true;
      stopQuotes();
      refresher.dispose();
      if (reconcileTimer !== null) clearTimeout(reconcileTimer);
      if (liveSubscriptionGenerationRef.current === subscriptionGeneration) {
        liveSubscriptionGenerationRef.current += 1;
        liveSinceRef.current = undefined;
      }
    };
  }, [coordinator, liveFrameMs, liveKey, sources]);

  useEffect(() => {
    if (snapshot) return;
    generationRef.current += 1;
    const generation = generationRef.current;
    const cacheIdentity = cacheIdentityRef.current;
    const isExplicitReload = cacheIdentity.revision !== revision && cacheIdentity.revision !== -1;
    const resetCache = cacheIdentity.sources !== sources || isExplicitReload;
    if (resetCache) {
      resolveCacheRef.current = new ChartResolveCache();
    }
    cacheIdentityRef.current = { spec, sources, revision };
    const cache = resolveCacheRef.current;
    const dataRevision = cache.revision;
    const current = resultRef.current;
    const backgroundRefresh = state.key === specKey && hasRenderableData(current) && !current.loading && !isExplicitReload;
    if (!backgroundRefresh) {
      setState({ key: specKey, result: { ...current, loading: true, errors: [] } });
    }
    resolvedQuoteVersionRef.current = liveQuoteVersionRef.current;
    resolveChartSpecData(
      spec,
      withQuoteOverrides(sources, liveQuoteOverridesRef.current, liveSinceRef.current),
      cache,
      resolveOptions,
    )
      .then((next) => {
        if (generationRef.current !== generation) return;
        if (backgroundRefresh && !hasRenderableData(next)) return;
        if (cache.revision === dataRevision) resultRevisionsRef.current.set(next, { cache, revision: dataRevision });
        setState({ key: specKey, result: next });
      })
      .catch((error) => {
        if (generationRef.current !== generation) return;
        if (backgroundRefresh) return;
        setState({ key: specKey, result: {
          ...current,
          loading: false,
          errors: [error instanceof Error ? error.message : String(error)],
        } });
      });
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [
    snapshot,
    adaptiveTargetPointCount,
    autoViewportEnd,
    autoViewportStart,
    requestViewportEnd,
    requestViewportStart,
    revision,
    sources,
    specKey,
    supportRevision,
  ]);

  return { ...(snapshot ?? displayed), reload };
}
