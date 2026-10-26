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

test("callers share a load that is still out", async () => {
  const cache = createTtlCache<number>({ ttlMs: 1_000 });
  const slow = deferred<number>();
  let loads = 0;
  const load = () => { loads += 1; return slow.promise; };

  const first = cache.load("a", load);
  const second = cache.load("a", load);
  expect(second).toBe(first);
  expect(cache.peek("a")).toBeUndefined();
  slow.resolve(7);
  expect(await Promise.all([first, second])).toEqual([7, 7]);
  expect(loads).toBe(1);
});

test("a load that hangs is shared for no longer than the TTL, and its late answer is not kept", async () => {
  const time = clock();
  const cache = createTtlCache<string>({ ttlMs: 1_000, now: time.now });
  const hung = deferred<string>();
  const first = cache.load("a", () => hung.promise);
  time.advance(999);
  expect(cache.load("a", async () => "never")).toBe(first);
  time.advance(1);
  expect(await cache.load("a", async () => "retried")).toBe("retried");
  hung.resolve("late");
  expect(await first).toBe("late");
  expect(cache.peek("a")).toBe("retried");

  // A TTL that is not a number, or never ends, puts no limit on sharing.
  const unlimited = createTtlCache<string>({ ttlMs: Infinity, now: time.now });
  const slow = deferred<string>();
  const pending = unlimited.load("a", () => slow.promise);
  time.advance(60 * 60_000);
  expect(unlimited.load("a", async () => "never")).toBe(pending);
});

test("force starts a load past a fresh value, and joins one that began after that value", async () => {
  const time = clock();
  const cache = createTtlCache<string>({ ttlMs: 60_000, now: time.now });
  expect(await cache.load("a", async () => "first")).toBe("first");

  // Several panes refresh together: one request, answered to all of them.
  let loads = 0;
  const slow = deferred<string>();
  const load = () => { loads += 1; return slow.promise; };
  time.advance(10);
  const forced = [cache.load("a", load, { force: true }), cache.load("a", load, { force: true }), cache.load("a", load, { force: true })];
  expect(loads).toBe(1);
  expect(cache.peek("a")).toBe("first");
  slow.resolve("second");
  expect(await Promise.all(forced)).toEqual(["second", "second", "second"]);
  expect(cache.peek("a")).toBe("second");

  // Once it has landed, the next forced call asks again.
  expect(await cache.load("a", async () => "third", { force: true })).toBe("third");
  expect(cache.peek("a")).toBe("third");
});

test("force does not join a load that began before the value it would replace", async () => {
  const time = clock();
  const cache = createTtlCache<string>({ ttlMs: 60_000, now: time.now });
  const older = deferred<string>();
  const first = cache.load("a", () => older.promise);
  time.advance(10);
  cache.set("a", "arrived another way");
  expect(await cache.load("a", async () => "forced", { force: true })).toBe("forced");
  older.resolve("older");
  expect(await first).toBe("older");
  expect(cache.peek("a")).toBe("forced");
});

test("the last good value stays while a reload is out and when a forced one fails or is not kept", async () => {
  const time = clock();
  const cache = createTtlCache<string>({ ttlMs: 1_000, keep: (value) => value !== "pending", now: time.now });
  await cache.load("a", async () => "good");
  time.advance(5_000);
  expect(cache.peek("a")).toBeUndefined();
  expect(cache.peek("a", { stale: true })).toBe("good");

  // A reload is out: the stale copy is still there to draw.
  const reload = deferred<string>();
  const pending = cache.load("a", () => reload.promise);
  expect(cache.peek("a")).toBeUndefined();
  expect(cache.peek("a", { stale: true })).toBe("good");
  reload.reject(new Error("down"));
  await expect(pending).rejects.toThrow("down");
  expect(cache.peek("a", { stale: true })).toBe("good");

  // A fresh value survives a forced load that fails or brings something `keep` refuses.
  expect(await cache.load("a", async () => "better")).toBe("better");
  await expect(cache.load("a", async () => { throw new Error("down"); }, { force: true })).rejects.toThrow("down");
  expect(cache.peek("a")).toBe("better");
  expect(await cache.load("a", async () => "pending", { force: true })).toBe("pending");
  expect(cache.peek("a")).toBe("better");
  expect(await cache.load("a", async () => "never")).toBe("better");
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
  // A forced load skips even a kept rejection.
  expect(await cache.load("a", async () => 9, { force: true })).toBe(9);

  const later = createTtlCache<number>({ ttlMs: 60_000, rejectionMs: 300_000, now: time.now });
  await expect(later.load("a", failing)).rejects.toThrow();
  time.advance(300_000);
  expect(await later.load("a", async () => 5)).toBe(5);
});

test("a `keep` or TTL function that throws is a rejection for the callers, not an unhandled one", async () => {
  const refusing = createTtlCache<number>({ ttlMs: 60_000, keep: () => { throw new Error("cannot judge"); } });
  await expect(refusing.load("a", async () => 1)).rejects.toThrow("cannot judge");
  const unbounded = createTtlCache<number>({ ttlMs: () => { throw new Error("no ttl"); } });
  await expect(unbounded.load("a", async () => 1)).rejects.toThrow("no ttl");
  expect(unbounded.peek("a", { stale: true })).toBeUndefined();
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

test("past maxEntries the oldest keys go first, and delete and clear forget", async () => {
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

test("a caller that gives up on a load drops that load only, never a newer one", async () => {
  const time = clock();
  const cache = createTtlCache<string>({ ttlMs: 1_000, now: time.now });
  const stalled = deferred<string>();
  const first = cache.load("a", () => stalled.promise);
  cache.delete("a", first);
  // Nothing is out any more, so the next call loads.
  const second = cache.load("a", async () => "next");
  expect(await second).toBe("next");
  // Dropping the old promise again does nothing to what the key holds now.
  cache.delete("a", first);
  expect(cache.peek("a")).toBe("next");
  stalled.resolve("late");
  await first;
  expect(cache.peek("a")).toBe("next");

  const pending = deferred<string>();
  const newer = cache.load("b", () => pending.promise);
  cache.delete("b", first);
  expect(cache.load("b", async () => "never")).toBe(newer);
});
