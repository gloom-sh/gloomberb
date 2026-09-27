import { afterEach, describe, expect, test } from "bun:test";
import {
  ConnectionHealthRegistry,
  registerGloomCloudConnectionSources,
} from "../core/connection-health";
import { ApiRequestError, RevisionConflictError } from "./errors";
import {
  CloudApiRequestTransport,
  putWithRevision,
  setCloudApiFetchTransport,
} from "./request";

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
      fetchTransport: async () =>
        responseWithBody(async () =>
          JSON.stringify({ observations: [], info: null }),
        ),
    });

    await transport.request(
      "/cloud/econ/series/VIXCLS?limit=120&sortOrder=desc",
    );

    expect(
      health.getSnapshot().sources.map((source) => ({
        id: source.id,
        status: source.status,
        operation: source.lastOperation,
      })),
    ).toEqual([
      {
        id: "gloom-cloud-http",
        status: "connected",
        operation: "GET /cloud/econ/series/VIXCLS",
      },
      { id: "gloom-cloud-socket", status: "idle", operation: null },
      {
        id: "gloom-cloud-fred",
        status: "connected",
        operation: "GET /cloud/econ/series/VIXCLS",
      },
    ]);

    dispose();
    expect(health.getSnapshot().sources).toEqual([]);
  });
});

describe("CloudApiRequestTransport streaming", () => {
  afterEach(() => setCloudApiFetchTransport(null));

  test("a buffered transport with a stream fetch can still open a live body", async () => {
    const opened: Array<{ url: string; method?: string }> = [];
    setCloudApiFetchTransport(
      async () => responseWithBody(async () => "{}"),
      {
        streamFetch: async (url, init) => {
          opened.push({ url, ...(init?.method ? { method: init.method } : {}) });
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            headers: new Headers({ "content-type": "text/event-stream" }),
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.close();
              },
            }),
          } as unknown as Response;
        },
      },
    );
    const transport = new CloudApiRequestTransport();

    expect(transport.isStreamingSupported()).toBe(true);
    const response = await transport.openStream("/askg/session/s1/turn", { method: "POST" });
    expect(response.body).toBeTruthy();
    expect(opened).toEqual([
      { url: `${transport.baseUrl}/askg/session/s1/turn`, method: "POST" },
    ]);
  });

  test("a buffered transport with no stream fetch still refuses to stream", () => {
    setCloudApiFetchTransport(async () => responseWithBody(async () => "{}"));
    expect(new CloudApiRequestTransport().isStreamingSupported()).toBe(false);
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

    await expect(
      transport.request("/market/quote?symbol=AAPL"),
    ).rejects.toThrow("Cloud market request timed out after 10ms");
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

    await expect(
      transport.request("/market/history?symbol=AAPL"),
    ).rejects.toThrow("Cloud market request timed out after 10ms");
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

    await expect(
      transport.request("/market/quote?symbol=AAPL", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled by caller");
    expect(fetchCalls).toBe(0);
  });
});

describe("putWithRevision", () => {
  class ItemConflictError extends RevisionConflictError<{ revision: number }> {}
  const refuse = async (_path: string, init?: RequestInit): Promise<never> => {
    expect(init?.headers).toEqual({ "if-match": "3" });
    throw new ApiRequestError("Edited since you opened it.", 412);
  };

  test("a 412 throws the caller's conflict with what the server holds now", async () => {
    const conflict = await putWithRevision(refuse, "/items/1", { value: 1 }, {
      expected: 3,
      loadCurrent: async () => ({ revision: 5 }),
      conflict: ItemConflictError,
    }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(ItemConflictError);
    expect(conflict).toMatchObject({ message: "Edited since you opened it.", current: { revision: 5 }, currentRevision: 5 });
  });

  test("an unreadable current version still reports the next revision", async () => {
    const conflict = await putWithRevision(refuse, "/items/1", { value: 1 }, {
      expected: 3,
      loadCurrent: async () => { throw new Error("offline"); },
      conflict: ItemConflictError,
    }).catch((error: unknown) => error);
    expect(conflict).toMatchObject({ current: null, currentRevision: 4 });
  });
});

describe("CloudApiRequestTransport errors", () => {
  test("a failure carries the body's error code next to its message", async () => {
    const answer = (status: number, body: string) => new CloudApiRequestTransport({
      fetchTransport: async () => ({ ok: false, status, headers: new Headers(), text: async () => body }) as Response,
    });

    const unsupported = await answer(422, JSON.stringify({ error: "unsupported", message: "Robinhood does not support this in Gloom." }))
      .request("/brokers/robinhood/orders")
      .catch((error: unknown) => error);
    expect(unsupported).toBeInstanceOf(ApiRequestError);
    expect(unsupported).toMatchObject({ status: 422, code: "unsupported" });

    const toolError = await answer(422, JSON.stringify({ error: "tool_error", message: "IBKR could not complete the request." }))
      .request("/brokers/ibkr/orders")
      .catch((error: unknown) => error);
    expect(toolError).toMatchObject({ status: 422, code: "tool_error" });

    const plain = await answer(502, "Bad gateway").request("/brokers/ibkr/orders").catch((error: unknown) => error);
    expect(plain).toMatchObject({ status: 502, code: undefined });
  });
});
