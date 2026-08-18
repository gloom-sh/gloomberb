import { apiClient } from "../../../api-client";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesLoadResult,
  type FredSeriesRequest,
} from "../../../data/fred-series";
import {
  buildVolatilityData,
  VOLATILITY_SERIES,
  type VolatilityData,
  type VolatilitySeriesId,
  type VolatilitySeriesInput,
} from "./model";

export interface VolatilityLoadResult {
  data: VolatilityData;
  stale: boolean;
  errors: string[];
}

const HISTORY_LIMIT = 120;

function requestFor(seriesId: VolatilitySeriesId): FredSeriesRequest {
  return { seriesId, limit: HISTORY_LIMIT, sortOrder: "desc" };
}

function toInput(result: Pick<FredSeriesLoadResult, "data">): VolatilitySeriesInput {
  return {
    ...result.data,
    observations: result.data.observations.slice(0, HISTORY_LIMIT),
  };
}

export function getCachedVolatilityData(): VolatilityLoadResult | null {
  const entries = VOLATILITY_SERIES.flatMap(({ seriesId }) => {
    const cached = getCachedFredSeries(requestFor(seriesId), { allowExpired: true });
    return cached ? [[seriesId, cached] as const] : [];
  });
  if (entries.length === 0) return null;
  return {
    data: buildVolatilityData(Object.fromEntries(entries.map(([id, entry]) => [id, toInput(entry)]))),
    stale: entries.some(([, entry]) => entry.stale),
    errors: [],
  };
}

async function loadSeries(
  seriesId: VolatilitySeriesId,
  force: boolean,
): Promise<FredSeriesLoadResult> {
  const request = requestFor(seriesId);
  return loadCachedFredSeries(
    request,
    async () => toInput({ data: await apiClient.getCloudFredSeries(seriesId, {
      limit: request.limit,
      sortOrder: request.sortOrder,
    }) }),
    { force },
  );
}

export async function loadVolatilityData(force = false): Promise<VolatilityLoadResult> {
  const settled = await Promise.allSettled(
    VOLATILITY_SERIES.map(({ seriesId }) => loadSeries(seriesId, force)),
  );
  const inputs: Partial<Record<VolatilitySeriesId, VolatilitySeriesInput>> = {};
  const errors: string[] = [];
  let stale = false;

  settled.forEach((result, index) => {
    const seriesId = VOLATILITY_SERIES[index]!.seriesId;
    if (result.status === "rejected") {
      errors.push(`${seriesId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      return;
    }
    inputs[seriesId] = toInput(result.value);
    stale ||= result.value.stale;
    if (result.value.refreshError) errors.push(`${seriesId}: ${result.value.refreshError}`);
  });

  const data = buildVolatilityData(inputs);
  if (data.metrics.every((metric) => metric.value == null)) {
    throw new Error(errors.join("; ") || "Volatility data unavailable");
  }
  return { data, stale, errors };
}
