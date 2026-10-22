import { apiClient, type CloudFredObservationPayload, type CloudFredSeriesPayload } from "../../../api-client";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesRequest,
} from "../../../sources/gloomberb-cloud/fred-series";
import { fetchPublicFredSeries } from "./fred-public";

/** Latest print and the one before it. Both are already in percent. */
export interface RateLevel {
  value: number;
  previous: number | null;
}

export interface BriefYieldRow {
  id: string;
  label: string;
  level: RateLevel | null;
}

export interface BriefYields {
  rows: BriefYieldRow[];
  errors: string[];
  fetchedAt: number | null;
  stale: boolean;
}

/** Treasury yields use Gloom Cloud. The mortgage average is the public FRED CSV. */
export const BRIEF_YIELDS = [
  { id: "us10y", seriesId: "DGS10", label: "10Y", source: "cloud" },
  { id: "us30y", seriesId: "DGS30", label: "30Y", source: "cloud" },
  { id: "mtg30", seriesId: "MORTGAGE30US", label: "30Y MTG", source: "public" },
] as const;

const HISTORY_LIMIT = 8;

function requestFor(seriesId: string): FredSeriesRequest {
  return { seriesId, limit: HISTORY_LIMIT, sortOrder: "desc" };
}

/** Newest finite print, then the one before it. Order of the payload does not matter. */
export function latestRate(observations: readonly CloudFredObservationPayload[]): RateLevel | null {
  const points = observations
    .filter((point): point is { date: string; value: number } =>
      typeof point.date === "string"
      && point.date.length >= 10
      && point.value != null
      && Number.isFinite(point.value))
    .sort((a, b) => b.date.localeCompare(a.date));
  const latest = points[0];
  if (!latest) return null;
  return { value: latest.value, previous: points[1]?.value ?? null };
}

/** Change from the previous print, in basis points. */
export function rateChangeBp(latest: number, previous: number | null): number | null {
  if (previous == null || !Number.isFinite(previous) || !Number.isFinite(latest)) return null;
  return Math.round((latest - previous) * 100);
}

export function yieldStat(row: BriefYieldRow): { id: string; label: string; value: string; detail?: string; tone?: "neutral" | "positive" | "negative" } {
  const level = row.level;
  if (!level) return { id: row.id, label: row.label, value: "--" };
  const change = rateChangeBp(level.value, level.previous);
  return {
    id: row.id,
    label: row.label,
    value: `${level.value.toFixed(2)}%`,
    detail: change == null ? undefined : `${change > 0 ? "+" : ""}${change}bp`,
    tone: change == null || change === 0 ? "neutral" : change > 0 ? "positive" : "negative",
  };
}

function emptyYields(): BriefYields {
  return {
    rows: BRIEF_YIELDS.map((yieldRow) => ({ id: yieldRow.id, label: yieldRow.label, level: null })),
    errors: [],
    fetchedAt: null,
    stale: false,
  };
}

export function getCachedBriefYields(): BriefYields | null {
  const rows: BriefYieldRow[] = [];
  let fetchedAt: number | null = null;
  let stale = false;
  let any = false;
  for (const yieldRow of BRIEF_YIELDS) {
    const cached = getCachedFredSeries(requestFor(yieldRow.seriesId), { allowExpired: true });
    if (!cached) {
      rows.push({ id: yieldRow.id, label: yieldRow.label, level: null });
      continue;
    }
    any = true;
    stale = stale || cached.stale;
    fetchedAt = fetchedAt == null ? cached.fetchedAt : Math.min(fetchedAt, cached.fetchedAt);
    rows.push({ id: yieldRow.id, label: yieldRow.label, level: latestRate(cached.data.observations) });
  }
  return any ? { rows, errors: [], fetchedAt, stale } : null;
}

export async function loadBriefYields(
  force = false,
  loader: (seriesId: string) => Promise<CloudFredSeriesPayload> = (seriesId) =>
    apiClient.getCloudFredSeries(seriesId, { limit: HISTORY_LIMIT, sortOrder: "desc" }),
): Promise<BriefYields> {
  const settled = await Promise.allSettled(BRIEF_YIELDS.map(async (yieldRow) => {
    const result = await loadCachedFredSeries(
      requestFor(yieldRow.seriesId),
      () => yieldRow.source === "public"
        ? fetchPublicFredSeries(yieldRow.seriesId, { limit: HISTORY_LIMIT, sortOrder: "desc" })
        : loader(yieldRow.seriesId),
      { force },
    );
    return {
      row: { id: yieldRow.id, label: yieldRow.label, level: latestRate(result.data.observations) } satisfies BriefYieldRow,
      fetchedAt: result.fetchedAt,
      stale: result.stale,
      refreshError: result.refreshError,
    };
  }));
  const bundle = emptyYields();
  settled.forEach((result, index) => {
    const yieldRow = BRIEF_YIELDS[index]!;
    if (result.status === "rejected") {
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      bundle.errors.push(message.startsWith(`${yieldRow.seriesId}:`) ? message : `${yieldRow.seriesId}: ${message}`);
      return;
    }
    bundle.rows[index] = result.value.row;
    bundle.stale = bundle.stale || result.value.stale;
    bundle.fetchedAt = bundle.fetchedAt == null
      ? result.value.fetchedAt
      : Math.min(bundle.fetchedAt, result.value.fetchedAt);
    if (result.value.refreshError) bundle.errors.push(`${yieldRow.seriesId}: ${result.value.refreshError}`);
  });
  return bundle;
}
