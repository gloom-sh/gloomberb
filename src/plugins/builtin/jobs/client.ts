import { apiClient } from "../../../api-client";
import { createTtlCache } from "../../../data/ttl-cache";
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
/**
 * `pending` is never kept, so the pane's poll reads it afresh each time, and
 * `denied` is not either: the account can change under the pane.
 */
const summaries = createTtlCache<JobsCompanyState>({
  ttlMs: SUMMARY_TTL_MS,
  keep: (state) => state.kind === "ready" || state.kind === "uncovered",
});

async function loadJobs(key: string, name: string | null | undefined, client: JobsCloudClient): Promise<JobsCompanyState> {
  try {
    const response: CloudJobsResponse = await client.getCloudJobs(key, name);
    return response.status === "pending"
      ? { kind: "pending", ticker: key, message: response.message }
      : { kind: "ready", summary: response };
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) {
      return { kind: "uncovered", ticker: key, message: error.message };
    }
    if (error instanceof ApiRequestError && (error.status === 401 || error.status === 402 || error.status === 403)) {
      return { kind: "denied", status: error.status, message: error.message };
    }
    throw error;
  }
}

export function fetchJobs(
  ticker: string,
  options: { name?: string | null; force?: boolean; client?: JobsCloudClient } = {},
): Promise<JobsCompanyState> {
  const key = ticker.toUpperCase();
  return summaries.load(key, () => loadJobs(key, options.name, options.client ?? apiClient), { force: options.force });
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
  summaries.clear();
}
