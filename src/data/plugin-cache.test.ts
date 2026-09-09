import { expect, test } from "bun:test";
import { MemoryPluginPersistence } from "../test-support/plugin-persistence";
import { createPluginCache } from "./plugin-cache";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const makeCache = () => createPluginCache<number>({ kind: "test", source: "provider", policy: { staleMs: 60_000, expireMs: 120_000 } });

test("reset prevents pending requests from writing into a newly attached plugin scope", async () => {
  const oldStore = new MemoryPluginPersistence();
  const nextStore = new MemoryPluginPersistence();
  const cache = makeCache();
  cache.attach(oldStore);
  const old = deferred<number>();
  const first = cache.load("key", () => old.promise);
  await Promise.resolve();
  cache.reset();
  cache.attach(nextStore);
  await cache.load("key", async () => 2);
  old.resolve(1);
  expect((await first).data).toBe(1);
  expect(nextStore.getResource<number>("test", "key", { sourceKey: "provider" })?.value).toBe(2);
  expect(oldStore.getResource("test", "key", { sourceKey: "provider" })).toBeNull();
  expect(cache.get("key")?.data).toBe(2);
});

test("forced replacement cannot be overwritten or cleared by an older request", async () => {
  const store = new MemoryPluginPersistence();
  const cache = makeCache();
  cache.attach(store);
  const old = deferred<number>();
  const replacement = deferred<number>();
  const first = cache.load("key", () => old.promise);
  const second = cache.load("key", () => replacement.promise, { force: true, replace: true });
  const third = cache.load("key", async () => { throw new Error("must join replacement"); });
  replacement.resolve(2);
  expect((await second).data).toBe(2);
  expect((await third).data).toBe(2);
  old.resolve(1);
  await first;
  expect(cache.get("key")?.data).toBe(2);
  expect(store.getResource<number>("test", "key", { sourceKey: "provider" })?.value).toBe(2);
});
