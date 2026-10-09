import { afterEach, expect, jest, test } from "bun:test";
import { getCloudApiBaseUrl } from "../../../api-client/request";
import type { DesktopBackendRequestMethod } from "../shared/protocol";
import { encodeRpcValue } from "../shared/rpc-codec";
import { createRpcLoopback } from "../../../test-support/rpc-loopback";
import { flushCrashReports, installCrashReporter, reportCrash, resetCrashReporterForTests } from "../../../telemetry/crash-reports";
import { isSleepRpcTimeout } from "../../../utils/rpc-timeout-error";
import { nameRpcTimeout } from "./rpc-timeout";

afterEach(() => {
  jest.useRealTimers();
  resetCrashReporterForTests();
});

test("Electrobun's request timeout names the request without its payload", async () => {
  jest.useFakeTimers();
  // The view's limit, against a Bun side that never answers.
  const send = createRpcLoopback(() => new Promise(() => {}), { maxRequestTime: 120_000 });
  const request = (method: DesktopBackendRequestMethod, payload: unknown) =>
    nameRpcTimeout(method, payload, () => send({ method, payload: encodeRpcValue(payload) })).catch((error: unknown) => error as Error);

  const failures = [
    request("update.check", { currentVersion: "0.15.8" }),
    request("capability.invoke", { capabilityId: "asset-data.cloud", operationId: "getQuote", payload: { ticker: "AAPL" } }),
    request("http.fetch", { url: "https://user:secret@192.168.1.20:5000/v1/portfolio/U123?token=abc", init: { headers: { authorization: "Bearer abc" } } }),
    request("http.stream.open", { streamId: "s1", url: `${getCloudApiBaseUrl()}/cloud/chat/AAPL?draft=1` }),
  ];
  jest.advanceTimersByTime(120_000);
  const [update, capability, external, gloom] = await Promise.all(failures);

  expect(update!.message).toBe("RPC request timed out: update.check after ~120s");
  expect((update!.cause as Error).message).toBe("RPC request timed out.");
  expect(capability!.message).toBe("RPC request timed out: capability.invoke asset-data.cloud.getQuote after ~120s");
  expect(external!.message).toBe("RPC request timed out: http.fetch external after ~120s");
  expect(gloom!.message).toBe(`RPC request timed out: http.stream.open ${new URL(getCloudApiBaseUrl()).host}/cloud after ~120s`);
});

test("a timeout that fires hours late, after the machine slept, is not reported as a crash", async () => {
  jest.useFakeTimers();
  const request = (maxRequestTime: number) => {
    const send = createRpcLoopback(() => new Promise(() => {}), { maxRequestTime });
    return nameRpcTimeout("desktop.syncMainState", null, () => send({ method: "desktop.syncMainState", payload: null }))
      .catch((error: unknown) => error as Error);
  };

  const stalled = request(120_000);
  jest.advanceTimersByTime(120_000);
  const stalledError = await stalled;
  // On wake, the request timer runs four hours after the request began.
  const slept = request(14_410_000);
  jest.advanceTimersByTime(14_410_000);
  const sleptError = await slept;
  jest.useRealTimers();

  expect(sleptError.message).toBe("RPC request timed out: desktop.syncMainState after ~14410s");
  expect(isSleepRpcTimeout(stalledError)).toBe(false);
  expect(isSleepRpcTimeout(sleptError)).toBe(true);

  const sent: string[] = [];
  installCrashReporter({
    surface: "desktop",
    isEnabled: () => true,
    getInstallId: () => "0f1e2d3c-4b5a-4968-8776-655443322110",
    send: async (payload) => { sent.push(...payload.errors.map((error) => error.message)); },
  });
  reportCrash(sleptError, { kind: "unhandled-rejection" });
  reportCrash(stalledError, { kind: "unhandled-rejection" });
  await flushCrashReports({ timeoutMs: 500 });
  expect(sent).toEqual(["RPC request timed out: desktop.syncMainState after ~120s"]);
});
