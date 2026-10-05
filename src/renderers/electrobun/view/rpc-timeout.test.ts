import { afterEach, expect, jest, test } from "bun:test";
import type { DesktopBackendRequestMethod } from "../shared/protocol";
import { encodeRpcValue } from "../shared/rpc-codec";
import { createRpcLoopback } from "../../../test-support/rpc-loopback";
import { nameRpcTimeout } from "./rpc-timeout";

afterEach(() => {
  jest.useRealTimers();
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
    request("http.fetch", { url: "https://user:secret@api.example.com:8443/market/quote/AAPL?token=abc", init: { headers: { authorization: "Bearer abc" } } }),
  ];
  jest.advanceTimersByTime(120_000);
  const [update, capability, http] = await Promise.all(failures);

  expect(update!.message).toBe("RPC request timed out: update.check after ~120s");
  expect((update!.cause as Error).message).toBe("RPC request timed out.");
  expect(capability!.message).toBe("RPC request timed out: capability.invoke asset-data.cloud.getQuote after ~120s");
  expect(http!.message).toBe("RPC request timed out: http.fetch api.example.com:8443 after ~120s");
});
