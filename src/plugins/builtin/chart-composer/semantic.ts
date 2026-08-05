import type { UseChartResolutionResult } from "../../../time-series/use-chart-resolution";
import type { ChartSeriesSpec, ChartSpec, TimeSeriesPoint } from "../../../time-series/types";
import { publicTickerKey } from "../../../utils/exchanges";

function pointValue(point: TimeSeriesPoint | undefined): number | null {
  const value = point?.value ?? point?.close;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pointEvidence(point: TimeSeriesPoint | undefined) {
  if (!point) return null;
  const date = point.date instanceof Date ? point.date : new Date(point.date);
  return Number.isFinite(date.getTime())
    ? { date: date.toISOString(), value: pointValue(point) }
    : null;
}

function viewportEvidence(viewport: UseChartResolutionResult["viewport"]) {
  if (!viewport) return null;
  return {
    start: viewport.start.toISOString(),
    end: viewport.end.toISOString(),
    spanMs: viewport.end.getTime() - viewport.start.getTime(),
  };
}

function sourceEvidence(series: ChartSeriesSpec) {
  return series.source.kind === "security"
    ? {
      sourceKind: "security",
      symbol: publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange),
      exchange: series.source.instrument.exchange ?? null,
      fieldId: series.source.fieldId,
      period: series.source.period ?? "auto",
      timestampMode: series.source.timestampMode ?? null,
    }
    : {
      sourceKind: "economic",
      provider: series.source.provider,
      economicSeriesId: series.source.seriesId,
    };
}

/** Stable semantic evidence used by desktop automation and bot-safe screenshots. */
export function chartComposerSemanticMetadata(
  spec: ChartSpec,
  resolution: UseChartResolutionResult,
  runtimeViewport?: { start: Date; end: Date } | null,
): Record<string, unknown> {
  const resolvedById = new Map(resolution.series.map((series) => [series.id, series] as const));
  const symbols = [...new Set(spec.series.flatMap((series) => (
    series.source.kind === "security"
      ? [publicTickerKey(series.source.instrument.symbol, series.source.instrument.exchange)]
      : []
  )))];
  const baseSeries = spec.series.map((series) => {
    const resolved = resolvedById.get(series.id);
    return {
      id: series.id,
      ...sourceEvidence(series),
      style: series.style,
      transform: series.transform,
      axis: resolved?.axis ?? series.axis,
      panelId: series.panelId,
      visible: series.visible !== false,
      pointCount: resolved?.points.length ?? 0,
      latestChangePercent: resolved?.latestChangePercent ?? null,
      first: pointEvidence(resolved?.points[0]),
      last: pointEvidence(resolved?.points.at(-1)),
    };
  });
  return {
    kind: "chart-composer",
    version: spec.version,
    symbols,
    rangePreset: spec.viewport.range,
    resolution: spec.viewport.resolution,
    dateWindow: spec.viewport.dateWindow ?? null,
    maxPoints: spec.viewport.maxPoints ?? null,
    loading: resolution.loading,
    errors: resolution.errors,
    warnings: resolution.warnings,
    resolutionSupport: resolution.resolutionSupport ?? null,
    viewport: viewportEvidence(runtimeViewport ?? resolution.viewport),
    authoredViewport: viewportEvidence(resolution.viewport),
    baseSeries,
    bufferedSeries: (resolution.bufferedSeries ?? []).map((series) => ({
      id: series.id,
      pointCount: series.points.length,
      first: pointEvidence(series.points[0]),
      last: pointEvidence(series.points.at(-1)),
    })),
    resolvedSeries: resolution.series.map((series) => ({
      id: series.id,
      label: series.label,
      style: series.style,
      transform: series.transform,
      axis: series.axis,
      panelId: series.panelId,
      timeBasis: series.timeBasis ?? null,
      pointCount: series.points.length,
      first: pointEvidence(series.points[0]),
      last: pointEvidence(series.points.at(-1)),
    })),
    projectedPointCount: Math.max(0, ...resolution.series.map((series) => series.points.length)),
  };
}
