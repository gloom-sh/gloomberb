import { createPluginCache } from "../../../data/plugin-cache";
import {
  fetchFearGreedData,
  type FearGreedData,
} from "./data";

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

const cache = createPluginCache<FearGreedData, PersistedFearGreedData>({
  kind: CACHE_KIND, source: CACHE_SOURCE, schemaVersion: CACHE_SCHEMA_VERSION, policy: CACHE_POLICY,
  encode: serializeData, decode: deserializeData,
});
export const attachFearGreedPersistence = cache.attach;
export const resetFearGreedPersistence = cache.reset;

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

export function getCachedFearGreedData(options?: { allowExpired?: boolean }): FearGreedCacheEntry | null {
  return cache.get(CACHE_KEY, options);
}

export function loadFearGreed(
  force = false,
  loader: () => Promise<FearGreedData> = fetchFearGreedData,
): Promise<FearGreedLoadResult> {
  return cache.load(CACHE_KEY, loader, { force });
}
