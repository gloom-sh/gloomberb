import { afterEach, expect, jest, test } from "bun:test";
import { getCloudApiBaseUrl } from "../../../api-client/request";
import type { DesktopBackendRequestMethod } from "../shared/protocol";
import { encodeRpcValue } from "../shared/rpc-codec";
import { createRpcLoopback } from "../../../test-support/rpc-loopback";
import { flushCrashReports, installCrashReporter, reportCrash, resetCrashReporterForTests } from "../../../telemetry/crash-reports";
import { isSleepRpcTimeout, REQUEST_TIMED_OUT_MESSAGE, type RpcClockSample, type RpcTimeoutError } from "../../../utils/rpc-timeout-error";
import { createRpcTimeoutClockProbe, nameRpcTimeout } from "./rpc-timeout";

afterEach(() => {
  jest.useRealTimers();
  resetCrashReporterForTests();
});

test("Electrobun's request timeout reports the request without its payload, and a pane says only that it timed out", async () => {
  jest.useFakeTimers();
  // The view's limit, against a Bun side that never answers.
  const send = createRpcLoopback(() => new Promise(() => {}), { maxRequestTime: 120_000 });
  const request = (method: DesktopBackendRequestMethod, payload: unknown) =>
    nameRpcTimeout(method, payload, () => send({ method, payload: encodeRpcValue(payload) })).catch((error: unknown) => error as RpcTimeoutError);

  const failures = [
    request("update.check", { currentVersion: "0.15.8" }),
    request("capability.invoke", { capabilityId: "asset-data.cloud", operationId: "getQuote", payload: { ticker: "AAPL" } }),
    request("http.fetch", { url: "https://user:secret@192.168.1.20:5000/v1/portfolio/U123?token=abc", init: { headers: { authorization: "Bearer abc" } } }),
    request("http.stream.open", { streamId: "s1", url: `${getCloudApiBaseUrl()}/cloud/chat/AAPL?draft=1` }),
  ];
  jest.advanceTimersByTime(120_000);
  const [update, capability, external, gloom] = await Promise.all(failures);

  expect(update!.message).toBe(REQUEST_TIMED_OUT_MESSAGE);
  expect(update!.report).toBe("RPC request timed out: update.check after ~120s");
  expect((update!.cause as Error).message).toBe("RPC request timed out.");
  expect(capability!.report).toBe("RPC request timed out: capability.invoke asset-data.cloud.getQuote after ~120s");
  expect(external!.report).toBe("RPC request timed out: http.fetch external after ~120s");
  expect(gloom!.report).toBe(`RPC request timed out: http.stream.open ${new URL(getCloudApiBaseUrl()).host}/cloud after ~120s`);
});

test("only measured sleep that cuts into the awake budget suppresses an RPC timeout report", async () => {
  jest.useFakeTimers();
  const request = async (elapsed: number, end: Partial<RpcClockSample> | null) => {
    const start = Date.now();
    const send = createRpcLoopback(() => new Promise(() => {}), { maxRequestTime: elapsed });
    const clock = async (fresh?: boolean) => fresh
      ? end && { wallMs: start + elapsed, elapsedMs: 10_000 + elapsed, awakeMs: 2_000 + elapsed, ...end }
      : { wallMs: start, elapsedMs: 10_000, awakeMs: 2_000 };
    const result = nameRpcTimeout("desktop.syncMainState", null, () => send({ method: "desktop.syncMainState", payload: null }), clock)
      .catch((error: unknown) => error as RpcTimeoutError);
    jest.advanceTimersByTime(elapsed);
    return result;
  };

  const sleepAt170 = await request(170_000, { awakeMs: 112_000 });
  const sleepAt230 = await request(230_000, { awakeMs: 112_000 });
  const awakeStall = await request(190_000, {});
  const missing = await request(390_000, null);
  const adjustedWallClock = await request(210_000, { elapsedMs: 100_000, awakeMs: 40_000 });
  const resetAwake = await request(200_000, { awakeMs: 100 });
  const fullAwakeBudget = await request(220_000, { awakeMs: 123_000 });
  jest.useRealTimers();

  for (const error of [sleepAt170, sleepAt230]) {
    expect(error.message).toBe(REQUEST_TIMED_OUT_MESSAGE);
    expect(isSleepRpcTimeout(error)).toBe(true);
  }
  for (const error of [awakeStall, missing, adjustedWallClock, resetAwake, fullAwakeBudget]) {
    expect(error.message).toBe(REQUEST_TIMED_OUT_MESSAGE);
    expect(isSleepRpcTimeout(error)).toBe(false);
  }

  const sent: string[] = [];
  installCrashReporter({
    surface: "desktop",
    isEnabled: () => true,
    getInstallId: () => "0f1e2d3c-4b5a-4968-8776-655443322110",
    send: async (payload) => { sent.push(...payload.errors.map((error) => error.message)); },
  });
  for (const error of [sleepAt170, sleepAt230, awakeStall, missing]) reportCrash(error, { kind: "unhandled-rejection" });
  await flushCrashReports({ timeoutMs: 500 });
  expect(sent).toEqual([
    "RPC request timed out: desktop.syncMainState after ~190s",
    "RPC request timed out: desktop.syncMainState after ~390s",
  ]);
});

test("a clock probe that is still pending cannot mask the timeout or multiply requests", async () => {
  jest.useFakeTimers();
  let probes = 0;
  const clock = createRpcTimeoutClockProbe(() => {
    probes += 1;
    return new Promise(() => {});
  });
  const send = createRpcLoopback(() => new Promise(() => {}), { maxRequestTime: 120_000 });
  const result = nameRpcTimeout("desktop.syncMainState", null, () => send({ method: "desktop.syncMainState", payload: null }), clock)
    .catch((error: unknown) => error as RpcTimeoutError);
  jest.advanceTimersByTime(120_000);
  await Promise.resolve();
  await Promise.resolve();
  jest.advanceTimersByTime(1_000);
  const error = await result;
  expect(probes).toBe(1);
  expect(error.message).toBe(REQUEST_TIMED_OUT_MESSAGE);
  expect(isSleepRpcTimeout(error)).toBe(false);
});
