import { apiClient, type CloudFredSeriesPayload } from "../../../api-client";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesRequest,
} from "../../../sources/gloomberb-cloud/fred-series";
import {
  CREDIT_SERIES,
  normalizeCreditSeries,
  type CreditConditionRow,
  type CreditSeriesDefinition,
} from "./model";

export interface CreditConditionsLoadResult {
  rows: CreditConditionRow[];
  stale: boolean;
  errors: string[];
}

/** A year of business-day closes plus holidays, for the 1Y rank and history chart. */
const HISTORY_LIMIT = 300;

export type CreditSeriesLoader = (
  seriesId: string,
  options: { limit: number; sortOrder: "desc" },
) => Promise<CloudFredSeriesPayload>;

function requestFor(seriesId: string): FredSeriesRequest {
  return { seriesId, limit: HISTORY_LIMIT, sortOrder: "desc" };
}

function trimHistory(data: CloudFredSeriesPayload): CloudFredSeriesPayload {
  return { ...data, observations: data.observations.slice(0, HISTORY_LIMIT) };
}

function seriesError(seriesId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${seriesId}:`) ? message : `${seriesId}: ${message}`;
}

export function getCachedCreditConditions(
  series: readonly CreditSeriesDefinition[] = CREDIT_SERIES,
): CreditConditionsLoadResult | null {
  const rows: CreditConditionRow[] = [];
  const errors: string[] = [];
  for (const definition of series) {
    const cached = getCachedFredSeries(requestFor(definition.seriesId), { allowExpired: true });
    if (!cached) continue;
    try {
      // The pane revalidates this copy on mount; only the source or a failed refresh makes it stale.
      rows.push(normalizeCreditSeries(definition, cached.data, cached.data.stale === true));
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
  definition: CreditSeriesDefinition,
  force: boolean,
  loader: CreditSeriesLoader,
) {
  const request = requestFor(definition.seriesId);
  let result: Awaited<ReturnType<typeof loadCachedFredSeries>>;
  try {
    result = await loadCachedFredSeries(
      request,
      async () => {
        const data = trimHistory(await loader(definition.seriesId, {
          limit: HISTORY_LIMIT,
          sortOrder: "desc",
        }));
        // Reject incompatible source responses before they replace usable cache.
        normalizeCreditSeries(definition, data);
        return data;
      },
      { force },
    );
  } catch (error) {
    // A refusal or a reply that fails validation is no saved copy's to answer: it is this row's
    // error, beside the dated prior value already read, which stays as stale rather than vanish.
    const kept = getCachedFredSeries(request, { allowExpired: true });
    if (!kept) throw error;
    return { row: normalizeCreditSeries(definition, kept.data, true), refreshError: error instanceof Error ? error.message : String(error) };
  }
  return {
    row: normalizeCreditSeries(definition, result.data, result.stale),
    refreshError: result.refreshError,
  };
}

export async function loadCreditConditions(
  force = false,
  loader: CreditSeriesLoader = (seriesId, options) => apiClient.getCloudFredSeries(seriesId, options),
  series: readonly CreditSeriesDefinition[] = CREDIT_SERIES,
): Promise<CreditConditionsLoadResult> {
  const settled = await Promise.allSettled(
    series.map((definition) => loadSeries(definition, force, loader)),
  );
  const rows: CreditConditionRow[] = [];
  const errors: string[] = [];
  settled.forEach((result, index) => {
    if (result.status === "rejected") {
      const seriesId = series[index]!.seriesId;
      errors.push(seriesError(seriesId, result.reason));
      return;
    }
    rows.push(result.value.row);
    if (result.value.refreshError) errors.push(seriesError(result.value.row.seriesId, result.value.refreshError));
  });
  if (rows.length === 0) throw new Error(summarizeSeriesErrors(errors));
  return { rows, stale: rows.some((row) => row.stale), errors };
}

/**
 * Every series failing is one outage, not six. Joining all of them produced a
 * message several times wider than the pane, which then got cut mid-word.
 */
function summarizeSeriesErrors(errors: readonly string[]): string {
  if (errors.length === 0) return "Credit spread data unavailable";
  const reasons = new Set(errors.map((entry) => entry.replace(/^[A-Z0-9]+:\s*/, "")));
  const reason = reasons.size === 1 ? [...reasons][0]! : `${errors.length} series failed`;
  return errors.length > 1 ? `${reason} (${errors.length} series)` : reason;
}
