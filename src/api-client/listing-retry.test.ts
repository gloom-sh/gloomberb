import { expect, test } from "bun:test";
import { CloudDataApi } from "./data";
import { ApiRequestError, wasAskedTwice } from "./errors";
import { DataServiceUnreachableError } from "../utils/network-failure";

const quote = { status: "success", data: { symbol: "YAR", price: 393.9 } };
const failed = { status: "retryable_error", reasonCode: "UPSTREAM_ERROR", data: null };

/** A data API whose service answers each request with the next of `answers`, a thrown error for an Error. */
function service(...answers: unknown[]) {
  const paths: string[] = [];
  const api = new CloudDataApi((async (path: string) => {
    paths.push(path);
    const answer = answers[Math.min(paths.length, answers.length) - 1];
    if (answer instanceof Error) throw answer;
    return structuredClone(answer);
  }) as never, 0);
  return { api, paths };
}

// The service's source blinks for minutes at a time; a known listing then read as one no source covers.
test("a listing read the service failed to answer is asked once more, and its second answer stands", async () => {
  for (const first of [failed, { status: "fatal_error", reasonCode: "UPSTREAM_ERROR", data: null }, new ApiRequestError("Bad gateway", 502)]) {
    const recovered = service(first, quote);
    expect(await recovered.api.getCloudQuote("YAR", "OSL")).toEqual(quote as never);
    expect(recovered.paths).toEqual(["/market/quote?symbol=YAR&exchange=OSL", "/market/quote?symbol=YAR&exchange=OSL"]);
  }
  // Failing again, the second failure is the answer: asked twice, not in a loop, and marked as the service not answering.
  const down = service(failed, failed, quote);
  const history = await down.api.getCloudHistory("YAR", "OSL", { range: "1M" });
  expect(history).toEqual(failed as never);
  expect(wasAskedTwice(history)).toBe(true);
  expect(down.paths).toHaveLength(2);
  const batch = service(new ApiRequestError("Bad gateway", 502), new ApiRequestError("Bad gateway", 502));
  const error = await batch.api.getCloudQuotesBatch([{ symbol: "YAR", exchange: "OSL" }]).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiRequestError);
  expect(wasAskedTwice(error)).toBe(true);
  expect(batch.paths).toHaveLength(2);
});

test("an answer of no data, a refusal, a rate limit of any wait and an unreachable service are not asked again", async () => {
  const answers = [{ status: "empty", reasonCode: "NOT_FOUND", data: null }, new ApiRequestError("Forbidden", 403),
    new ApiRequestError("slow down", 429, 20), new ApiRequestError("slow down", 429, 60_000), new ApiRequestError("slow down", 429),
    new DataServiceUnreachableError(new Error("Unable to connect"))];
  for (const answer of answers) {
    const once = service(answer, quote);
    const outcome = await once.api.getCloudFinancials("ZZZQQ").catch((caught: unknown) => caught);
    expect(once.paths).toHaveLength(1);
    // Asked once, a failure keeps the server's words.
    expect(wasAskedTwice(outcome)).toBe(false);
  }
  // A caller that gave up is not asked for again.
  const aborted = new AbortController();
  aborted.abort();
  const gaveUp = service(failed, quote);
  const history = await gaveUp.api.getCloudHistory("YAR", "OSL", { range: "1M" }, { signal: aborted.signal });
  expect(history).toEqual(failed as never);
  expect(wasAskedTwice(history)).toBe(false);
  expect(gaveUp.paths).toHaveLength(1);
});
