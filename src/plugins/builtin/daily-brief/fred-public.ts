import type { CloudFredObservationPayload, CloudFredSeriesPayload } from "../../../api-client";
import type { CloudFredSeriesParams } from "../../../api-client/paths";
import type { ConnectionHealthRegistry } from "../../../core/connection-health";
import { createThrottledFetch } from "../../../utils/throttled-fetch";
import { DAILY_BRIEF_PLUGIN_ID } from "./wake";

const FRED_PUBLIC_CONNECTION_ID = "fred-public";

const SERIES_ID_RE = /^[A-Z0-9._-]{1,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const FRED_FETCH = createThrottledFetch({
  requestsPerMinute: 20,
  maxRetries: 2,
  timeoutMs: 15_000,
  backoffBaseMs: 800,
  dedupeGetRequests: true,
  defaultHeaders: {
    Accept: "*/*",
    // FRED's edge returns the CSV for this agent and stalls other ones.
    "User-Agent": "curl/8.7.1",
  },
});

let health: ConnectionHealthRegistry | null = null;
let disposeConnection: (() => void) | null = null;

export function attachDailyBriefFred(registry: ConnectionHealthRegistry): void {
  detachDailyBriefFred();
  health = registry;
  disposeConnection = registry.registerSource({
    id: FRED_PUBLIC_CONNECTION_ID,
    name: "FRED",
    kind: "api",
    ownerId: DAILY_BRIEF_PLUGIN_ID,
    detail: "fred.stlouisfed.org",
    priority: 300,
  });
}

export function detachDailyBriefFred(): void {
  disposeConnection?.();
  disposeConnection = null;
  health = null;
}

function assertSeriesId(seriesId: string): string {
  const id = seriesId.trim().toUpperCase();
  if (!SERIES_ID_RE.test(id)) throw new Error(`Invalid FRED series id "${seriesId}"`);
  return id;
}

function parseFredNumber(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === ".") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Public `fredgraph.csv`. A lone `.` is a missing print. HTML is an unknown series. */
export function parseFredGraphCsv(csv: string, seriesId: string): CloudFredObservationPayload[] {
  const text = csv.replace(/^\uFEFF/, "").trim();
  if (!text || text.startsWith("<!") || text.startsWith("<html")) {
    throw new Error(`FRED series ${seriesId} is unavailable`);
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error(`FRED series ${seriesId} returned no observations`);
  const observations: CloudFredObservationPayload[] = [];
  for (const line of lines.slice(1)) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const date = line.slice(0, comma).trim();
    if (!DATE_RE.test(date)) continue;
    observations.push({ date, value: parseFredNumber(line.slice(comma + 1)) });
  }
  if (observations.length === 0) throw new Error(`FRED series ${seriesId} returned no observations`);
  return observations;
}

function applyParams(
  observations: CloudFredObservationPayload[],
  params: CloudFredSeriesParams,
): CloudFredObservationPayload[] {
  let next = observations;
  if (params.startDate && DATE_RE.test(params.startDate)) next = next.filter((row) => row.date >= params.startDate!);
  if (params.endDate && DATE_RE.test(params.endDate)) next = next.filter((row) => row.date <= params.endDate!);
  next = [...next].sort((left, right) => (
    params.sortOrder === "desc" ? right.date.localeCompare(left.date) : left.date.localeCompare(right.date)
  ));
  if (params.limit != null && params.limit > 0) next = next.slice(0, params.limit);
  return next;
}

/**
 * Gloom Cloud's FRED proxy allowlists a fixed set of series and rejects
 * MORTGAGE30US. The public CSV is the Freddie Mac 30-year average.
 */
export async function fetchPublicFredSeries(
  seriesId: string,
  params: CloudFredSeriesParams = {},
): Promise<CloudFredSeriesPayload> {
  const id = assertSeriesId(seriesId);
  const load = async () => {
    const response = await FRED_FETCH.fetch(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error(`FRED request failed (${response.status}) for ${id}`);
    return {
      observations: applyParams(parseFredGraphCsv(await response.text(), id), params),
      info: {
        id,
        title: "30-Year Fixed Rate Mortgage Average in the United States",
        units: "Percent",
        frequency: "Weekly",
        seasonalAdjustment: "Not Seasonally Adjusted",
        source: "Freddie Mac",
        notes: "",
      },
    } satisfies CloudFredSeriesPayload;
  };
  return health?.hasSource(FRED_PUBLIC_CONNECTION_ID)
    ? health.track(FRED_PUBLIC_CONNECTION_ID, id, load)
    : load();
}
