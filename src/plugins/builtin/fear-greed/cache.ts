import {
  fetchFearGreedData,
  type FearGreedData,
} from "./data";
import type { PluginPersistence } from "../../../types/plugin";

const CACHE_KIND = "cnn-fear-greed";
const CACHE_KEY = "graphdata";
const CACHE_SOURCE = "cnn";
const CACHE_SCHEMA_VERSION = 1;
const CACHE_POLICY = {
  staleMs: 5 * 60 * 1000,
  expireMs: 7 * 24 * 60 * 60 * 1000,
} as const;

type PersistedChartPoint = Omit<FearGreedData["overall"]["history"][number], "date"> & {
  date: string;
};
type PersistedFearGreedData = {
  overall: Omit<FearGreedData["overall"], "updatedAt" | "history"> & {
    updatedAt: string | null;
    history: PersistedChartPoint[];
  };
  indicators: Array<Omit<FearGreedData["indicators"][number], "updatedAt" | "points"> & {
    updatedAt: string | null;
    points: PersistedChartPoint[];
  }>;
};
export type FearGreedCacheEntry = {
  data: FearGreedData;
  fetchedAt: number;
  stale: boolean;
};

export interface FearGreedLoadResult extends FearGreedCacheEntry {
  /** Set when the network failed and cached data was served instead. */
  refreshError?: string;
}

let fearGreedPersistence: PluginPersistence | null = null;
let activeFetch: Promise<FearGreedLoadResult> | null = null;

export function attachFearGreedPersistence(persistence: PluginPersistence): void {
  fearGreedPersistence = persistence;
}

export function resetFearGreedPersistence(): void {
  fearGreedPersistence = null;
  activeFetch = null;
}

function serializePoint(point: FearGreedData["overall"]["history"][number]): PersistedChartPoint {
  return {
    ...point,
    date: point.date.toISOString(),
  };
}

function deserializePoint(point: PersistedChartPoint): FearGreedData["overall"]["history"][number] {
  return {
    ...point,
    date: new Date(point.date),
  };
}

function serializeData(data: FearGreedData): PersistedFearGreedData {
  return {
    overall: {
      ...data.overall,
      updatedAt: data.overall.updatedAt?.toISOString() ?? null,
      history: data.overall.history.map(serializePoint),
    },
    indicators: data.indicators.map((indicator) => ({
      ...indicator,
      updatedAt: indicator.updatedAt?.toISOString() ?? null,
      points: indicator.points.map(serializePoint),
    })),
  };
}

function deserializeData(data: PersistedFearGreedData): FearGreedData {
  return {
    overall: {
      ...data.overall,
      updatedAt: data.overall.updatedAt ? new Date(data.overall.updatedAt) : null,
      history: data.overall.history.map(deserializePoint),
    },
    indicators: data.indicators.map((indicator) => ({
      ...indicator,
      updatedAt: indicator.updatedAt ? new Date(indicator.updatedAt) : null,
      points: indicator.points.map(deserializePoint),
    })),
  };
}

function readPersistedCache(options?: { allowExpired?: boolean }): FearGreedCacheEntry | null {
  const record = fearGreedPersistence?.getResource<PersistedFearGreedData>(CACHE_KIND, CACHE_KEY, {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    allowExpired: options?.allowExpired,
  });
  if (!record) return null;

  return {
    data: deserializeData(record.value),
    fetchedAt: record.fetchedAt,
    stale: !!record.stale,
  };
}

function writeCache(data: FearGreedData): void {
  fearGreedPersistence?.setResource(CACHE_KIND, CACHE_KEY, serializeData(data), {
    sourceKey: CACHE_SOURCE,
    schemaVersion: CACHE_SCHEMA_VERSION,
    cachePolicy: CACHE_POLICY,
  });
}

export function getCachedFearGreedData(options?: { allowExpired?: boolean }): FearGreedCacheEntry | null {
  return readPersistedCache(options);
}

export async function loadFearGreed(
  force = false,
  loader: () => Promise<FearGreedData> = fetchFearGreedData,
): Promise<FearGreedLoadResult> {
  const cached = getCachedFearGreedData();
  if (!force && cached && !cached.stale) {
    return cached;
  }
  if (activeFetch) return activeFetch;

  const fallback = cached ?? getCachedFearGreedData({ allowExpired: true });
  activeFetch = loader()
    .then((data) => {
      writeCache(data);
      return { data, fetchedAt: Date.now(), stale: false };
    })
    .catch((error: unknown) => {
      // A failed refresh must not be reported as a fresh load.
      if (fallback) {
        return {
          ...fallback,
          stale: true,
          refreshError: error instanceof Error ? error.message : String(error),
        };
      }
      throw error;
    })
    .finally(() => {
      activeFetch = null;
    });
  return activeFetch;
}
