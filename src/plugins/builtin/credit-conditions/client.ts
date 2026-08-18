import { apiClient, type CloudFredSeriesPayload } from "../../../api-client";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesRequest,
} from "../../../data/fred-series";
import {
  CREDIT_SERIES,
  normalizeCreditSeries,
  type CreditConditionRow,
  type CreditSeriesId,
} from "./model";

export interface CreditConditionsLoadResult {
  rows: CreditConditionRow[];
  stale: boolean;
  errors: string[];
}

const HISTORY_LIMIT = 45;

type CreditSeriesLoader = (
  seriesId: CreditSeriesId,
  options: { limit: number; sortOrder: "desc" },
) => Promise<CloudFredSeriesPayload>;

function requestFor(seriesId: CreditSeriesId): FredSeriesRequest {
  return { seriesId, limit: HISTORY_LIMIT, sortOrder: "desc" };
}

function trimHistory(data: CloudFredSeriesPayload): CloudFredSeriesPayload {
  return { ...data, observations: data.observations.slice(0, HISTORY_LIMIT) };
}

export function getCachedCreditConditions(): CreditConditionsLoadResult | null {
  const rows: CreditConditionRow[] = [];
  const errors: string[] = [];
  for (const definition of CREDIT_SERIES) {
    const cached = getCachedFredSeries(requestFor(definition.seriesId), { allowExpired: true });
    if (!cached) continue;
    try {
      rows.push(normalizeCreditSeries(definition, cached.data, cached.stale));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return rows.length === 0 ? null : {
    rows,
    stale: rows.some((row) => row.stale),
    errors,
  };
}

async function loadSeries(
  definition: typeof CREDIT_SERIES[number],
  force: boolean,
  loader: CreditSeriesLoader,
) {
  const request = requestFor(definition.seriesId);
  const result = await loadCachedFredSeries(
    request,
    async () => trimHistory(await loader(definition.seriesId, {
      limit: HISTORY_LIMIT,
      sortOrder: "desc",
    })),
    { force },
  );
  return {
    row: normalizeCreditSeries(definition, result.data, result.stale),
    refreshError: result.refreshError,
  };
}

export async function loadCreditConditions(
  force = false,
  loader: CreditSeriesLoader = (seriesId, options) => apiClient.getCloudFredSeries(seriesId, options),
): Promise<CreditConditionsLoadResult> {
  const settled = await Promise.allSettled(
    CREDIT_SERIES.map((definition) => loadSeries(definition, force, loader)),
  );
  const rows: CreditConditionRow[] = [];
  const errors: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      const seriesId = CREDIT_SERIES[index]!.seriesId;
      errors.push(`${seriesId}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      return;
    }
    rows.push(result.value.row);
    if (result.value.refreshError) errors.push(`${result.value.row.seriesId}: ${result.value.refreshError}`);
  });
  if (rows.length === 0) throw new Error(errors.join("; ") || "Credit spread data unavailable");
  return { rows, stale: rows.some((row) => row.stale), errors };
}
