import type {
  CompositePanelScene,
  CompositeProjectedPoint,
  CompositeProjectedSeries,
} from "./types";

export interface CompositeColumnGroupSlot {
  index: number;
  count: number;
  xRatio: number;
  familyKey: string;
}

export interface CompositeColumnGroupCenter {
  xRatio: number;
  ordinal: number | null;
}

export interface CompositeColumnLayout {
  groupByPoint: ReadonlyMap<CompositeProjectedPoint, CompositeColumnGroupSlot>;
  centersByFamily: ReadonlyMap<string, readonly CompositeColumnGroupCenter[]>;
  seriesCountByFamily: ReadonlyMap<string, number>;
}

interface ColumnEntry {
  point: CompositeProjectedPoint;
  series: CompositeProjectedSeries;
  familyKey: string;
  ordinal: number | null;
}

interface FinancialPeriodBucket {
  key: string;
  ordinal: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_QUARTER_END_DISTANCE_MS = 45 * DAY_MS;

function familyKey(series: CompositeProjectedSeries): string {
  return [
    series.source.axis,
    series.source.nativeFrequency,
    series.source.unitGroup,
  ].join(":");
}

function observedTimestamp(point: CompositeProjectedPoint): number | null {
  const timestamp = point.point.observedAt.getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function annualBucket(point: CompositeProjectedPoint): FinancialPeriodBucket | null {
  const periodLabel = point.point.periodLabel?.trim();
  const timestamp = observedTimestamp(point);
  if (!periodLabel || !/^(?:FY\d{4}|Year ended \d{4}-\d{2}-\d{2})$/.test(periodLabel) || timestamp === null) return null;
  const observedAt = new Date(timestamp);
  const observedYear = observedAt.getUTCFullYear();
  const cohortYear = observedAt.getUTCMonth() <= 1 ? observedYear - 1 : observedYear;
  return { key: `annual:${cohortYear}`, ordinal: cohortYear };
}

function quarterlyBucket(point: CompositeProjectedPoint): FinancialPeriodBucket | null {
  const periodLabel = point.point.periodLabel?.trim();
  const timestamp = observedTimestamp(point);
  if (!periodLabel || !/^(?:\d{4} Q[1-4]|Quarter ended \d{4}-\d{2}-\d{2})$/.test(periodLabel) || timestamp === null) return null;

  const observedYear = new Date(timestamp).getUTCFullYear();
  let nearest: { year: number; quarter: number; distance: number } | null = null;
  for (let year = observedYear - 1; year <= observedYear + 1; year += 1) {
    for (let quarter = 1; quarter <= 4; quarter += 1) {
      const quarterEnd = Date.UTC(year, quarter * 3, 0);
      const distance = Math.abs(timestamp - quarterEnd);
      if (!nearest || distance < nearest.distance) {
        nearest = { year, quarter, distance };
      }
    }
  }
  if (!nearest || nearest.distance > MAX_QUARTER_END_DISTANCE_MS) return null;
  return {
    key: `quarterly:${nearest.year}:Q${nearest.quarter}`,
    ordinal: nearest.year * 4 + nearest.quarter - 1,
  };
}

function financialPeriodBucket(
  series: CompositeProjectedSeries,
  point: CompositeProjectedPoint,
): FinancialPeriodBucket | null {
  // A market-anchored mixed chart places publications by their first eligible
  // trading slot, so fiscal-period cohorting must not move them elsewhere.
  if (point.xSlot !== undefined) return null;
  // Availability-timed data must stay on its actual plotted date. Cohort
  // alignment is only valid for period-end observations.
  if (series.source.timestampMode === "available-at") return null;
  if (series.source.nativeFrequency === "annual") return annualBucket(point);
  if (series.source.nativeFrequency === "quarterly") return quarterlyBucket(point);
  return null;
}

/**
 * Assigns each column series a stable slot on its axis, then gathers matching
 * financial periods around their latest member date. Stable cohort slots keep
 * bar width and order unchanged when one series lacks an observation, while
 * financial-period normalization accounts for offset issuer fiscal calendars.
 */
export function buildCompositeColumnLayout(panel: CompositePanelScene): CompositeColumnLayout {
  const columnSeriesByFamily = new Map<string, CompositeProjectedSeries[]>();
  for (const series of panel.series) {
    if (series.source.style !== "columns") continue;
    const family = familyKey(series);
    const cohort = columnSeriesByFamily.get(family);
    if (cohort) cohort.push(series);
    else columnSeriesByFamily.set(family, [series]);
  }

  const seriesSlots = new Map<CompositeProjectedSeries, { index: number; count: number }>();
  for (const seriesGroup of columnSeriesByFamily.values()) {
    seriesGroup.forEach((series, index) => {
      seriesSlots.set(series, { index, count: seriesGroup.length });
    });
  }

  const groups = new Map<string, ColumnEntry[]>();
  const semanticBucketsBySeries = new Map<
    CompositeProjectedSeries,
    Array<FinancialPeriodBucket | null>
  >();
  const duplicateSemanticBucketKeys = new Set<string>();
  for (const series of panel.series) {
    if (series.source.style !== "columns") continue;
    const family = familyKey(series);
    const semanticBuckets = series.points.map((point) => financialPeriodBucket(series, point));
    semanticBucketsBySeries.set(series, semanticBuckets);
    const bucketCounts = new Map<string, number>();
    for (const bucket of semanticBuckets) {
      if (bucket) bucketCounts.set(bucket.key, (bucketCounts.get(bucket.key) ?? 0) + 1);
    }
    for (const [key, count] of bucketCounts) {
      if (count > 1) duplicateSemanticBucketKeys.add(`${family}:${key}`);
    }
  }

  for (const series of panel.series) {
    if (series.source.style !== "columns") continue;
    const family = familyKey(series);
    const semanticBuckets = semanticBucketsBySeries.get(series) ?? [];
    series.points.forEach((point, index) => {
      const semanticBucket = semanticBuckets[index];
      const uniqueSemanticBucket = semanticBucket
        && !duplicateSemanticBucketKeys.has(`${family}:${semanticBucket.key}`)
        ? semanticBucket
        : null;
      const key = uniqueSemanticBucket
        ? `${family}:${uniqueSemanticBucket.key}`
        : point.xSlot !== undefined
          ? `${family}:market-slot:${point.xSlot}`
          : `${family}:timestamp:${point.timestamp}`;
      const entry = {
        point,
        series,
        familyKey: family,
        ordinal: uniqueSemanticBucket?.ordinal ?? null,
      };
      const group = groups.get(key);
      if (group) group.push(entry);
      else groups.set(key, [entry]);
    });
  }

  const groupByPoint = new Map<CompositeProjectedPoint, CompositeColumnGroupSlot>();
  const centersByFamily = new Map<string, CompositeColumnGroupCenter[]>();
  for (const group of groups.values()) {
    const centerRatio = Math.max(...group.map(({ point }) => point.xRatio));
    const family = group[0]!.familyKey;
    const ordinal = group[0]!.ordinal;
    const center = { xRatio: centerRatio, ordinal };
    const centers = centersByFamily.get(family);
    if (centers) centers.push(center);
    else centersByFamily.set(family, [center]);

    const localSeries = ordinal === null
      // Groups are populated in panel-series order, so Set insertion order is
      // already the stable authored order and avoids sorting per observation.
      ? [...new Set(group.map(({ series }) => series))]
      : [];
    const localSlots = new Map(localSeries.map((series, index) => [
      series,
      { index, count: localSeries.length },
    ]));
    for (const { point, series } of group) {
      // Semantic fiscal cohorts retain stable empty lanes. Exact timestamp
      // groups only reserve lanes for series that actually share that date.
      const slot = ordinal === null
        ? localSlots.get(series) ?? { index: 0, count: 1 }
        : seriesSlots.get(series) ?? { index: 0, count: 1 };
      groupByPoint.set(point, {
        ...slot,
        xRatio: centerRatio,
        familyKey: family,
      });
    }
  }

  for (const centers of centersByFamily.values()) {
    centers.sort((left, right) => left.xRatio - right.xRatio);
  }

  const seriesCountByFamily = new Map<string, number>();
  for (const [family, seriesGroup] of columnSeriesByFamily) {
    seriesCountByFamily.set(family, seriesGroup.length);
  }

  return { groupByPoint, centersByFamily, seriesCountByFamily };
}
