import { createPluginCache } from "../../../../data/plugin-cache";
import type { DataProvider, EarningsEvent } from "../../../../types/data-provider";

const CACHE_KIND = "calendar";
const CACHE_SOURCE = "earnings";
const CACHE_SCHEMA_VERSION = 2;

export const EARNINGS_CALENDAR_CACHE_POLICY = {
  staleMs: 30 * 60 * 1000,
  expireMs: 7 * 24 * 60 * 60 * 1000,
} as const;

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

const cache = createPluginCache<EarningsEvent[], PersistedEarningsEvent[]>({
  kind: CACHE_KIND, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, policy: EARNINGS_CALENDAR_CACHE_POLICY,
  encode: serializeEvents, decode: deserializeEvents,
});
export const attachEarningsCalendarPersistence = cache.attach;
export const resetEarningsCalendarPersistence = cache.reset;

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

export async function loadEarningsCalendar(
  provider: DataProvider | null | undefined,
  symbols: string[],
  options?: { force?: boolean },
): Promise<EarningsCalendarResult> {
  const normalizedSymbols = normalizeEarningsSymbols(symbols);
  if (normalizedSymbols.length === 0 || !provider?.getEarningsCalendar) {
    return { events: [], fetchedAt: Date.now(), stale: false };
  }
  const result = await cache.load(buildEarningsCacheKey(normalizedSymbols),
    () => provider.getEarningsCalendar!(normalizedSymbols), { force: options?.force, replace: options?.force });
  return { events: result.data, fetchedAt: result.fetchedAt, stale: result.stale, refreshError: result.refreshError };
}
