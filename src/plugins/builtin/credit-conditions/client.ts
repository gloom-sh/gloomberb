import { apiClient } from "../../../api-client";
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

function startDate(): string {
  return new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
}

function requestFor(seriesId: CreditSeriesId): FredSeriesRequest {
  return { seriesId, startDate: startDate(), sortOrder: "asc" };
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

async function loadSeries(definition: typeof CREDIT_SERIES[number], force: boolean) {
  const request = requestFor(definition.seriesId);
  const result = await loadCachedFredSeries(
    request,
    () => apiClient.getCloudFredSeries(definition.seriesId, {
      startDate: request.startDate,
      sortOrder: "asc",
    }),
    { force },
  );
  return {
    row: normalizeCreditSeries(definition, result.data, result.stale),
    refreshError: result.refreshError,
  };
}

export async function loadCreditConditions(force = false): Promise<CreditConditionsLoadResult> {
  const settled = await Promise.allSettled(
    CREDIT_SERIES.map((definition) => loadSeries(definition, force)),
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
