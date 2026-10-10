import { describe, expect, test, mock, beforeEach, afterAll } from "bun:test";
import { createThrottledFetch } from "./throttled-fetch";
import { setHttpFetchTransport } from "./http-transport";

// Mock global fetch
const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mock>;

beforeEach(() => {
  setHttpFetchTransport(null);
  fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
  globalThis.fetch = fetchMock as any;
});

describe("createThrottledFetch", () => {
  test("deduplicates concurrent GET requests to same URL", async () => {
    let resolveFirst: (r: Response) => void;
    const slowResponse = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    fetchMock = mock(() => slowResponse);
    globalThis.fetch = fetchMock as any;

    const client = createThrottledFetch();
    const p1 = client.fetch("https://api.example.com/same");
    const p2 = client.fetch("https://api.example.com/same");

    resolveFirst!(new Response("ok", { status: 200 }));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).not.toBe(r2);
    expect(await r1.text()).toBe("ok");
    expect(await r2.text()).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not deduplicate different URLs", async () => {
    const client = createThrottledFetch();
    await Promise.all([
      client.fetch("https://api.example.com/a"),
      client.fetch("https://api.example.com/b"),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["a 429", () => Promise.resolve(new Response("rate limited", { status: 429 }))],
    ["a 500", () => Promise.resolve(new Response("error", { status: 500 }))],
    ["a transient fetch failure", () => Promise.reject(
      Object.assign(new Error("The socket connection was closed unexpectedly."), {
        code: "ECONNRESET",
      }),
    )],
  ] as const)("retries after %s", async (_label, firstResponse) => {
    let callCount = 0;
    fetchMock = mock(() => {
      callCount++;
      if (callCount === 1) return firstResponse();
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    globalThis.fetch = fetchMock as any;

    const client = createThrottledFetch({ maxRetries: 1, backoffBaseMs: 0 });
    const resp = await client.fetch("https://api.example.com/test");
    expect(resp.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("stops retrying after max retries", async () => {
    fetchMock = mock(() => Promise.resolve(new Response("error", { status: 429 })));
    globalThis.fetch = fetchMock as any;

    const client = createThrottledFetch({ maxRetries: 1, backoffBaseMs: 0 });
    const resp = await client.fetch("https://api.example.com/test");
    expect(resp.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  test("fetchJson parses response and throws on error", async () => {
    const client = createThrottledFetch();
    const data = await client.fetchJson<{ ok: boolean }>("https://api.example.com/test");
    expect(data).toEqual({ ok: true });

    fetchMock = mock(() => Promise.resolve(new Response("not found", { status: 404 })));
    globalThis.fetch = fetchMock as any;
    const client2 = createThrottledFetch({ maxRetries: 0 });
    await expect(client2.fetchJson("https://api.example.com/test")).rejects.toThrow("HTTP 404");
  });

  test("fetchJson throws friendly message on 429", async () => {
    fetchMock = mock(() => Promise.resolve(new Response("", { status: 429 })));
    globalThis.fetch = fetchMock as any;

    const client = createThrottledFetch({ maxRetries: 0 });
    await expect(client.fetchJson("https://api.example.com/test")).rejects.toThrow("Rate limited");
  });

  test("uses a client-specific fetch transport", async () => {
    const transportMock = mock((url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.example.com/proxied");
      expect((init?.headers as Record<string, string>)["X-Transport"]).toBe("1");
      return Promise.resolve(new Response("proxied", { status: 202 }));
    });

    const client = createThrottledFetch({
      defaultHeaders: { "X-Transport": "1" },
      transport: transportMock,
    });
    const resp = await client.fetch("https://api.example.com/proxied");

    expect(resp.status).toBe(202);
    expect(await resp.text()).toBe("proxied");
    expect(transportMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("uses the shared HTTP transport by default", async () => {
    const transportMock = mock((url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.example.com/shared");
      expect((init?.headers as Record<string, string>)["X-Shared"]).toBe("1");
      return Promise.resolve(new Response("shared", { status: 203 }));
    });
    setHttpFetchTransport(transportMock);

    const client = createThrottledFetch({
      defaultHeaders: { "X-Shared": "1" },
    });
    const resp = await client.fetch("https://api.example.com/shared");

    expect(resp.status).toBe(203);
    expect(await resp.text()).toBe("shared");
    expect(transportMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** Like fetch: never answers, rejects with the signal's reason once it aborts. */
function hangingTransport() {
  return mock((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) { reject(signal.reason); return; }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createThrottledFetch timeouts and caller aborts", () => {
  test("a hung host times out although the caller never aborts", async () => {
    const transport = hangingTransport();
    const caller = new AbortController();
    const client = createThrottledFetch({ maxRetries: 0, timeoutMs: 20, transport });

    const error = await client.fetch("https://api.example.com/hung", { signal: caller.signal }).catch((e) => e);

    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(caller.signal.aborted).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["with a caller signal", () => new AbortController().signal],
    ["without a signal", () => undefined],
  ] as const)("retries a timed-out attempt %s", async (_label, makeSignal) => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const transport = mock((url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return signals.length === 1
        ? hangingTransport()(url, init)
        : Promise.resolve(new Response("ok", { status: 200 }));
    });
    const client = createThrottledFetch({ maxRetries: 1, timeoutMs: 20, backoffBaseMs: 0, transport });

    const resp = await client.fetch("https://api.example.com/slow", { signal: makeSignal() });

    expect(resp.status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(2);
    // Every attempt carries its own timeout, not the caller's signal.
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  test.each([
    ["an error", () => new Error("pane closed")],
    // A caller's own deadline looks like a retryable timeout but is not ours to retry.
    ["its own timeout", () => new DOMException("deadline", "TimeoutError")],
  ] as const)("a caller abort with %s rejects with its reason and neither retries nor backs off", async (_label, makeReason) => {
    const transport = hangingTransport();
    const caller = new AbortController();
    const reason = makeReason();
    const client = createThrottledFetch({ maxRetries: 2, timeoutMs: 5_000, backoffBaseMs: 60_000, transport });

    const pending = client.fetch("https://api.example.com/abort", { signal: caller.signal });
    await sleep(5);
    const startedAt = performance.now();
    caller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test("an abort during the backoff wait makes no further attempt", async () => {
    const transport = mock(() => Promise.resolve(new Response("busy", { status: 503 })));
    const caller = new AbortController();
    const client = createThrottledFetch({ maxRetries: 2, backoffBaseMs: 100, transport });

    const pending = client.fetch("https://api.example.com/backoff", { signal: caller.signal });
    await sleep(20);
    expect(transport).toHaveBeenCalledTimes(1);
    caller.abort();

    await expect(pending).rejects.toBe(caller.signal.reason);
    await sleep(250);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  test("a signal that is already aborted never reaches the transport", async () => {
    const transport = mock(() => Promise.resolve(new Response("ok", { status: 200 })));
    const reason = new Error("gone");
    const client = createThrottledFetch({ transport });

    await expect(
      client.fetch("https://api.example.com/aborted", { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(transport).not.toHaveBeenCalled();
  });
});

// Restore
afterAll(() => {
  setHttpFetchTransport(null);
  globalThis.fetch = originalFetch;
});
