import { createPluginCache } from "../../../data/plugin-cache";
import { fetchIpoCalendar, type IpoCalendarFetchResult } from "./client";
import type { IPORecord } from "./types";

const CACHE_KIND = "ipo-calendar";
const CACHE_KEY = "board";
const CACHE_SOURCE = "stockanalysis";
const CACHE_SCHEMA_VERSION = 1;
/**
 * The board moves on pricing days, not minutes, so a quarter hour of freshness
 * is enough; the week-long expiry is what keeps an offline start usable.
 */
const CACHE_POLICY = {
  staleMs: 15 * 60 * 1000,
  expireMs: 7 * 24 * 60 * 60 * 1000,
} as const;

type PersistedIPORecord = Omit<IPORecord, "date"> & { date: string };

export interface IpoCalendarResult {
  records: IPORecord[];
  fetchedAt: number;
  /** True when the network failed and cached records were served instead. */
  stale: boolean;
  /** Endpoints that failed while others succeeded. */
  errors: string[];
}

const cache = createPluginCache<IpoCalendarFetchResult, PersistedIPORecord[]>({
  kind: CACHE_KIND, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, policy: CACHE_POLICY,
  encode: ({ records }) => records.map((record) => ({ ...record, date: record.date.toISOString() })),
  decode: (records) => ({ records: records.map((record) => ({ ...record, date: new Date(record.date) }))
    .filter((record) => !Number.isNaN(record.date.getTime())), errors: [] }),
});
export const attachIpoCalendarPersistence = cache.attach;
export const resetIpoCalendarPersistence = cache.reset;

export function getCachedIpoCalendar(): IpoCalendarResult | null {
  const result = cache.get(CACHE_KEY, { allowExpired: true });
  return result ? { records: result.data.records, fetchedAt: result.fetchedAt, stale: result.stale, errors: [] } : null;
}

export async function loadIpoCalendar(
  force = false,
  loader: () => Promise<IpoCalendarFetchResult> = fetchIpoCalendar,
): Promise<IpoCalendarResult> {
  const result = await cache.load(CACHE_KEY, async () => {
    const fetched = await loader();
    if (fetched.records.length === 0) throw Object.assign(new Error(fetched.errors.join("; ") || "Stock Analysis returned no IPOs"), { errors: fetched.errors });
    return fetched;
  }, { force });
  return { records: result.data.records, fetchedAt: result.fetchedAt, stale: result.stale,
    errors: result.error && typeof result.error === "object" && "errors" in result.error
      ? result.error.errors as string[] : result.refreshError ? [result.refreshError] : result.data.errors };
}
