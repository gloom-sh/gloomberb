import { afterEach, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { CloudJobsResponse } from "../../../api-client/types";
import { fetchJobs, resetJobsCache, type JobsCloudClient } from "./client";

const summary = { status: "ready", ticker: "ACME" } as unknown as CloudJobsResponse;
const pending = { status: "pending", message: "Looking." } as unknown as CloudJobsResponse;

afterEach(resetJobsCache);

/** A client whose requests are answered in order; a thrown answer is a failed request. */
function clientAnswering(...answers: Array<CloudJobsResponse | Error>) {
  const requests: string[] = [];
  const client = { getCloudJobs: async (ticker: string) => {
    requests.push(ticker);
    const answer = answers.shift()!;
    if (answer instanceof Error) throw answer;
    return answer;
  } } as unknown as JobsCloudClient;
  return { client, requests };
}

test("a company's summary and its 404 are kept for five minutes, and a forced read asks again", async () => {
  const { client, requests } = clientAnswering(summary, new ApiRequestError("none", 404), summary);
  expect((await fetchJobs("acme", { client })).kind).toBe("ready");
  expect((await fetchJobs("ACME", { client })).kind).toBe("ready");
  expect((await fetchJobs("none", { client })).kind).toBe("uncovered");
  expect((await fetchJobs("NONE", { client })).kind).toBe("uncovered");
  expect(requests).toEqual(["ACME", "NONE"]);
  await fetchJobs("acme", { client, force: true });
  expect(requests).toEqual(["ACME", "NONE", "ACME"]);
});

test("a pending answer and a refused account are never kept, so the pane's next read asks again", async () => {
  const { client, requests } = clientAnswering(pending, pending, new ApiRequestError("Pro only", 402), summary);
  expect((await fetchJobs("ACME", { client })).kind).toBe("pending");
  expect((await fetchJobs("ACME", { client })).kind).toBe("pending");
  expect(await fetchJobs("ACME", { client })).toMatchObject({ kind: "denied", status: 402 });
  expect((await fetchJobs("ACME", { client })).kind).toBe("ready");
  expect(requests).toHaveLength(4);
});
