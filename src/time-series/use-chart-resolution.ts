import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  ChartResolveCache,
  resolveChartSpecData,
  seedChartResolutionResult,
  type ChartResolveOptions,
  type ChartResolveSources,
} from "./resolve";
import type { ChartResolutionResult, ChartSpec } from "./types";
import {
  LIVE_CHART_REFRESH_INTERVAL_MS,
  chartQuoteOverrideKeyForSource,
  liveChartQuoteTargetSignature,
  subscribeToLiveChartQuotes,
} from "./live-quotes";
import type { PricePoint, Quote } from "../types/financials";
import { createBaselineChartRequest } from "../market-data/coordinator/chart";
import { getSharedMarketDataCoordinator } from "../market-data/coordinator";
import { resolveEntryData } from "../market-data/selectors";
import { isMarketFieldId } from "./field-catalog";
import { getPresetResolution } from "./resolution";
import {
  parsedPriceHistoryKey,
  readParsedPriceHistory,
} from "./parsed-history-cache";

export interface UseChartResolutionResult extends ChartResolutionResult {
  reload: () => void;
}

export interface UseChartResolutionOptions {
  liveRefreshIntervalMs?: number;
  liveStreaming?: boolean;
  quotePollingIntervalMs?: number;
  autoViewport?: ChartResolveOptions["autoViewport"];
  requestViewport?: ChartResolveOptions["requestViewport"];
  targetPointCount?: number;
  currentResolution?: ChartResolveOptions["currentResolution"];
}

const DEFAULT_QUOTE_POLL_INTERVAL_MS = 60_000;

const EMPTY_RESULT: ChartResolutionResult = {
  series: [],
  loading: false,
  errors: [],
  warnings: [],
};

function hasRenderableData(result: ChartResolutionResult): boolean {
  return (result.bufferedSeries ?? result.series).some((series) => series.points.length > 0);
}

function collectSeedHistory(spec: ChartSpec): Map<string, PricePoint[]> {
  const history = new Map<string, PricePoint[]>();
  const coordinator = getSharedMarketDataCoordinator();
  for (const series of spec.series) {
    if (series.source.kind !== "security" || !isMarketFieldId(series.source.fieldId)) continue;
    const source = series.source;
    const key = chartQuoteOverrideKeyForSource(source);
    if (history.has(key)) continue;
    const symbol = source.instrument.symbol;
    const exchange = source.instrument.exchange ?? "";
    const baseline = createBaselineChartRequest(source.instrument);
    const presetResolution = spec.viewport.resolution === "auto"
      ? getPresetResolution(spec.viewport.range)
      : spec.viewport.resolution;
    const remembered = readParsedPriceHistory(parsedPriceHistoryKey(symbol, exchange, baseline.bufferRange, baseline.resolution))
      ?? readParsedPriceHistory(parsedPriceHistoryKey(symbol, exchange, spec.viewport.range, presetResolution))
      ?? readParsedPriceHistory(parsedPriceHistoryKey(symbol, exchange, baseline.bufferRange, presetResolution));
    if (remembered?.length) {
      history.set(key, remembered);
      continue;
    }
    if (!coordinator) continue;
    const entry = coordinator.getChartEntry(baseline);
    const data = resolveEntryData(entry);
    if (data?.length) history.set(key, data);
  }
  return history;
}

function withQuoteOverrides(
  sources: ChartResolveSources,
  liveOverrides: ReadonlyMap<string, Quote>,
): ChartResolveSources {
  if (liveOverrides.size === 0) return sources;
  if (!sources.quoteOverrides || sources.quoteOverrides.size === 0) {
    return { ...sources, quoteOverrides: liveOverrides };
  }
  const combined = new Map(sources.quoteOverrides);
  for (const [key, quote] of liveOverrides) combined.set(key, quote);
  return { ...sources, quoteOverrides: combined };
}

export function useChartResolution(
  spec: ChartSpec,
  sources: ChartResolveSources,
  options: UseChartResolutionOptions = {},
): UseChartResolutionResult {
  const coordinator = getSharedMarketDataCoordinator();
  const [result, setResult] = useState<ChartResolutionResult>(
    () => seedChartResolutionResult(spec, collectSeedHistory(spec)) ?? EMPTY_RESULT,
  );
  const needsSeed = !hasRenderableData(result);
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
    ? seedChartResolutionResult(spec, collectSeedHistory(spec))
    : null;
  const displayed = hasRenderableData(result) ? result : (seeded ?? result);
  const resultRef = useRef(displayed);
  resultRef.current = displayed;
  const [revision, setRevision] = useState(0);
  const generationRef = useRef(0);
  const liveSubscriptionGenerationRef = useRef(0);
  const liveQuoteOverridesRef = useRef<ReadonlyMap<string, Quote>>(new Map());
  const resolveCacheRef = useRef(new ChartResolveCache());
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
  const resolveOptions: ChartResolveOptions = {
    autoViewport: validAutoViewport,
    requestViewport: validRequestViewport,
    targetPointCount: adaptiveTargetPointCount,
    currentResolution,
  };
  const latestRequestRef = useRef({ spec, sources, options: resolveOptions });
  latestRequestRef.current = { spec, sources, options: resolveOptions };
  const reload = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
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
    const current = resultRef.current;
    const backgroundRefresh = hasRenderableData(current) && !isExplicitReload;
    if (!backgroundRefresh) {
      setResult((currentResult) => ({ ...currentResult, loading: true, errors: [] }));
    }
    resolveChartSpecData(
      spec,
      withQuoteOverrides(sources, liveQuoteOverridesRef.current),
      cache,
      resolveOptions,
    )
      .then((next) => {
        if (generationRef.current !== generation) return;
        if (backgroundRefresh && !hasRenderableData(next)) return;
        setResult(next);
      })
      .catch((error) => {
        if (generationRef.current !== generation) return;
        if (backgroundRefresh) return;
        setResult({
          series: [],
          loading: false,
          errors: [error instanceof Error ? error.message : String(error)],
          warnings: [],
        });
      });
    return () => {
      if (generationRef.current === generation) generationRef.current += 1;
    };
  }, [
    adaptiveTargetPointCount,
    autoViewportEnd,
    autoViewportStart,
    requestViewportEnd,
    requestViewportStart,
    revision,
    sources,
    spec,
  ]);

  const liveTargetSignature = liveChartQuoteTargetSignature(spec);
  const liveRefreshIntervalMs = options.liveRefreshIntervalMs ?? LIVE_CHART_REFRESH_INTERVAL_MS;
  const liveStreaming = options.liveStreaming !== false;
  useEffect(() => {
    const subscriptionGeneration = ++liveSubscriptionGenerationRef.current;
    liveQuoteOverridesRef.current = new Map();
    if (!liveStreaming) return;
    const dispose = subscribeToLiveChartQuotes({
      spec,
      dataProvider: sources.dataProvider,
      refreshIntervalMs: liveRefreshIntervalMs,
      onRefresh: async (quoteOverrides) => {
        if (liveSubscriptionGenerationRef.current !== subscriptionGeneration) return;
        liveQuoteOverridesRef.current = quoteOverrides;
        const request = latestRequestRef.current;
        const generation = ++generationRef.current;
        try {
          const next = await resolveChartSpecData(
            request.spec,
            withQuoteOverrides(request.sources, quoteOverrides),
            resolveCacheRef.current,
            request.options,
          );
          if (
            liveSubscriptionGenerationRef.current === subscriptionGeneration
            && generationRef.current === generation
          ) {
            setResult((current) => (
              (request.options.autoViewport || request.options.requestViewport)
              && !current.loading
              && hasRenderableData(current)
              && !hasRenderableData(next)
                ? current
                : next
            ));
          }
        } catch (error) {
          if (
            liveSubscriptionGenerationRef.current !== subscriptionGeneration
            || generationRef.current !== generation
          ) return;
          setResult((current) => ({
            ...current,
            loading: false,
            errors: [error instanceof Error ? error.message : String(error)],
          }));
        }
      },
    });
    return () => {
      dispose();
      if (liveSubscriptionGenerationRef.current === subscriptionGeneration) {
        liveSubscriptionGenerationRef.current += 1;
        liveQuoteOverridesRef.current = new Map();
      }
    };
  }, [liveRefreshIntervalMs, liveStreaming, liveTargetSignature, sources.dataProvider]);

  const quotePollingIntervalMs = options.quotePollingIntervalMs ?? DEFAULT_QUOTE_POLL_INTERVAL_MS;
  useEffect(() => {
    if (liveStreaming || !liveTargetSignature) return;
    setRevision((current) => current + 1);
    const intervalId = setInterval(() => {
      setRevision((current) => current + 1);
    }, quotePollingIntervalMs);
    return () => clearInterval(intervalId);
  }, [liveStreaming, liveTargetSignature, quotePollingIntervalMs]);

  return { ...displayed, reload };
}
