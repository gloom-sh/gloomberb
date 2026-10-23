import { afterEach, expect, test } from "bun:test";
import { ApiRequestError } from "../api-client/errors";
import { CloudApiRequestTransport, setCloudApiFetchTransport } from "../api-client/request";
import { describeChatImageError } from "../plugins/builtin/chat/attachments/model";
import { inferCliErrorOptions, printCliError } from "../cli/errors";
import { overviewCliCommands } from "../cli/commands/overview";
import { noProviderError } from "../sources/provider-errors";
import { createTestCliContext } from "../test-support/cli-context";
import { captureConsole } from "../test-support/console";
import { DATA_SERVICE_UNREACHABLE_MESSAGE, DataServiceUnreachableError, isNetworkFailure } from "./network-failure";

/**
 * A request that never got an answer used to surface as whatever the fetch
 * said ("Unable to connect. Is the computer able to access the url?"), or as
 * "No quote provider available". The Cloud client now says one thing for all
 * of them, and the code that falls back to a saved copy and the CLI's error
 * output both depend on telling it apart from a server that answered.
 */

/** Bun's error for a refused connection, a refused proxy and a failed DNS lookup alike. */
const bunUnreachable = () => Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });

const originalProxy = process.env.HTTPS_PROXY;

afterEach(() => {
  setCloudApiFetchTransport(null);
  if (originalProxy === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = originalProxy;
});

test("every fetch's failure to connect reaches callers as the data service being unreachable, and an answer or an abort does not", async () => {
  const failing = (error: unknown) => new CloudApiRequestTransport({ fetchTransport: async () => { throw error; } })
    .request("/market/quote?symbol=SPY")
    .catch((caught: unknown) => caught);

  for (const error of [bunUnreachable(), new TypeError("Failed to fetch"), new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } })]) {
    const caught = await failing(error);
    expect(caught).toBeInstanceOf(DataServiceUnreachableError);
    expect(caught).toMatchObject({ message: DATA_SERVICE_UNREACHABLE_MESSAGE, cause: error });
  }
  // Code that classifies failures by code (the updater) still reads Bun's.
  expect(await failing(bunUnreachable())).toMatchObject({ code: "ConnectionRefused" });

  const answered = await new CloudApiRequestTransport({
    fetchTransport: async () => ({ ok: false, status: 502, headers: new Headers(), text: async () => "Bad gateway" }) as Response,
  }).request("/market/quote?symbol=SPY").catch((caught: unknown) => caught);
  expect(isNetworkFailure(answered)).toBe(false);

  const controller = new AbortController();
  const aborted = await new CloudApiRequestTransport({
    fetchTransport: async () => {
      controller.abort();
      throw Object.assign(bunUnreachable(), { name: "AbortError" });
    },
  }).request("/market/quote?symbol=SPY", { signal: controller.signal }).catch((caught: unknown) => caught);
  expect(aborted).not.toBeInstanceOf(DataServiceUnreachableError);
  expect(isNetworkFailure(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }))).toBe(false);
});

test("an answer from the server or a local service is never \"couldn't reach\", whatever its words or code", async () => {
  for (const answered of [
    new ApiRequestError("fetch failed", 500),
    new ApiRequestError("Failed to fetch quote from upstream", 502),
    new ApiRequestError("Upstream connection reset", 503, undefined, "ECONNRESET"),
    Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { status: 502 }),
    new Error("Failed to fetch quote from upstream"),
    new Error("Unable to connect to IB Gateway at 127.0.0.1:4001. Is it running?"),
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  ]) {
    expect(isNetworkFailure(answered)).toBe(false);
    const failing = new CloudApiRequestTransport({ fetchTransport: async () => { throw answered; } });
    expect(await failing.request("/market/quote?symbol=SPY").catch((caught: unknown) => caught)).toBe(answered);
    const json = await captureConsole(() => printCliError(answered, inferCliErrorOptions(["--json"])));
    expect(JSON.parse(json.stderr).error.code).not.toBe("service_unreachable");
  }
});

test("surfaces that point at the connection still do", () => {
  const unreachableUpload = new DataServiceUnreachableError(new TypeError("Failed to fetch"));
  expect(describeChatImageError(unreachableUpload)).toBe("The image could not be uploaded. Check your connection and try again.");
  expect(describeChatImageError(new ApiRequestError("fetch failed", 500))).toBe("fetch failed");
});

test("a router miss caused by no connection says so instead of that no provider has the symbol", () => {
  expect(noProviderError("No quote provider available for SPY", { failure: bunUnreachable() }, "SPY").message).toBe(DATA_SERVICE_UNREACHABLE_MESSAGE);
  expect(noProviderError("No quote provider available for SPY", { failure: new Error("boom") }, "SPY").message).toBe("No quote provider available for SPY");
});

test("a command that could not reach the service fails as retryable service_unreachable, naming the proxy it went through", async () => {
  process.env.HTTPS_PROXY = "http://127.0.0.1:9";
  setCloudApiFetchTransport(async () => { throw bunUnreachable(); });
  const fred = overviewCliCommands.find((command) => command.name === "fred")!;
  const error = await Promise.resolve(fred.execute(["CPIAUCSL"], createTestCliContext().context)).catch((caught: unknown) => caught);

  const json = await captureConsole(() => printCliError(error, inferCliErrorOptions(["--json"])));
  expect(JSON.parse(json.stderr).error).toEqual({
    code: "service_unreachable",
    message: DATA_SERVICE_UNREACHABLE_MESSAGE,
    details: "Check the internet connection and the proxy in HTTPS_PROXY, then try again.",
    retryable: true,
  });
  const text = await captureConsole(() => printCliError(error, inferCliErrorOptions(["--no-color"])));
  expect(text.stderr).toContain(`error: ${DATA_SERVICE_UNREACHABLE_MESSAGE}`);
  expect(text.stderr).not.toContain("Unable to connect");
});
