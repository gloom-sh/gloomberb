import type { PluginPersistence } from "../../../types/plugin";
import { httpFetch } from "../../../utils/http-transport";
import { measurePerf } from "../../../utils/perf-marks";
import {
  createThrottledFetch,
} from "../../../utils/throttled-fetch";

const DEFAULT_SOURCE_KEY = "remote";
const PREDICTION_FETCH = createThrottledFetch({
  requestsPerMinute: 120,
  maxRetries: 2,
  timeoutMs: 10_000,
  backoffBaseMs: 250,
  dedupeGetRequests: false,
  defaultHeaders: {
    Accept: "application/json",
    "User-Agent": "gloomberb-prediction-markets",
  },
  transport: httpFetch,
});

export const PREDICTION_CACHE_POLICIES = {
  catalog: { staleMs: 30_000, expireMs: 10 * 60_000 },
  detail: { staleMs: 10_000, expireMs: 5 * 60_000 },
  book: { staleMs: 5_000, expireMs: 30_000 },
  trades: { staleMs: 5_000, expireMs: 2 * 60_000 },
  history: { staleMs: 60_000, expireMs: 24 * 60 * 60_000 },
  rules: { staleMs: 24 * 60 * 60_000, expireMs: 30 * 24 * 60 * 60_000 },
} as const;

let predictionMarketsPersistence: PluginPersistence | null = null;

export function attachPredictionMarketsPersistence(
  persistence: PluginPersistence,
): void {
  predictionMarketsPersistence = persistence;
}

export function resetPredictionMarketsPersistence(): void {
  predictionMarketsPersistence = null;
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await PREDICTION_FETCH.fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  const body = await response.text();
  return measurePerf(
    "prediction.fetch.parse-json",
    () => JSON.parse(body) as T,
    {
      sizeBytes: body.length,
      url: summarizePredictionFetchUrl(url),
    },
  );
}

export function getCachedPredictionResource<T>(
  kind: string,
  key: string,
  options?: { sourceKey?: string; allowExpired?: boolean },
): T | null {
  const record = predictionMarketsPersistence?.getResource<T>(kind, key, {
    sourceKey: options?.sourceKey ?? DEFAULT_SOURCE_KEY,
    allowExpired: options?.allowExpired,
  });
  return record?.value ?? null;
}

function setCachedPredictionResource<T>(
  kind: string,
  key: string,
  value: T,
  cachePolicy: { staleMs: number; expireMs: number },
  sourceKey = DEFAULT_SOURCE_KEY,
): void {
  predictionMarketsPersistence?.setResource(kind, key, value, {
    sourceKey,
    cachePolicy,
  });
}

export async function loadCachedPredictionResource<T>(
  kind: string,
  key: string,
  fetcher: () => Promise<T>,
  cachePolicy: { staleMs: number; expireMs: number },
): Promise<T> {
  const cached = predictionMarketsPersistence?.getResource<T>(kind, key, {
    sourceKey: DEFAULT_SOURCE_KEY,
  });
  if (cached && cached.stale !== true && cached.staleAt > Date.now()) {
    return cached.value;
  }
  try {
    const nextValue = await fetcher();
    setCachedPredictionResource(kind, key, nextValue, cachePolicy);
    return nextValue;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (cached) return cached.value;
    throw error;
  }
}

function summarizePredictionFetchUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return url.slice(0, 120);
  }
}

export function parseFloatSafe(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}
