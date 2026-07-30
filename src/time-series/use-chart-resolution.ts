import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChartResolveCache,
  resolveChartSpecData,
  type ChartResolveOptions,
  type ChartResolveSources,
} from "./resolve";
import type { ChartResolutionResult, ChartSpec } from "./types";
import {
  LIVE_CHART_REFRESH_INTERVAL_MS,
  liveChartQuoteTargetSignature,
  subscribeToLiveChartQuotes,
} from "./live-quotes";
import type { Quote } from "../types/financials";

export interface UseChartResolutionResult extends ChartResolutionResult {
  reload: () => void;
}

export interface UseChartResolutionOptions {
  liveRefreshIntervalMs?: number;
  autoViewport?: ChartResolveOptions["autoViewport"];
  requestViewport?: ChartResolveOptions["requestViewport"];
  targetPointCount?: number;
}

const EMPTY_RESULT: ChartResolutionResult = {
  series: [],
  loading: false,
  errors: [],
  warnings: [],
};

function hasRenderableData(result: ChartResolutionResult): boolean {
  return (result.bufferedSeries ?? result.series).some((series) => series.points.length > 0);
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
  const [result, setResult] = useState<ChartResolutionResult>(EMPTY_RESULT);
  const resultRef = useRef(result);
  resultRef.current = result;
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
  const resolveOptions: ChartResolveOptions = {
    autoViewport: validAutoViewport,
    requestViewport: validRequestViewport,
    targetPointCount: adaptiveTargetPointCount,
  };
  const latestRequestRef = useRef({ spec, sources, options: resolveOptions });
  latestRequestRef.current = { spec, sources, options: resolveOptions };
  const reload = useCallback(() => setRevision((current) => current + 1), []);

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const cacheIdentity = cacheIdentityRef.current;
    const resetCache = cacheIdentity.spec !== spec
      || cacheIdentity.sources !== sources
      || cacheIdentity.revision !== revision;
    if (resetCache) {
      resolveCacheRef.current = new ChartResolveCache();
      cacheIdentityRef.current = { spec, sources, revision };
    }
    const cache = resolveCacheRef.current;
    const current = resultRef.current;
    const backgroundRefresh = !resetCache
      && !current.loading
      && hasRenderableData(current);
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
  useEffect(() => {
    const subscriptionGeneration = ++liveSubscriptionGenerationRef.current;
    liveQuoteOverridesRef.current = new Map();
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
              request.options.autoViewport
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
  }, [liveRefreshIntervalMs, liveTargetSignature, sources.dataProvider]);

  return { ...result, reload };
}
