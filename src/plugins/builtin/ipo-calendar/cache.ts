import type { PluginPersistence } from "../../../types/plugin";
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

let persistence: PluginPersistence | null = null;
let activeFetch: Promise<IpoCalendarResult> | null = null;

export function attachIpoCalendarPersistence(next: PluginPersistence): void {
  persistence = next;
}

export function resetIpoCalendarPersistence(): void {
  persistence = null;
  activeFetch = null;
}

function readCache(options?: { allowExpired?: boolean }): IpoCalendarResult | null {
  const record = persistence?.getResource<PersistedIPORecord[]>(CACHE_KIND, CACHE_KEY, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    allowExpired: options?.allowExpired,
  });
  if (!record || !Array.isArray(record.value)) return null;
  const records = record.value
    .map((entry) => ({ ...entry, date: new Date(entry.date) }))
    .filter((entry) => !Number.isNaN(entry.date.getTime()));
  return { records, fetchedAt: record.fetchedAt, stale: !!record.stale, errors: [] };
}

export function getCachedIpoCalendar(): IpoCalendarResult | null {
  return readCache({ allowExpired: true });
}

/**
 * Serves fresh cache without a request, shares one in-flight fetch across
 * panes, and falls back to whatever is cached when Stock Analysis is
 * unreachable. A partial scrape is cached but keeps its errors so the pane can
 * say so rather than presenting half a board as the whole one.
 */
export async function loadIpoCalendar(
  force = false,
  loader: () => Promise<IpoCalendarFetchResult> = fetchIpoCalendar,
): Promise<IpoCalendarResult> {
  const cached = readCache();
  if (!force && cached && !cached.stale) return cached;
  if (activeFetch) return activeFetch;

  const fallback = cached ?? readCache({ allowExpired: true });
  activeFetch = loader()
    .then(({ records, errors }) => {
      if (records.length === 0) {
        if (fallback) return { ...fallback, stale: true, errors };
        throw new Error(errors.join("; ") || "Stock Analysis returned no IPOs");
      }
      persistence?.setResource(
        CACHE_KIND,
        CACHE_KEY,
        records.map((record) => ({ ...record, date: record.date.toISOString() })),
        { sourceKey: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, cachePolicy: CACHE_POLICY },
      );
      return { records, fetchedAt: Date.now(), stale: false, errors };
    })
    .catch((error: unknown) => {
      if (fallback) {
        return {
          ...fallback,
          stale: true,
          errors: [error instanceof Error ? error.message : String(error)],
        };
      }
      throw error;
    })
    .finally(() => {
      activeFetch = null;
    });
  return activeFetch;
}
