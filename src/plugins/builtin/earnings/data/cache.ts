import type { DataProvider, EarningsEvent } from "../../../../types/data-provider";
import type { PersistedResourceValue } from "../../../../types/persistence";
import type { PluginPersistence } from "../../../../types/plugin";

const CACHE_KIND = "calendar";
const CACHE_SOURCE = "earnings";
const CACHE_SCHEMA_VERSION = 2;

export const EARNINGS_CALENDAR_CACHE_POLICY = {
  staleMs: 30 * 60 * 1000,
  expireMs: 7 * 24 * 60 * 60 * 1000,
} as const;

interface MemoryCacheEntry {
  data: EarningsEvent[];
  fetchedAt: number;
}

type PersistedEarningsEvent = Omit<EarningsEvent, "earningsDate" | "earningsCallDate"> & {
  earningsDate: string;
  earningsCallDate?: string | null;
};

export interface EarningsCalendarResult {
  events: EarningsEvent[];
  fetchedAt: number;
  /** True when the provider failed and cached events were served instead. */
  stale: boolean;
  refreshError?: string;
}

let earningsPersistence: PluginPersistence | null = null;
const memoryCache = new Map<string, MemoryCacheEntry>();
const activeFetches = new Map<string, Promise<EarningsCalendarResult>>();

export function attachEarningsCalendarPersistence(persistence: PluginPersistence): void {
  earningsPersistence = persistence;
}

export function resetEarningsCalendarPersistence(): void {
  earningsPersistence = null;
  memoryCache.clear();
  activeFetches.clear();
}

function normalizeEarningsSymbols(symbols: string[]): string[] {
  return Array.from(
    new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ).sort();
}

export function buildEarningsCacheKey(symbols: string[]): string {
  const normalized = normalizeEarningsSymbols(symbols);
  return normalized.length > 0 ? normalized.join(",") : "empty";
}

function serializeEvents(events: EarningsEvent[]): PersistedEarningsEvent[] {
  return events.map((event) => ({
    ...event,
    earningsDate: event.earningsDate.toISOString(),
    earningsCallDate: event.earningsCallDate?.toISOString() ?? null,
  }));
}

function deserializeEvents(events: PersistedEarningsEvent[]): EarningsEvent[] {
  return events
    .map((event) => ({
      ...event,
      earningsDate: new Date(event.earningsDate),
      earningsCallDate: event.earningsCallDate ? new Date(event.earningsCallDate) : null,
    }))
    .filter((event) => (
      !Number.isNaN(event.earningsDate.getTime())
      && (
        !event.earningsCallDate
        || !Number.isNaN(event.earningsCallDate.getTime())
      )
    ));
}

function readPersistedCache(
  key: string,
  options?: { allowExpired?: boolean },
): PersistedResourceValue<PersistedEarningsEvent[]> | null {
  return earningsPersistence?.getResource<PersistedEarningsEvent[]>(CACHE_KIND, key, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    allowExpired: options?.allowExpired,
  }) ?? null;
}

function writeCache(key: string, events: EarningsEvent[]): void {
  memoryCache.set(key, { data: events, fetchedAt: Date.now() });
  earningsPersistence?.setResource(CACHE_KIND, key, serializeEvents(events), {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachePolicy: EARNINGS_CALENDAR_CACHE_POLICY,
  });
}

export async function loadEarningsCalendar(
  provider: DataProvider | null | undefined,
  symbols: string[],
  options?: { force?: boolean },
): Promise<EarningsCalendarResult> {
  const normalizedSymbols = normalizeEarningsSymbols(symbols);
  if (normalizedSymbols.length === 0 || !provider?.getEarningsCalendar) {
    return { events: [], fetchedAt: Date.now(), stale: false };
  }

  const key = buildEarningsCacheKey(normalizedSymbols);
  const force = options?.force ?? false;
  const memoryEntry = memoryCache.get(key);
  if (!force && memoryEntry && Date.now() - memoryEntry.fetchedAt < EARNINGS_CALENDAR_CACHE_POLICY.staleMs) {
    return { events: memoryEntry.data, fetchedAt: memoryEntry.fetchedAt, stale: false };
  }

  const freshPersisted = readPersistedCache(key);
  if (!force && freshPersisted && !freshPersisted.stale) {
    const data = deserializeEvents(freshPersisted.value);
    memoryCache.set(key, { data, fetchedAt: freshPersisted.fetchedAt });
    return { events: data, fetchedAt: freshPersisted.fetchedAt, stale: false };
  }

  const activeFetch = activeFetches.get(key);
  if (activeFetch && !force) return activeFetch;

  const fetchPromise = provider.getEarningsCalendar(normalizedSymbols)
    .then((data) => {
      writeCache(key, data);
      return { events: data, fetchedAt: Date.now(), stale: false };
    })
    .catch((error: unknown) => {
      // Cached events survive a provider outage, but never as a fresh load.
      const refreshError = error instanceof Error ? error.message : String(error);
      const stalePersisted = freshPersisted ?? readPersistedCache(key, { allowExpired: true });
      if (stalePersisted) {
        const data = deserializeEvents(stalePersisted.value);
        memoryCache.set(key, { data, fetchedAt: stalePersisted.fetchedAt });
        return { events: data, fetchedAt: stalePersisted.fetchedAt, stale: true, refreshError };
      }
      if (memoryEntry) {
        return { events: memoryEntry.data, fetchedAt: memoryEntry.fetchedAt, stale: true, refreshError };
      }
      throw error;
    })
    .finally(() => {
      if (activeFetches.get(key) === fetchPromise) {
        activeFetches.delete(key);
      }
    });

  activeFetches.set(key, fetchPromise);
  return fetchPromise;
}
