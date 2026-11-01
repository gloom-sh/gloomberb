import { afterEach, describe, expect, jest, test } from "bun:test";
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
import { DataServiceUnreachableError, isNetworkFailure } from "../utils/network-failure";

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
  afterEach(() => jest.useRealTimers());

  const flush = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };

  test("a slow service that answers keeps research waiting to its own limit, while a quote stops at ten seconds", async () => {
    jest.useFakeTimers();
    const signals = new Map<string, AbortSignal>();
    const transport = new CloudApiRequestTransport({ fetchTransport: async (url, init) => {
      const path = new URL(url).pathname;
      // The check that the service answers at all gets an answer; the reads themselves are slow.
      if (path === "/health") return responseWithBody(async () => "{}");
      signals.set(path, init!.signal!);
      return new Promise<Response>(() => {});
    } });
    const quote = transport.request("/market/quote?symbol=AAPL").catch(error => error);
    const research = transport.request("/market/dividends?symbol=AAPL").catch(error => error);
    jest.advanceTimersByTime(7_000);
    await flush();
    jest.advanceTimersByTime(3_000);
    expect(signals.get("/market/quote")?.aborted).toBe(true);
    expect(signals.get("/market/dividends")?.aborted).toBe(false);
    const slowQuote = await quote;
    expect(slowQuote.message).toContain("10000ms");
    expect(isNetworkFailure(slowQuote)).toBe(false);
    jest.advanceTimersByTime(35_000);
    expect(signals.get("/market/dividends")?.aborted).toBe(true);
    expect((await research).message).toContain("45000ms");
  });

  // A proxy that accepts and never answers left `quote` and `search` running
  // and printing nothing, or "No quote provider available", long after a
  // refused connection would have said "couldn't reach".
  test("a request nothing answers fails as the data service being unreachable, and the next one does not wait it out again", async () => {
    jest.useFakeTimers();
    const asked: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const transport = new CloudApiRequestTransport({ fetchTransport: async (url, init) => {
      const path = new URL(url).pathname;
      asked.push(path);
      signals.set(path, init!.signal!);
      return new Promise<Response>(() => {});
    } });
    const quote = transport.request("/market/quote?symbol=AAPL").catch(error => error);
    const research = transport.request("/market/dividends?symbol=AAPL").catch(error => error);
    const search = transport.request("/market/search?q=tenaris").catch(error => error);
    jest.advanceTimersByTime(4_000);
    expect(await search).toBeInstanceOf(DataServiceUnreachableError);
    jest.advanceTimersByTime(3_000);
    await flush();
    jest.advanceTimersByTime(3_000);
    for (const failed of [await quote, await research]) {
      expect(failed).toBeInstanceOf(DataServiceUnreachableError);
      expect(isNetworkFailure(failed)).toBe(true);
    }
    expect(signals.get("/market/quote")?.aborted).toBe(true);
    expect(signals.get("/market/dividends")?.aborted).toBe(true);

    asked.length = 0;
    await expect(transport.request("/market/financials?symbol=AAPL")).rejects.toBeInstanceOf(DataServiceUnreachableError);
    expect(asked).toEqual([]);
  });

  // After an outage nothing asked again for what had failed, and nothing said
  // the app was offline: the transport knew, and kept it to itself.
  test("an outage marks the data service unreachable, and the first answer after it ends it and is heard once", async () => {
    const health = new ConnectionHealthRegistry();
    registerGloomCloudConnectionSources(health);
    const recovered: string[] = [];
    health.subscribeRecovery((sourceId) => recovered.push(sourceId));
    let online = false;
    const transport = new CloudApiRequestTransport({ connectionHealth: health, fetchTransport: async () => {
      if (!online) throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
      return responseWithBody(async () => "{}");
    } });

    await expect(transport.request("/market/quote?symbol=AAPL")).rejects.toBeInstanceOf(DataServiceUnreachableError);
    await expect(transport.request("/market/quote?symbol=MSFT")).rejects.toBeInstanceOf(DataServiceUnreachableError);
    expect(health.unreachableSince("gloom-cloud-http")).not.toBeNull();
    expect(recovered).toEqual([]);

    online = true;
    await transport.request("/market/quote?symbol=AAPL");
    await transport.request("/market/quote?symbol=MSFT");
    expect(health.unreachableSince("gloom-cloud-http")).toBeNull();
    expect(recovered).toEqual(["gloom-cloud-http"]);
    transport.dispose();
  });

  // A stream that ticked while requests failed (a proxy that let it through)
  // ended the outage at every frame, and the next failed request began it
  // again: the note flickered and the panes reloaded at the tick rate.
  test("the quote stream answering checks the service over HTTP, at most once in two seconds, instead of ending the outage", async () => {
    jest.useFakeTimers();
    const health = new ConnectionHealthRegistry();
    registerGloomCloudConnectionSources(health);
    const recovered: string[] = [];
    health.subscribeRecovery((sourceId) => recovered.push(sourceId));
    let online = false;
    let checks = 0;
    const transport = new CloudApiRequestTransport({ connectionHealth: health, fetchTransport: async (url) => {
      if (new URL(url).pathname === "/health") checks += 1;
      if (!online) throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
      return responseWithBody(async () => "{}");
    } });
    try {
      await transport.request("/market/quote?symbol=AAPL").catch(() => {});
      for (let frame = 0; frame < 50; frame += 1) transport.noteServiceAnswered();
      await flush();
      expect(checks).toBe(1);
      jest.advanceTimersByTime(1_000);
      transport.noteServiceAnswered();
      await flush();
      expect(checks).toBe(1);
      expect(health.unreachableSince("gloom-cloud-http")).not.toBeNull();
      expect(recovered).toEqual([]);

      online = true;
      jest.advanceTimersByTime(1_000);
      transport.noteServiceAnswered();
      await flush();
      expect(checks).toBe(2);
      expect(health.unreachableSince("gloom-cloud-http")).toBeNull();
      expect(recovered).toEqual(["gloom-cloud-http"]);
    } finally {
      transport.dispose();
    }
  });

  // An ad blocker refuses /telemetry/ in a browser that reaches everything
  // else: each blocked report said the app was offline and reloaded the panes.
  test("background traffic that never gets out says nothing of whether the service answers", async () => {
    jest.useFakeTimers();
    const health = new ConnectionHealthRegistry();
    registerGloomCloudConnectionSources(health);
    const recovered: string[] = [];
    health.subscribeRecovery((sourceId) => recovered.push(sourceId));
    const asked: string[] = [];
    const transport = new CloudApiRequestTransport({ connectionHealth: health, fetchTransport: async (url) => {
      const path = new URL(url).pathname;
      asked.push(path);
      if (path.startsWith("/telemetry/")) throw new TypeError("Failed to fetch");
      return responseWithBody(async () => "{}");
    } });
    try {
      await expect(transport.request("/telemetry/events", { method: "POST", body: "{}" })).rejects.toBeInstanceOf(DataServiceUnreachableError);
      expect(health.unreachableSince("gloom-cloud-http")).toBeNull();
      jest.advanceTimersByTime(30_000);
      await flush();
      await transport.request("/market/quote?symbol=AAPL");
      expect(asked).toEqual(["/telemetry/events", "/market/quote"]);
      expect(recovered).toEqual([]);
    } finally {
      transport.dispose();
    }
  });

  // A web page offline asked nothing more once its panes had failed, so the
  // outage never ended: nothing was left to get the answer that ends it.
  test("an unreachable service is checked again on its own, backing off, until it answers", async () => {
    jest.useFakeTimers();
    const health = new ConnectionHealthRegistry();
    registerGloomCloudConnectionSources(health);
    let online = false;
    const checks: number[] = [];
    const startedAt = Date.now();
    const transport = new CloudApiRequestTransport({ connectionHealth: health, fetchTransport: async (url) => {
      if (new URL(url).pathname === "/health") checks.push(Date.now() - startedAt);
      if (!online) throw Object.assign(new Error("Unable to connect. Is the computer able to access the url?"), { code: "ConnectionRefused" });
      return responseWithBody(async () => "{}");
    } });
    try {
      await transport.request("/market/quote?symbol=AAPL").catch(() => {});
      for (const step of [2_000, 4_000, 8_000]) {
        jest.advanceTimersByTime(step);
        await flush();
      }
      expect(checks).toEqual([2_000, 6_000, 14_000]);
      expect(health.unreachableSince("gloom-cloud-http")).not.toBeNull();

      // Stopped, the checks start again with the next request that goes unanswered.
      transport.dispose();
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(checks).toHaveLength(3);
      await transport.request("/market/quote?symbol=AAPL").catch(() => {});
      jest.advanceTimersByTime(15_000);
      await flush();
      expect(checks).toHaveLength(4);

      online = true;
      jest.advanceTimersByTime(15_000);
      await flush();
      expect(health.unreachableSince("gloom-cloud-http")).toBeNull();
      jest.advanceTimersByTime(60_000);
      await flush();
      expect(checks).toHaveLength(5);
    } finally {
      transport.dispose();
    }
  });

  // Some searches take five seconds on a working connection. One that slow
  // made the client take the connection for hung and refuse to send anything
  // for five seconds, so `search insur` exited non-zero.
  test("a slow search on a service that answers is waited for, and the requests after it are sent", async () => {
    jest.useFakeTimers();
    const asked: string[] = [];
    const transport = new CloudApiRequestTransport({ fetchTransport: async (url) => {
      const path = new URL(url).pathname;
      asked.push(path);
      const body = responseWithBody(async () => JSON.stringify([{ symbol: "INSW" }]));
      return path === "/market/search" ? new Promise<Response>((resolve) => setTimeout(() => resolve(body), 4_900)) : body;
    } });
    const search = transport.request("/market/search?q=insur");
    jest.advanceTimersByTime(1_000);
    await flush();
    jest.advanceTimersByTime(3_900);
    expect(await search).toEqual([{ symbol: "INSW" }]);

    expect(await transport.request("/market/quote?symbol=INSW")).toEqual([{ symbol: "INSW" }]);
    expect(asked).toEqual(["/market/search", "/health", "/market/quote"]);
  });

  test("injected deadlines also govern research requests", async () => {
    const transport = new CloudApiRequestTransport({ marketRequestTimeoutMs: 10, fetchTransport: async () => new Promise<Response>(() => {}) });
    const error = await transport.request("/market/earnings-calendar?symbols=AAPL").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataServiceUnreachableError);
    expect(String((error as Error).cause)).toContain("timed out after 10ms");
  });

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
    ).rejects.toBeInstanceOf(DataServiceUnreachableError);
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

describe("CloudApiRequestTransport shared reads", () => {
  test("identical GETs asked while one is out share it, and one caller giving up leaves it to the others", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const { promise: body, resolve: answer } = Promise.withResolvers<string>();
    const transport = new CloudApiRequestTransport({
      fetchTransport: async (_url, init) => {
        signals.push(init?.signal);
        return responseWithBody(() => body);
      },
    });
    const leaving = new AbortController();
    const first = transport.request<{ price: number }>("/market/quote?symbol=NVDA");
    const second = transport.request<{ price: number }>("/market/quote?symbol=NVDA", { signal: leaving.signal });
    const other = transport.request("/market/quote?symbol=AAPL");
    const posted = transport.request("/market/quote?symbol=NVDA", { method: "POST", body: "{}" });
    leaving.abort(new Error("pane closed"));
    await expect(second).rejects.toThrow("pane closed");
    answer(JSON.stringify({ price: 1 }));
    const [nvda] = await Promise.all([first, other, posted]);
    expect(nvda).toEqual({ price: 1 });
    expect(signals).toHaveLength(3);
    expect(signals[0]?.aborted).toBe(false);
    // Asked again once the answer is in, it goes out again.
    await transport.request("/market/quote?symbol=NVDA");
    expect(signals).toHaveLength(4);
  });

  test("the last caller to give up cancels the request", async () => {
    let signal: AbortSignal | null | undefined;
    const transport = new CloudApiRequestTransport({
      fetchTransport: async (_url, init) => {
        signal = init?.signal;
        return new Promise<Response>(() => {});
      },
    });
    const a = new AbortController();
    const b = new AbortController();
    const first = transport.request("/market/history?symbol=NVDA", { signal: a.signal });
    const second = transport.request("/market/history?symbol=NVDA", { signal: b.signal });
    a.abort(new Error("a left"));
    await expect(first).rejects.toThrow("a left");
    expect(signal?.aborted).toBe(false);
    b.abort(new Error("b left"));
    await expect(second).rejects.toThrow("b left");
    expect(signal?.aborted).toBe(true);
  });
});

describe("CloudApiRequestTransport shared reads after a change", () => {
  function pendingReads() {
    const bodies: Array<(text: string) => void> = [];
    const asked: string[] = [];
    const transport = new CloudApiRequestTransport({
      fetchTransport: async (url, init) => {
        asked.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        if ((init?.method ?? "GET") !== "GET") return new Response("{}");
        const { promise, resolve } = Promise.withResolvers<string>();
        bodies.push(resolve);
        return responseWithBody(() => promise);
      },
    });
    return { transport, asked, answerAll: () => bodies.forEach((answer) => answer("{}")) };
  }

  test("a GET asked after a write, or during one, goes out again", async () => {
    const { transport, asked, answerAll } = pendingReads();
    const before = transport.request("/market/quote?symbol=NVDA");
    await transport.request("/brokers/alpaca/orders", { method: "POST", body: "{}" });
    const after = transport.request("/market/quote?symbol=NVDA");
    // A batch read sent as a POST changes nothing: the next GET still joins.
    await transport.request("/market/quotes/batch", { method: "POST", body: "{}" });
    const joined = transport.request("/market/quote?symbol=NVDA");
    answerAll();
    await Promise.all([before, after, joined]);
    expect(asked).toEqual(["GET /market/quote", "POST /brokers/alpaca/orders", "GET /market/quote", "POST /market/quotes/batch"]);
  });

  test("only market reads are shared, and not when the caller wants a fresh copy", async () => {
    const { transport, asked, answerAll } = pendingReads();
    const reads = [
      transport.request("/market/history?symbol=NVDA"),
      transport.request("/market/history?symbol=NVDA", { cache: "no-cache" }),
      transport.request("/cloud/sec/13f/funds?name=Berkshire"),
      transport.request("/cloud/sec/13f/funds?name=Berkshire"),
    ];
    answerAll();
    await Promise.all(reads);
    expect(asked).toEqual(["GET /market/history", "GET /market/history", "GET /cloud/sec/13f/funds", "GET /cloud/sec/13f/funds"]);
  });

  test("a GET asked after signing in or out, or after the session changes, goes out again", async () => {
    const { transport, asked, answerAll } = pendingReads();
    transport.setCookieSessionMode(true);
    const signedOut = transport.request("/market/quote?symbol=NVDA");
    await transport.request("/auth/sign-in/email", { method: "POST", body: "{}" });
    const signedIn = transport.request("/market/quote?symbol=NVDA");
    transport.forgetSharedReads();
    const otherAccount = transport.request("/market/quote?symbol=NVDA");
    answerAll();
    await Promise.all([signedOut, signedIn, otherAccount]);
    expect(asked.filter((line) => line.startsWith("GET"))).toHaveLength(3);
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
