import { describe, expect, test } from "bun:test";
import {
  ConnectionHealthRegistry,
  registerGloomCloudConnectionSources,
} from "../core/connection-health";
import { CloudApiRequestTransport } from "./request";

function responseWithBody(body: () => Promise<string>): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: body,
  } as Response;
}

describe("CloudApiRequestTransport connection reporting", () => {
  test("reports real FRED requests to both Gloom and FRED sources", async () => {
    const health = new ConnectionHealthRegistry();
    const dispose = registerGloomCloudConnectionSources(health);
    const transport = new CloudApiRequestTransport({
      connectionHealth: health,
      fetchTransport: async () => responseWithBody(async () => JSON.stringify({ observations: [], info: null })),
    });

    await transport.request("/cloud/econ/series/VIXCLS?limit=120&sortOrder=desc");

    expect(health.getSnapshot().sources.map((source) => ({
      id: source.id,
      status: source.status,
      operation: source.lastOperation,
    }))).toEqual([
      { id: "gloom-cloud-http", status: "connected", operation: "GET /cloud/econ/series/VIXCLS" },
      { id: "gloom-cloud-socket", status: "idle", operation: null },
      { id: "gloom-cloud-fred", status: "connected", operation: "GET /cloud/econ/series/VIXCLS" },
    ]);

    dispose();
    expect(health.getSnapshot().sources).toEqual([]);
  });
});

describe("CloudApiRequestTransport market deadlines", () => {
  test("aborts when response headers never arrive", async () => {
    let signal: AbortSignal | null | undefined;
    const transport = new CloudApiRequestTransport({
      marketRequestTimeoutMs: 10,
      fetchTransport: async (_url, init) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      },
    });

    await expect(transport.request("/market/quote?symbol=AAPL")).rejects.toThrow(
      "Cloud market request timed out after 10ms",
    );
    expect(signal?.aborted).toBe(true);
  });

  test("keeps the deadline active while reading the response body", async () => {
    let signal: AbortSignal | null | undefined;
    const transport = new CloudApiRequestTransport({
      marketRequestTimeoutMs: 10,
      fetchTransport: async (_url, init) => {
        signal = init?.signal;
        return responseWithBody(async () => new Promise<string>(() => {}));
      },
    });

    await expect(transport.request("/market/history?symbol=AAPL")).rejects.toThrow(
      "Cloud market request timed out after 10ms",
    );
    expect(signal?.aborted).toBe(true);
  });

  test("preserves a caller abort instead of replacing it with the market deadline", async () => {
    let fetchCalls = 0;
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    const transport = new CloudApiRequestTransport({
      marketRequestTimeoutMs: 100,
      fetchTransport: async () => {
        fetchCalls += 1;
        return responseWithBody(async () => "{}");
      },
    });

    await expect(transport.request("/market/quote?symbol=AAPL", {
      signal: controller.signal,
    })).rejects.toThrow("cancelled by caller");
    expect(fetchCalls).toBe(0);
  });
});
