import { afterEach, expect, test } from "bun:test";
import { CloudChatApi } from "./chat";
import { CloudApiSocket } from "./socket";
import { createTestSocketDeps, installTestWebSocket, type TestWebSocket } from "../test-support/cloud-api";
import { toRequestEnvelope, readRequestInit } from "../utils/http-proxy-response";

const originalWebSocket = globalThis.WebSocket;

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

function createChat(answer: (path: string) => unknown = () => []) {
  const sockets: TestWebSocket[] = installTestWebSocket(0);
  const socket = new CloudApiSocket(createTestSocketDeps());
  const requests: Array<{ path: string; features: string | null }> = [];
  const chat = new CloudChatApi({
    request: async <T>(path: string, options?: RequestInit) => {
      requests.push({ path, features: new Headers(options?.headers).get("X-Gloom-Features") });
      return answer(path) as T;
    },
    upload: async () => { throw new Error("no uploads here"); },
    socket,
  });
  // A quote subscription keeps the socket open without a signed-in user.
  socket.subscribeQuotes([{ symbol: "AAPL", exchange: "NASDAQ" }], () => {});
  const ws = sockets.at(-1)!;
  ws.open();
  return { chat, ws, requests };
}

test("offers images only once the server says it takes them, and asks for them on every channel", async () => {
  const { chat, ws, requests } = createChat();
  let changes = 0;
  chat.subscribeAttachmentSupport(() => { changes += 1; });

  // An older server: no features, or features without images.
  ws.receive({ type: "ready", user: null, serverTime: Date.now(), features: ["market.batch"] });
  expect(chat.attachmentsSupported()).toBe(false);
  expect(ws.sent.filter((message) => message.type === "client.features"))
    .toEqual([{ type: "client.features", features: ["market.batch"] }]);

  // A new connection to a server with images opts into both, in one frame.
  ws.receive({ type: "ready", user: null, serverTime: Date.now(), features: ["market.batch", "chat.attachments"] });
  expect(chat.attachmentsSupported()).toBe(true);
  expect(changes).toBe(1);

  await chat.getMessages("everyone");
  await chat.getState().catch(() => {});
  expect(requests.map((request) => request.features)).toEqual(["chat.attachments", "chat.attachments"]);
});

test("a REST answer carrying attachments proves support before the socket is ready", async () => {
  const { chat } = createChat((path) => (path.startsWith("/chat/channels/everyone/messages")
    ? [{ id: "m1", channelId: "everyone", content: "", replyToId: null, createdAt: "2026-10-05T00:00:00Z", user: { id: "u1", username: "ada", displayName: "Ada" }, attachments: [] }]
    : []));
  expect(chat.attachmentsSupported()).toBe(false);
  await chat.getMessages("everyone");
  expect(chat.attachmentsSupported()).toBe(true);
});

test("an image upload crosses the desktop's text-only bridge byte for byte", async () => {
  const bytes = new Uint8Array(70_000).map((_, index) => (index * 31) % 256);
  const envelope = await toRequestEnvelope("https://api.example/chat/channels/everyone/attachments", {
    method: "POST",
    body: bytes,
  });
  const json = JSON.parse(JSON.stringify(envelope));
  const body = readRequestInit(json.init).body;
  expect(body).toBeInstanceOf(Uint8Array);
  expect([...(body as Uint8Array)]).toEqual([...bytes]);
});
