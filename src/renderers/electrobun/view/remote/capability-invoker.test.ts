import { describe, expect, test } from "bun:test";
import { createCapabilityInvoker } from "./capability-invoker";

describe("createCapabilityInvoker", () => {
  test("keeps timed-out calls deduped until the raw backend request settles", async () => {
    let requestCount = 0;
    const rawResolvers: Array<(value: unknown) => void> = [];
    const invoke = createCapabilityInvoker({
      request: <T>() => {
        requestCount += 1;
        return new Promise<T>((resolve) => {
          rawResolvers.push((value) => resolve(value as T));
        });
      },
      shouldApplyDeadline: (capabilityId) => capabilityId.startsWith("asset-data."),
      timeoutMs: 10,
    });
    const payload = { ticker: "AAPL", exchange: "NASDAQ" };

    const first = invoke("asset-data.asset-data-router", "getQuote", payload);
    const duplicate = invoke("asset-data.asset-data-router", "getQuote", payload);
    expect(duplicate).toBe(first);
    expect(requestCount).toBe(1);
    await expect(first).rejects.toThrow("Asset data request timed out after 10ms");

    const retryWhileRawPending = invoke(
      "asset-data.asset-data-router",
      "getQuote",
      payload,
    );
    expect(retryWhileRawPending).toBe(first);
    await expect(retryWhileRawPending).rejects.toThrow(
      "Asset data request timed out after 10ms",
    );
    expect(requestCount).toBe(1);

    rawResolvers[0]?.({ price: 100 });
    await Promise.resolve();
    await Promise.resolve();

    const retryAfterRawSettles = invoke(
      "asset-data.asset-data-router",
      "getQuote",
      payload,
    );
    expect(requestCount).toBe(2);
    rawResolvers[1]?.({ price: 101 });
    await expect(retryAfterRawSettles).resolves.toEqual({ price: 101 });
  });

  test("sends scoped cancellation for an aborted invocation and removes settled listeners", async () => {
    const invokes: Array<Record<string, unknown>> = [];
    const cancellations: Array<Record<string, unknown>> = [];
    let rejectInvoke: ((error: unknown) => void) | undefined;
    const invoke = createCapabilityInvoker({
      request: <T>(method: string, payload: unknown) => {
        if (method === "capability.cancel") {
          cancellations.push(payload as Record<string, unknown>);
          rejectInvoke?.(new DOMException("Aborted", "AbortError"));
          return Promise.resolve(null as T);
        }
        invokes.push(payload as Record<string, unknown>);
        return new Promise<T>((_resolve, reject) => {
          rejectInvoke = reject;
        });
      },
      shouldApplyDeadline: () => false,
      timeoutMs: 0,
    });
    const controller = new AbortController();

    const pending = invoke("prediction-markets.series", "search", { query: "rates" }, {
      signal: controller.signal,
    }).catch((error) => error);
    controller.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });

    expect(cancellations).toEqual([{ invocationId: invokes[0]?.invocationId }]);

    let settledCancellations = 0;
    const settledInvoke = createCapabilityInvoker({
      request: <T>(method: string) => {
        if (method === "capability.cancel") settledCancellations += 1;
        return Promise.resolve("done" as T);
      },
      shouldApplyDeadline: () => false,
      timeoutMs: 0,
    });
    const settledController = new AbortController();
    await settledInvoke("prediction-markets.series", "catalog", {}, {
      signal: settledController.signal,
    });
    settledController.abort();
    expect(settledCancellations).toBe(0);
  });
});
