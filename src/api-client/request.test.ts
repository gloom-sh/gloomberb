import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
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
import { OperationTimeoutError } from "../utils/async-deadline";
import { debugLog } from "../utils/debug-log";

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

  test("a cold market read that takes twelve seconds can finish when the service answers health", async () => {
    jest.useFakeTimers();
    const paths: string[] = [];
    const transport = new CloudApiRequestTransport({ fetchTransport: async (url) => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname === "/health") return Response.json({ ok: true });
      return new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json({ prices: [42] })), 12_000));
    } });
    const read = transport.request("/market/history?symbol=LMT").catch((error: unknown) => error);
    jest.advanceTimersByTime(4_000);
    await flush();
    jest.advanceTimersByTime(8_000);
    expect(await read).toEqual({ prices: [42] });
    expect(paths).toEqual(["/market/history", "/health"]);
  });

  test("a stalled health check gets a second chance within the same answer deadline", async () => {
    jest.useFakeTimers();
    const probes: AbortSignal[] = [];
    const transport = new CloudApiRequestTransport({ fetchTransport: async (url, init) => {
      if (new URL(url).pathname !== "/health") {
        return new Promise<Response>((resolve) => setTimeout(() => resolve(Response.json({ deals: [] })), 12_000));
      }
      probes.push(init!.signal!);
      return probes.length === 1 ? new Promise<Response>(() => {}) : Response.json({ ok: true });
    } });
    const read = transport.request("/cloud/ipo/calendar").catch((error: unknown) => error);
    jest.advanceTimersByTime(7_000);
    await flush();
    jest.advanceTimersByTime(5_000);
    expect(await read).toEqual({ deals: [] });
    expect(probes).toHaveLength(2);
    expect(probes[0]?.aborted).toBe(true);
  });

  test("a read that never finishes on a reachable service times out without recording an outage", async () => {
    jest.useFakeTimers();
    const health = new ConnectionHealthRegistry();
    registerGloomCloudConnectionSources(health);
    const signals = new Map<string, AbortSignal>();
    const transport = new CloudApiRequestTransport({ connectionHealth: health, fetchTransport: async (url, init) => {
      const path = new URL(url).pathname;
      // The check that the service answers at all gets an answer; the reads themselves are slow.
      if (path === "/health") return responseWithBody(async () => "{}");
      signals.set(path, init!.signal!);
      return new Promise<Response>(() => {});
    } });
    const quote = transport.request("/market/quote?symbol=AAPL").catch(error => error);
    const research = transport.request("/market/dividends?symbol=AAPL").catch(error => error);
    jest.advanceTimersByTime(4_000);
    await flush();
    jest.advanceTimersByTime(6_000);
    expect(signals.get("/market/quote")?.aborted).toBe(false);
    jest.advanceTimersByTime(15_000);
    expect(signals.get("/market/quote")?.aborted).toBe(true);
    expect(signals.get("/market/dividends")?.aborted).toBe(false);
    const slowQuote = await quote;
    expect(slowQuote).toBeInstanceOf(OperationTimeoutError);
    expect(slowQuote.message).toBe("Cloud market request timed out after 25000ms");
    expect(isNetworkFailure(slowQuote)).toBe(false);
    expect(health.unreachableSince("gloom-cloud-http")).toBeNull();
    jest.advanceTimersByTime(20_000);
    expect(signals.get("/market/dividends")?.aborted).toBe(true);
    expect((await research).message).toContain("45000ms");
  });

  // A proxy that accepts and never answers left `quote` and `search` running
  // and printing nothing, or "No quote provider available", long after a
  // refused connection would have said "couldn't reach".
  test("a request nothing answers fails as the data service being unreachable, and the next one does not wait it out again", async () => {
    jest.useFakeTimers();
    const health = new ConnectionHealthRegistry();
    registerGloomCloudConnectionSources(health);
    const asked: string[] = [];
    const signals = new Map<string, AbortSignal>();
    const transport = new CloudApiRequestTransport({ connectionHealth: health, fetchTransport: async (url, init) => {
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
    expect(health.unreachableSince("gloom-cloud-http")).not.toBeNull();

    asked.length = 0;
    await expect(transport.request("/market/financials?symbol=AAPL")).rejects.toBeInstanceOf(DataServiceUnreachableError);
    await expect(transport.request("/cloud/ipo/calendar")).rejects.toBeInstanceOf(DataServiceUnreachableError);
    expect(asked).toEqual([]);
    transport.dispose();
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

  // A server from before yearly billing answers its status with 404: the Pro
  // tab then shows no yearly row, and Cloud must not read as failing for it.
  test("the yearly billing status a server does not have yet is not a Cloud failure", async () => {
    const health = new ConnectionHealthRegistry();
    registerGloomCloudConnectionSources(health);
    const transport = new CloudApiRequestTransport({ connectionHealth: health, fetchTransport: async () => ({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: "Not Found" }),
    }) as Response });
    try {
      await expect(transport.request("/stripe/subscription/yearly", { method: "GET" })).rejects.toBeInstanceOf(ApiRequestError);
      const cloud = health.getSnapshot().sources.find((source) => source.id === "gloom-cloud-http");
      expect(cloud?.status).toBe("idle");
      expect(cloud?.lastError).toBeNull();
      expect(health.unreachableSince("gloom-cloud-http")).toBeNull();
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

    const error = await transport.request("/market/history?symbol=AAPL").catch((caught: unknown) => caught as Error);
    // Reports print the message: it says what timed out, never the service's endpoint, which the debug log keeps.
    expect(error.message).toBe("Cloud market request timed out after 10ms");
    expect(debugLog.getEntries({ source: "cloud-api" }).at(-1)).toMatchObject({ message: "Cloud market request timed out after 10ms", data: { endpoint: "/market/history" } });
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

// A deploy moves traffic to new servers and stops the old ones. The
// requests caught on an old one lost their connection, or got its "going
// away" answer, and the panes that sent them showed an error.
describe("CloudApiRequestTransport reads cut off by a server restart", () => {
  afterEach(() => jest.restoreAllMocks());

  /** Bun's error for a connection that closed under the request. */
  const dropped = () =>
    Object.assign(new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()"), { code: "ECONNRESET" });
  const answer = (status: number, body: string, headers: Record<string, string> = {}) =>
    ({ ok: status < 400, status, headers: new Headers(headers), text: async () => body }) as Response;

  function transportAnswering(...answers: Array<(() => Response) | Record<string, string>>) {
    const asked: string[] = [];
    const health = new ConnectionHealthRegistry();
    registerGloomCloudConnectionSources(health);
    // A leading record is the variables the transport reads a proxy from.
    const proxyEnvironment = typeof answers[0] === "object" ? answers.shift() as Record<string, string> : undefined;
    const transport = new CloudApiRequestTransport({
      connectionHealth: health,
      ...(proxyEnvironment ? { proxyEnvironment } : {}),
      fetchTransport: async (url, init) => {
        asked.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        const next = answers.shift() as (() => Response) | undefined;
        if (!next) throw new Error("asked once too often");
        return next();
      },
    });
    return { asked, health, transport };
  }

  test("a read whose connection drops is asked again once, and its answer is not an outage", async () => {
    spyOn(Math, "random").mockReturnValue(0);
    const { asked, health, transport } = transportAnswering(
      () => { throw dropped(); },
      () => answer(200, JSON.stringify({ teams: [] })),
    );
    await expect(transport.request("/teams")).resolves.toEqual({ teams: [] });
    expect(asked).toEqual(["GET /teams", "GET /teams"]);
    expect(health.unreachableSince("gloom-cloud-http")).toBeNull();
    transport.dispose();
  });

  test("a batch quote read is asked again, and a write is never sent twice", async () => {
    spyOn(Math, "random").mockReturnValue(0);
    const quotes = transportAnswering(
      () => { throw dropped(); },
      () => answer(200, JSON.stringify({ items: [] })),
    );
    await expect(quotes.transport.request("/market/quotes/batch", { method: "POST", body: "{}" })).resolves.toEqual({ items: [] });
    expect(quotes.asked).toEqual(["POST /market/quotes/batch", "POST /market/quotes/batch"]);

    // The first may have reached the server before its connection dropped.
    const write = transportAnswering(() => { throw dropped(); });
    await expect(write.transport.request("/chat/channels/everyone/messages", { method: "POST", body: "{}" })).rejects.toThrow();
    expect(write.asked).toEqual(["POST /chat/channels/everyone/messages"]);
  });

  test("a server going away is asked again, and a 503 that is the service's answer is not", async () => {
    spyOn(Math, "random").mockReturnValue(0);
    const restarting = transportAnswering(
      () => answer(503, "Server shutting down", { "Retry-After": "0", Connection: "close" }),
      () => answer(502, "<html>502 Bad Gateway</html>", { "Content-Type": "text/html" }),
    );
    // Once only: a second failure is the service's state.
    await expect(restarting.transport.request("/theses")).rejects.toMatchObject({ status: 502 });
    expect(restarting.asked).toEqual(["GET /theses", "GET /theses"]);

    const notReady = transportAnswering(() => answer(503, JSON.stringify({ message: "Fund holdings have not been collected yet" })));
    await expect(notReady.transport.request("/cloud/members/ARKK")).rejects.toMatchObject({ status: 503 });
    expect(notReady.asked).toEqual(["GET /cloud/members/ARKK"]);

    // The API's own 502: an upstream it reads failed, which asking again at once does not mend.
    const upstream = transportAnswering(() => answer(502, JSON.stringify({ message: "The feed did not answer" }), { "Content-Type": "application/json" }));
    await expect(upstream.transport.request("/news/rss")).rejects.toMatchObject({ status: 502 });
    expect(upstream.asked).toEqual(["GET /news/rss"]);
  });

  test("a proxy that refuses to reach the service is no answer of the service's: the service is unreachable", async () => {
    spyOn(Math, "random").mockReturnValue(0);
    // The proxy is read from the transport's own variables: setting the process's would send every later fetch in
    // this test run through a proxy that is not there.
    const proxied = { HTTPS_PROXY: "http://127.0.0.1:7392" };
    // What Bun 1.3 hands back when the proxy answers CONNECT with a 502: its own status and body, no JSON. A 502
    // that is not JSON is asked again once, as a server going away is.
    const refusal = () => answer(502, "Bad Gateway", { "Content-Length": "11", Connection: "close" });
    const refused = transportAnswering(proxied, refusal, refusal);
    const error = await refused.transport.request("/market/search?q=galicia").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DataServiceUnreachableError);
    expect(refused.health.unreachableSince("gloom-cloud-http")).not.toBeNull();
    refused.transport.dispose();
    // Through the same proxy, the service's own 502 is its answer.
    const upstream = transportAnswering(proxied, () => answer(502, JSON.stringify({ message: "The feed did not answer" }), { "Content-Type": "application/json" }));
    await expect(upstream.transport.request("/news/rss")).rejects.toMatchObject({ status: 502 });
    // Without a proxy set, a 502 is the service's, as it always was.
    const direct = transportAnswering({}, () => answer(502, "Bad Gateway"), () => answer(502, "Bad Gateway"));
    await expect(direct.transport.request("/theses")).rejects.toBeInstanceOf(ApiRequestError);
  });

  test("a timeout is not asked again, and a caller who gives up during the pause stops it", async () => {
    const timedOut = transportAnswering(() => { throw new DOMException("The operation timed out.", "TimeoutError"); });
    await expect(timedOut.transport.request("/teams")).rejects.toThrow();
    expect(timedOut.asked).toEqual(["GET /teams"]);

    const controller = new AbortController();
    const giveUp = transportAnswering(() => {
      // Inside the pause before asking again, which is at least 100 ms.
      setTimeout(() => controller.abort(new Error("cancelled by caller")), 10);
      throw dropped();
    });
    await expect(giveUp.transport.request("/teams", { signal: controller.signal })).rejects.toThrow("cancelled by caller");
    expect(giveUp.asked).toEqual(["GET /teams"]);
  });
});

// The service answers a filing text read 503 with a Retry-After of 2 to 600 s
// when the SEC turns it away or its line to the SEC stays busy. INS and the
// SEC pane showed each such filing as not read.
describe("CloudApiRequestTransport filing text told to come back", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const FILING = "/cloud/sec/filing/content?cik=80424&accession=0001127602-26-021734&form=4";
  const READ = "GET /cloud/sec/filing/content";
  const busy = (retryAfter: string) => () => ({
    ok: false, status: 503, headers: new Headers({ "Retry-After": retryAfter, "Content-Type": "application/json" }), text: async () => JSON.stringify({ message: "SEC filing text is busy; try again shortly" }),
  }) as Response;
  const text = () => Response.json({ content: "<ownershipDocument/>" });
  const flush = async () => {
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
  };

  function transportAnswering(...answers: Array<() => Response | Promise<Response>>) {
    const asked: string[] = [];
    const health = new ConnectionHealthRegistry();
    registerGloomCloudConnectionSources(health);
    const transport = new CloudApiRequestTransport({
      connectionHealth: health,
      fetchTransport: async (url, init) => {
        asked.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
        const next = answers.shift();
        if (!next) throw new Error("asked once too often");
        return next();
      },
    });
    return { asked, health, transport };
  }

  test("is asked once more after the whole wait it was told, up to four seconds, and the wait is no outage", async () => {
    jest.useFakeTimers();
    // The text comes seven seconds after it is asked again: eleven in all, past the ten an unanswered request waits.
    const { asked, health, transport } = transportAnswering(busy("4"), () => new Promise<Response>((resolve) => setTimeout(() => resolve(text()), 7_000)));
    const read = transport.request(FILING).catch((error: unknown) => error);
    await flush();
    jest.advanceTimersByTime(3_999);
    await flush();
    expect(asked).toEqual([READ]);
    jest.advanceTimersByTime(1);
    await flush();
    expect(asked).toEqual([READ, READ]);
    jest.advanceTimersByTime(7_000);
    expect(await read).toEqual({ content: "<ownershipDocument/>" });
    // No check whether the service answers: it had.
    expect(asked).toEqual([READ, READ]);
    expect(health.unreachableSince("gloom-cloud-http")).toBeNull();
  });

  test("a longer wait, or one that is no number of seconds, is not cut short: the read fails as before", async () => {
    for (const retryAfter of ["5", "600", "2.5", "soon", "", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
      const { asked, transport } = transportAnswering(busy(retryAfter));
      await expect(transport.request(FILING)).rejects.toMatchObject({ status: 503 });
      expect(asked).toEqual([READ]);
    }
    // Only the filing text: another read's 503 stands as the service's answer.
    const other = transportAnswering(busy("2"));
    await expect(other.transport.request("/cloud/sec/filing/documents?cik=80424")).rejects.toMatchObject({ status: 503 });
    expect(other.asked).toEqual(["GET /cloud/sec/filing/documents"]);
  });

  test("is asked again once in all: a second 503 stands, after a server going away too", async () => {
    jest.useFakeTimers();
    const twice = transportAnswering(busy("2"), busy("2"));
    const read = twice.transport.request(FILING).catch((error: unknown) => error);
    await flush();
    jest.advanceTimersByTime(2_000);
    await flush();
    jest.advanceTimersByTime(10_000);
    expect(await read).toMatchObject({ status: 503, retryAfterMs: 2_000 });
    expect(twice.asked).toEqual([READ, READ]);

    spyOn(Math, "random").mockReturnValue(0);
    const restarted = transportAnswering(busy("0"), busy("3"));
    const after = restarted.transport.request(FILING).catch((error: unknown) => error);
    await flush();
    jest.advanceTimersByTime(100);
    await flush();
    jest.advanceTimersByTime(10_000);
    expect(await after).toMatchObject({ status: 503 });
    expect(restarted.asked).toEqual([READ, READ]);
  });

  test("a caller who gives up during the wait stops it, and nothing is asked after", async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const { asked, transport } = transportAnswering(busy("3"), text);
    const read = transport.request(FILING, { signal: controller.signal }).catch((error: unknown) => error);
    await flush();
    jest.advanceTimersByTime(1_000);
    controller.abort(new Error("INS closed"));
    expect(await read).toMatchObject({ message: "INS closed" });
    jest.advanceTimersByTime(10_000);
    await flush();
    expect(asked).toEqual([READ]);
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
