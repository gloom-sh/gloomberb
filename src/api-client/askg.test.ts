import { describe, expect, test } from "bun:test";
import {
  classifyASKGRequestError,
  createSseDecoder,
  readASKGEventStream,
  CloudASKGApi,
} from "./askg";
import { ApiRequestError } from "./errors";
import type { ASKGSseEvent } from "../plugins/builtin/cloud/askg/protocol";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function frame(event: Record<string, unknown>): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("createSseDecoder", () => {
  test("joins frames split across chunks and drops keep-alive comments", () => {
    const decoder = createSseDecoder();
    expect(decoder.push("id: 1\nevent: text-delta\nda")).toEqual([]);
    expect(decoder.push('ta: {"a":1}\n')).toEqual([]);
    const frames = decoder.push("\n: keep-alive\n\nid: 2\ndata: {\"b\":2}\n\n");
    expect(frames).toEqual([
      { id: "1", event: "text-delta", data: '{"a":1}' },
      { id: "2", data: '{"b":2}' },
    ]);
  });

  test("keeps multi-line data and \\r\\n line endings", () => {
    const decoder = createSseDecoder();
    expect(decoder.push("data: one\r\ndata: two\r\n\r\n")).toEqual([{ data: "one\ntwo" }]);
  });
});

describe("readASKGEventStream", () => {
  test("emits typed events in order and reports the terminal reason", async () => {
    const events: ASKGSseEvent[] = [];
    const outcome = await readASKGEventStream(
      streamOf([
        frame({ seq: 1, type: "text-delta", turnId: "t1", delta: "he" }),
        frame({ seq: 2, type: "text-delta", turnId: "t1", delta: "llo" }),
        frame({ seq: 3, type: "done", turnId: "t1", reason: "complete" }),
      ]),
      { onEvent: (event) => events.push(event) },
    );

    expect(events.map((event) => event.type)).toEqual(["text-delta", "text-delta", "done"]);
    expect(outcome).toEqual({ lastSeq: 3, done: "complete" });
  });

  test("skips events a resumed stream replays", async () => {
    const deltas: string[] = [];
    const outcome = await readASKGEventStream(
      streamOf([
        frame({ seq: 1, type: "text-delta", turnId: "t1", delta: "old" }),
        frame({ seq: 2, type: "text-delta", turnId: "t1", delta: "new" }),
      ]),
      {
        lastSeq: 1,
        onEvent: (event) => {
          if (event.type === "text-delta") deltas.push(event.delta);
        },
      },
    );

    expect(deltas).toEqual(["new"]);
    expect(outcome.done).toBeNull();
  });

  test("ignores frames that are not protocol events", async () => {
    const events: ASKGSseEvent[] = [];
    await readASKGEventStream(
      streamOf(["data: not json\n\n", 'data: {"hello":true}\n\n', frame({ seq: 4, type: "tool-result-ack", turnId: "t1", toolCallId: "c1" })]),
      { onEvent: (event) => events.push(event) },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("tool-result-ack");
  });
});

function transportFor(open: (init: RequestInit | undefined) => Promise<Response>) {
  const requests: Array<{ path: string; init?: RequestInit }> = [];
  const api = new CloudASKGApi({
    request: async <T,>(path: string, init?: RequestInit) => {
      requests.push({ path, init });
      return undefined as T;
    },
    openStream: (path, init) => {
      requests.push({ path, init });
      return open(init);
    },
    isStreamingSupported: () => true,
    delay: async () => {},
  });
  return { api, requests };
}

describe("CloudASKGApi.streamTurn", () => {
  test("resumes a dropped stream with Last-Event-ID and finishes the answer", async () => {
    let attempt = 0;
    const { api, requests } = transportFor(async () => {
      attempt += 1;
      return new Response(streamOf(attempt === 1
        ? [frame({ seq: 1, type: "text-delta", turnId: "t1", delta: "half " })]
        : [
          frame({ seq: 1, type: "text-delta", turnId: "t1", delta: "half " }),
          frame({ seq: 2, type: "text-delta", turnId: "t1", delta: "answer" }),
          frame({ seq: 3, type: "done", turnId: "t1", reason: "complete" }),
        ]));
    });

    const deltas: string[] = [];
    const reason = await api.streamTurn("s1", { turnId: "t1", input: "hi" }, {
      onEvent: (event) => {
        if (event.type === "text-delta") deltas.push(event.delta);
      },
    });

    expect(reason).toBe("complete");
    // The replayed first event is dropped, so the answer is not doubled.
    expect(deltas.join("")).toBe("half answer");
    expect(new Headers(requests[0]?.init?.headers).get("Last-Event-ID")).toBeNull();
    expect(new Headers(requests[1]?.init?.headers).get("Last-Event-ID")).toBe("1");
    // The same turn id re-attaches instead of asking again.
    expect(JSON.parse(String(requests[1]?.init?.body)).turnId).toBe("t1");
  });

  test("gives up with a retryable network error when the stream keeps dropping", async () => {
    const { api } = transportFor(async () => (
      new Response(streamOf([frame({ seq: 1, type: "text-delta", turnId: "t1", delta: "x" })]))
    ));
    await expect(api.streamTurn("s1", { turnId: "t1", input: "hi" }, { onEvent: () => {} }))
      .rejects.toMatchObject({ code: "network", retryable: true });
  });
});

describe("CloudASKGApi.postToolResult", () => {
  const payload = {
    turnId: "t1",
    toolCallId: "call-1",
    status: "ok" as const,
    truncated: false,
    elapsedMs: 12,
  };

  test("sends the tool call id as the idempotency key", async () => {
    const { api, requests } = transportFor(async () => new Response(""));
    expect(await api.postToolResult("s1", payload)).toBe("accepted");
    expect(new Headers(requests[0]?.init?.headers).get("Idempotency-Key")).toBe("call-1");
  });

  test("reports a closed result window instead of failing the turn", async () => {
    const api = new CloudASKGApi({
      request: async () => {
        throw new ApiRequestError("result window closed", 410);
      },
      openStream: async () => new Response(""),
      isStreamingSupported: () => true,
    });
    expect(await api.postToolResult("s1", payload)).toBe("too-late");
  });
});

describe("classifyASKGRequestError", () => {
  test("maps the documented statuses onto handled codes", () => {
    expect(classifyASKGRequestError(new ApiRequestError("pro required", 402)).code)
      .toBe("tier_required");
    expect(classifyASKGRequestError(new ApiRequestError("old protocol", 426)).code)
      .toBe("protocol");
    expect(classifyASKGRequestError(new ApiRequestError("disabled", 503)).code)
      .toBe("model_unavailable");
    const limited = classifyASKGRequestError(new ApiRequestError("too many", 429, 42_000));
    expect(limited.code).toBe("rate_limited");
    expect(limited.retryAfterMs).toBe(42_000);
    expect(classifyASKGRequestError(new ApiRequestError("daily cap reached", 429)).code)
      .toBe("daily_turn_cap");
  });
});
