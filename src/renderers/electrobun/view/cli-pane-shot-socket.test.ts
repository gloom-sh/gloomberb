import { expect, test } from "bun:test";
import { openShotApiSocket, type ShotSocket } from "./cli-pane-shot-socket";

/** A socket the test answers by hand: what the page sent, and the server's side of it. */
function fakeSocket() {
  const listeners = new Map<string, Array<(event: { data: unknown }) => void>>();
  const sent: Array<{ id: number }> = [];
  const emit = (type: string, event: { data: unknown } = { data: null }) => {
    for (const listener of listeners.get(type) ?? []) listener(event);
  };
  const socket: ShotSocket & { closed: boolean } = {
    closed: false,
    send(data) {
      sent.push(JSON.parse(data));
    },
    close() {
      if (socket.closed) return;
      socket.closed = true;
      emit("close");
    },
    addEventListener(type: string, listener: (event: { data: unknown }) => void) {
      listeners.set(type, [...listeners.get(type) ?? [], listener]);
    },
  };
  const reply = (id: number, body = "{}") => emit("message", {
    data: JSON.stringify({ id, status: 200, statusText: "OK", headers: [], body: Buffer.from(body).toString("base64") }),
  });
  return { socket, sent, reply, open: () => emit("open") };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the page keeps 16 reads on its socket at a time, gives a silent one up to HTTP, and sends everything over HTTP once it closes", async () => {
  const fake = fakeSocket();
  const opening = openShotApiSocket(() => fake.socket, { timeoutMs: 50 });
  fake.open();
  const send = (await opening)!;
  const read = (path: string) => send({ path, headers: [] }, null)!;
  const reads = Array.from({ length: 20 }, (_, index) => read(`/market/quote/${index}`));
  await tick();
  expect(fake.sent.length).toBe(16);
  // A reply makes room for the next read.
  fake.reply(fake.sent[0]!.id, "{\"price\":87.71}");
  expect(await (await reads[0]!)!.json()).toEqual({ price: 87.71 });
  expect(fake.sent.length).toBe(17);
  // A read with no reply in time is made over HTTP instead (null), and frees its place.
  const silent = await reads[1];
  expect(silent).toBeNull();
  expect(fake.sent.length).toBe(18);

  // The server closes a socket that dropped a reply: every read on it or waiting for it, and every later one, goes over HTTP.
  fake.socket.close();
  expect(await Promise.all(reads.slice(2))).toEqual(Array(18).fill(null));
  expect(send({ path: "/market/quote/later", headers: [] }, null)).toBeNull();
});

test("a read the page stops waiting for leaves the socket, whether sent or still waiting for a place", async () => {
  const fake = fakeSocket();
  const opening = openShotApiSocket(() => fake.socket, { limit: 1, timeoutMs: 1_000 });
  fake.open();
  const send = (await opening)!;
  const first = new AbortController();
  const second = new AbortController();
  const sentRead = send({ path: "/a", headers: [] }, first.signal)!;
  const waitingRead = send({ path: "/b", headers: [] }, second.signal)!;
  const third = send({ path: "/c", headers: [] }, null)!;
  second.abort();
  await expect(waitingRead).rejects.toThrow();
  first.abort();
  await expect(sentRead).rejects.toThrow();
  // The waiting read never went out; the next one takes the freed place.
  expect(fake.sent.map((call) => (call as unknown as { path: string }).path)).toEqual(["/a", "/c"]);
  fake.reply(fake.sent[1]!.id);
  expect((await third)!.status).toBe(200);
});
