import { expect, test } from "bun:test";
import { createTtlCache } from "./ttl-cache";

function clock(start = 1_000) {
  const state = { at: start };
  return { now: () => state.at, advance: (ms: number) => { state.at += ms; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("a loaded value is served until its TTL runs out, then loaded again", async () => {
  const time = clock();
  const cache = createTtlCache<number>({ ttlMs: 1_000, now: time.now });
  let loads = 0;
  const load = async () => ++loads;

  expect(await cache.load("a", load)).toBe(1);
  time.advance(999);
  expect(await cache.load("a", load)).toBe(1);
  expect(cache.peek("a")).toBe(1);
  time.advance(1);
  expect(cache.peek("a")).toBeUndefined();
  expect(await cache.load("a", load)).toBe(2);
  expect(await cache.load("b", load)).toBe(3);
});

test("the TTL counts from when the value arrives and can depend on the value", async () => {
  const time = clock();
  const cache = createTtlCache<string>({ ttlMs: (value) => value === "live" ? 100 : 10_000, now: time.now });
  const slow = deferred<string>();
  const pending = cache.load("a", () => slow.promise);
  time.advance(5_000);
  slow.resolve("live");
  await pending;
  time.advance(99);
  expect(cache.peek("a")).toBe("live");
  time.advance(1);
  expect(cache.peek("a")).toBeUndefined();
  await cache.load("b", async () => "delayed");
  time.advance(9_999);
  expect(cache.peek("b")).toBe("delayed");
});

test("callers share a load that is still out, however long it has been", async () => {
  const time = clock();
  const cache = createTtlCache<number>({ ttlMs: 1_000, now: time.now });
  const slow = deferred<number>();
  let loads = 0;
  const load = () => { loads += 1; return slow.promise; };

  const first = cache.load("a", load);
  time.advance(60 * 60_000);
  const second = cache.load("a", load);
  expect(second).toBe(first);
  expect(cache.peek("a")).toBeUndefined();
  slow.resolve(7);
  expect(await Promise.all([first, second])).toEqual([7, 7]);
  expect(loads).toBe(1);
});

test("force starts a new load, and an older load that lands later is not kept", async () => {
  const cache = createTtlCache<string>({ ttlMs: 60_000 });
  const older = deferred<string>();
  const first = cache.load("a", () => older.promise);
  const forced = await cache.load("a", async () => "forced", { force: true });
  expect(forced).toBe("forced");
  older.resolve("older");
  expect(await first).toBe("older");
  expect(cache.peek("a")).toBe("forced");
  expect(await cache.load("a", async () => "never")).toBe("forced");

  expect(await cache.load("a", async () => "again", { force: true })).toBe("again");
});

test("a rejected load reaches everyone waiting on it and is not kept", async () => {
  const cache = createTtlCache<number>({ ttlMs: 60_000 });
  const failing = deferred<number>();
  let loads = 0;
  const first = cache.load("a", () => { loads += 1; return failing.promise; });
  const second = cache.load("a", () => { loads += 1; return failing.promise; });
  failing.reject(new Error("down"));
  await expect(first).rejects.toThrow("down");
  await expect(second).rejects.toThrow("down");
  expect(loads).toBe(1);

  expect(await cache.load("a", async () => 2)).toBe(2);
  expect(loads).toBe(1);
  expect(cache.peek("a")).toBe(2);
});

test("a load that throws before it returns a promise is a rejection too", async () => {
  const cache = createTtlCache<number>({ ttlMs: 60_000 });
  await expect(cache.load("a", () => { throw new Error("sync"); })).rejects.toThrow("sync");
  expect(await cache.load("a", async () => 1)).toBe(1);
});

test("a rejection is kept for rejectionMs when asked, then the key loads again", async () => {
  const time = clock();
  const cache = createTtlCache<number>({ ttlMs: 60_000, rejectionMs: 300_000, now: time.now });
  let loads = 0;
  const failing = async (): Promise<number> => { loads += 1; throw new Error("no history"); };

  await expect(cache.load("a", failing)).rejects.toThrow("no history");
  time.advance(299_999);
  await expect(cache.load("a", failing)).rejects.toThrow("no history");
  expect(loads).toBe(1);
  expect(cache.peek("a")).toBeUndefined();
  time.advance(1);
  expect(await cache.load("a", async () => 5)).toBe(5);
  // A forced load skips even a kept rejection.
  const second = createTtlCache<number>({ ttlMs: 60_000, rejectionMs: 300_000, now: time.now });
  await expect(second.load("a", failing)).rejects.toThrow();
  expect(await second.load("a", async () => 9, { force: true })).toBe(9);
});

test("a value `keep` refuses answers its callers but is loaded again next time", async () => {
  const cache = createTtlCache<{ pending: boolean }>({ ttlMs: 60_000, keep: (value) => !value.pending });
  let loads = 0;
  const load = async () => ({ pending: ++loads < 3 });

  expect((await cache.load("a", load)).pending).toBe(true);
  expect(cache.peek("a")).toBeUndefined();
  expect((await cache.load("a", load)).pending).toBe(true);
  expect((await cache.load("a", load)).pending).toBe(false);
  expect(await cache.load("a", load)).toEqual({ pending: false });
  expect(loads).toBe(3);
});

test("set keeps a value that arrived another way, peek reads null as an answer, and only stale peeks read past the TTL", () => {
  const time = clock();
  const cache = createTtlCache<string | null>({ ttlMs: 500, now: time.now });
  expect(cache.peek("a")).toBeUndefined();
  cache.set("a", null);
  expect(cache.peek("a")).toBeNull();
  cache.set("b", "kept");
  time.advance(500);
  expect(cache.peek("a")).toBeUndefined();
  expect(cache.peek("b")).toBeUndefined();
  expect(cache.peek("b", { stale: true })).toBe("kept");
  expect(cache.peek("missing", { stale: true })).toBeUndefined();
});

test("a call can bring its own clock", async () => {
  const cache = createTtlCache<number>({ ttlMs: 1_000 });
  expect(await cache.load("a", async () => 1, { now: 10_000 })).toBe(1);
  expect(await cache.load("a", async () => 2, { now: 10_999 })).toBe(1);
  expect(await cache.load("a", async () => 2, { now: 11_000 })).toBe(2);
});

test("past maxEntries the oldest entries go first, and delete and clear forget", async () => {
  const cache = createTtlCache<number>({ ttlMs: 60_000, maxEntries: 2 });
  await cache.load("a", async () => 1);
  await cache.load("b", async () => 2);
  await cache.load("c", async () => 3);
  expect([cache.peek("a"), cache.peek("b"), cache.peek("c")]).toEqual([undefined, 2, 3]);
  cache.delete("b");
  expect(cache.peek("b")).toBeUndefined();
  cache.clear();
  expect(cache.peek("c")).toBeUndefined();
});
