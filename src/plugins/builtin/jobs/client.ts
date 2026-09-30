import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type {
  CloudJobsMoversPayload,
  CloudJobsPostingsPayload,
  CloudJobsResponse,
  CloudJobsSummaryPayload,
} from "../../../api-client/types";

export type JobsCloudClient = Pick<
  typeof apiClient,
  "getCloudJobs" | "getCloudJobsPostings" | "getCloudJobsMovers"
>;

/**
 * What the pane and the research tab see for one company. `uncovered` is the
 * server's 404: it looked and found no supported careers system. `pending`
 * means it is looking now, so the caller should poll.
 */
export type JobsCompanyState =
  | { kind: "ready"; summary: CloudJobsSummaryPayload }
  | { kind: "pending"; ticker: string; message: string }
  | { kind: "uncovered"; ticker: string; message: string }
  /** The account is the problem, not the company: 401, 402 or 403. */
  | { kind: "denied"; status: 401 | 402 | 403; message: string };

const SUMMARY_TTL_MS = 5 * 60_000;
const summaryCache = new Map<string, { at: number; state: JobsCompanyState }>();

function cachedJobs(ticker: string): JobsCompanyState | null {
  const entry = summaryCache.get(ticker.toUpperCase());
  if (!entry || Date.now() - entry.at > SUMMARY_TTL_MS) return null;
  return entry.state;
}

export async function fetchJobs(
  ticker: string,
  options: { name?: string | null; force?: boolean; client?: JobsCloudClient } = {},
): Promise<JobsCompanyState> {
  const key = ticker.toUpperCase();
  if (!options.force) {
    const cached = cachedJobs(key);
    // A pending answer is never served from cache: the point is to poll.
    if (cached && cached.kind !== "pending") return cached;
  }
  const client = options.client ?? apiClient;
  let state: JobsCompanyState;
  try {
    const response: CloudJobsResponse = await client.getCloudJobs(key, options.name);
    state = response.status === "pending"
      ? { kind: "pending", ticker: key, message: response.message }
      : { kind: "ready", summary: response };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      state = { kind: "uncovered", ticker: key, message: error.message };
    } else if (error instanceof ApiRequestError && (error.status === 401 || error.status === 402 || error.status === 403)) {
      // Not cached: the account can change under the pane.
      return { kind: "denied", status: error.status, message: error.message };
    } else {
      throw error;
    }
  }
  summaryCache.set(key, { at: Date.now(), state });
  return state;
}

export function fetchJobsPostings(
  ticker: string,
  params: { function?: string; q?: string; limit?: number; offset?: number } = {},
  client: JobsCloudClient = apiClient,
): Promise<CloudJobsPostingsPayload> {
  return client.getCloudJobsPostings(ticker.toUpperCase(), params);
}

export function fetchJobsMovers(
  client: JobsCloudClient = apiClient,
  limit?: number,
  offset?: number,
): Promise<CloudJobsMoversPayload> {
  return client.getCloudJobsMovers(limit, offset);
}

export function resetJobsCache(): void {
  summaryCache.clear();
}
