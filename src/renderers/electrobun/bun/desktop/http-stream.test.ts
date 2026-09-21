import { expect, test } from "bun:test";
import { DesktopHttpStreamBridge } from "./http-stream";

interface ChunkMessage {
  streamId: string;
  chunk?: string;
  done?: boolean;
  error?: string;
}

type TestRpc = {
  key: string;
  sent: ChunkMessage[];
  send: { "http.stream.chunk": (payload: ChunkMessage) => void };
};

function rpc(key: string): TestRpc {
  const sent: ChunkMessage[] = [];
  return {
    key,
    sent,
    send: {
      "http.stream.chunk": (payload) => {
        sent.push(payload);
      },
    },
  };
}

/** A body the test releases one slice at a time, like a live SSE response. */
function controllableBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
    },
  });
  return {
    stream,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error: Error) => controller.error(error),
  };
}

function bridgeWith(
  fetchImpl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
) {
  return new DesktopHttpStreamBridge<TestRpc>({
    getWindowKey: (client) => client.key,
    fetch: fetchImpl as typeof globalThis.fetch,
  });
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("a streamed body reaches the view slice by slice instead of all at once", async () => {
  const body = controllableBody();
  const requests: RequestInit[] = [];
  const bridge = bridgeWith(async (_url, init) => {
    requests.push(init ?? {});
    return new Response(body.stream, {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream" },
    });
  });
  const client = rpc("window-a");

  const head = await bridge.handle(client, {
    method: "http.stream.open",
    payload: {
      streamId: "stream-1",
      url: "https://api.gloom.sh/askg/session/s1/turn",
      init: { method: "POST", headers: { "Last-Event-ID": "4" }, body: "{}" },
    },
  }) as { status: number; headers: Record<string, string> };

  expect(head.status).toBe(200);
  expect(head.headers["content-type"]).toBe("text/event-stream");
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.body).toBe("{}");
  expect(new Headers(requests[0]?.headers).get("Last-Event-ID")).toBe("4");

  body.push("event: text-delta\n");
  await settle();
  expect(client.sent).toEqual([{ streamId: "stream-1", chunk: "event: text-delta\n" }]);

  body.push("data: {}\n\n");
  body.close();
  await settle();
  expect(client.sent).toEqual([
    { streamId: "stream-1", chunk: "event: text-delta\n" },
    { streamId: "stream-1", chunk: "data: {}\n\n" },
    { streamId: "stream-1", done: true },
  ]);
});

test("a refused stream is delivered rather than thrown, so the view reads the reason", async () => {
  const bridge = bridgeWith(async () => new Response("over the cap", {
    status: 429,
    statusText: "Too Many Requests",
    headers: { "retry-after": "30" },
  }));
  const client = rpc("window-a");

  const head = await bridge.handle(client, {
    method: "http.stream.open",
    payload: { streamId: "stream-1", url: "https://api.gloom.sh/askg/session/s1/turn" },
  }) as { status: number; headers: Record<string, string> };

  await settle();
  expect(head.status).toBe(429);
  expect(head.headers["retry-after"]).toBe("30");
  expect(client.sent).toEqual([
    { streamId: "stream-1", chunk: "over the cap" },
    { streamId: "stream-1", done: true },
  ]);
});

test("a body that breaks mid-answer ends the stream with its reason", async () => {
  const body = controllableBody();
  const bridge = bridgeWith(async () => new Response(body.stream, { status: 200 }));
  const client = rpc("window-a");

  await bridge.handle(client, {
    method: "http.stream.open",
    payload: { streamId: "stream-1", url: "https://api.gloom.sh/askg/session/s1/turn" },
  });
  body.push("data: partial\n");
  await settle();
  body.fail(new Error("connection reset"));
  await settle();

  expect(client.sent).toEqual([
    { streamId: "stream-1", chunk: "data: partial\n" },
    { streamId: "stream-1", error: "connection reset" },
  ]);
});

test("cancelling is window-scoped and stops forwarding without ending another window's stream", async () => {
  const bodies = new Map<string, ReturnType<typeof controllableBody>>();
  const bridge = bridgeWith(async (_url, init) => {
    const body = controllableBody();
    bodies.set(String(init?.body ?? ""), body);
    return new Response(body.stream, { status: 200 });
  });
  const windowA = rpc("window-a");
  const windowB = rpc("window-b");

  // Both windows use the same client-side id; only the scoped one is cancelled.
  await bridge.handle(windowA, {
    method: "http.stream.open",
    payload: { streamId: "shared-id", url: "https://api.gloom.sh/askg/session/s1/turn", init: { method: "POST", body: "a" } },
  });
  await bridge.handle(windowB, {
    method: "http.stream.open",
    payload: { streamId: "shared-id", url: "https://api.gloom.sh/askg/session/s2/turn", init: { method: "POST", body: "b" } },
  });

  await bridge.handle(windowA, {
    method: "http.stream.cancel",
    payload: { streamId: "shared-id" },
  });
  bodies.get("a")!.push("dropped");
  bodies.get("b")!.push("kept");
  await settle();

  expect(windowA.sent).toEqual([]);
  expect(windowB.sent).toEqual([{ streamId: "shared-id", chunk: "kept" }]);

  bridge.disposeWindow("window-b");
  bodies.get("b")!.push("after close");
  await settle();
  expect(windowB.sent).toEqual([{ streamId: "shared-id", chunk: "kept" }]);
});

test("a failed connection rejects the open call and leaves nothing to cancel", async () => {
  const bridge = bridgeWith(async () => {
    throw new Error("dns failure");
  });
  const client = rpc("window-a");

  await expect(bridge.handle(client, {
    method: "http.stream.open",
    payload: { streamId: "stream-1", url: "https://api.gloom.sh/askg/session/s1/turn" },
  })).rejects.toThrow("dns failure");
  expect(client.sent).toEqual([]);
});

test("only http and https are proxied", async () => {
  const bridge = bridgeWith(async () => new Response("", { status: 200 }));
  await expect(bridge.handle(rpc("window-a"), {
    method: "http.stream.open",
    payload: { streamId: "stream-1", url: "file:///etc/passwd" },
  })).rejects.toThrow("Unsupported http.stream.open protocol: file:");
});
