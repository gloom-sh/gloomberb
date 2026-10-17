import type { ChartSpec, ResolvedSeries } from "../../../time-series/types";
import { CHART_SPEC_VERSION } from "../../../time-series/types";
import {
  DEFAULT_CHART_SPEC,
  MAX_CHART_SERIES,
  normalizeChartSpec,
  validateChartSpec,
} from "../../../time-series/spec";
import { isRecord } from "../../../utils/guards";

export const CHART_SPEC_SETTING_KEY = "chartSpec";
export const CHART_INTERACTION_VIEWPORT_SETTING_KEY = "chartInteractionViewport";
/** A shared link's pinned crosshair: the chart pins its tab there once on open, then drops it. */
export const CHART_PINNED_MOMENT_SETTING_KEY = "chartPinnedMoment";
/** The earliest history a chart reads (FRED series from 1900), and how far ahead one runs. */
const EARLIEST_SHARED_MOMENT = Date.UTC(1900, 0, 1);
const SHARED_MOMENT_LEAD_MS = 366 * 86_400_000;

/**
 * A link's pinned moment, read as untrusted: a time no earlier than the
 * oldest history a chart here shows and no later than a year from now, or
 * null for anything else (a string, a number past the Date range).
 */
export function parseSharedPinnedMoment(value: unknown, now = Date.now()): number | null {
  return typeof value === "number" && Number.isFinite(value)
    && value >= EARLIEST_SHARED_MOMENT && value <= now + SHARED_MOMENT_LEAD_MS ? value : null;
}
export const MAX_CHART_COMPOSER_SERIES = MAX_CHART_SERIES;

export interface ChartInteractionViewport {
  authoredViewportKey: string;
  start: string;
  end: string;
  adaptive: boolean;
}

export function parseChartInteractionViewport(value: unknown): ChartInteractionViewport | null {
  if (!isRecord(value)) return null;
  if (!Object.keys(value).every((key) => ["authoredViewportKey", "start", "end", "adaptive"].includes(key))) return null;
  if (
    typeof value.authoredViewportKey !== "string"
    || value.authoredViewportKey.length === 0
    || value.authoredViewportKey.length > 16_384
    || typeof value.start !== "string"
    || typeof value.end !== "string"
    || typeof value.adaptive !== "boolean"
  ) return null;
  const start = Date.parse(value.start);
  const end = Date.parse(value.end);
  return Number.isFinite(start) && Number.isFinite(end) && start < end
    ? {
        authoredViewportKey: value.authoredViewportKey,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        adaptive: value.adaptive,
      }
    : null;
}

export function canToggleChartSeries(spec: ChartSpec, seriesId: string): boolean {
  const target = spec.series.find((series) => series.id === seriesId);
  if (!target) return false;
  if (target.visible === false) return true;
  return spec.series.filter((series) => series.visible !== false).length > 1;
}

export function toggleChartSeries(spec: ChartSpec, seriesId: string): ChartSpec {
  if (!canToggleChartSeries(spec, seriesId)) return spec;
  return {
    ...spec,
    series: spec.series.map((series) => series.id === seriesId
      ? { ...series, visible: series.visible === false }
      : series),
  };
}

/**
 * Project the latest resolved data through the authored visibility immediately.
 * Resolution continues in the background, but hiding/restoring a loaded base
 * series should not wait for another provider round trip.
 */
export function projectVisibleChartSeries(
  spec: ChartSpec,
  resolvedSeries: readonly ResolvedSeries[],
  legendSeries: readonly ResolvedSeries[] = [],
): ResolvedSeries[] {
  const baseIds = new Set(spec.series.map((series) => series.id));
  const resolvedById = new Map([
    ...legendSeries.map((series) => [series.id, series] as const),
    ...resolvedSeries.map((series) => [series.id, series] as const),
  ]);
  return [
    ...spec.series.flatMap((series) => {
      const resolved = series.visible === false ? undefined : resolvedById.get(series.id);
      return resolved ? [resolved] : [];
    }),
    ...resolvedSeries.filter((series) => !baseIds.has(series.id)),
  ];
}

function decodeSpec(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function canMigrateV1(decoded: Record<string, unknown>): boolean {
  return !Array.isArray(decoded.series) || decoded.series.every((entry) => {
    const source = isRecord(entry) && isRecord(entry.source) ? entry.source : null;
    return source?.kind === "security" || source?.kind === "economic";
  });
}

/** Parse, migrate, normalize, and semantically validate a persisted chart spec. */
export function parseChartSpec(value: unknown): ChartSpec | null {
  const decoded = decodeSpec(value);
  if (!isRecord(decoded)) return null;
  const version = decoded.version;
  if (version !== CHART_SPEC_VERSION && !((version === 1 || version === undefined) && canMigrateV1(decoded))) {
    return null;
  }
  const spec = normalizeChartSpec(decoded, DEFAULT_CHART_SPEC);
  return validateChartSpec(spec).valid ? spec : null;
}

export function parseChartSpecOr(value: unknown, fallback: ChartSpec): ChartSpec {
  if (
    isRecord(value)
    && value.version === CHART_SPEC_VERSION
    && Array.isArray(value.series)
    && Array.isArray(value.panels)
    && Array.isArray(value.studies)
  ) {
    const spec = value as unknown as ChartSpec;
    if (validateChartSpec(spec).valid) return spec;
  }
  return parseChartSpec(value) ?? normalizeChartSpec(fallback, DEFAULT_CHART_SPEC);
}

export function serializeChartSpec(spec: ChartSpec): string {
  const normalized = normalizeChartSpec(spec, DEFAULT_CHART_SPEC);
  const validation = validateChartSpec(normalized);
  if (!validation.valid) {
    throw new Error(validation.errors.map((entry) => entry.message).join(" "));
  }
  return JSON.stringify(normalized);
}
