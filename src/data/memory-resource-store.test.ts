import { describe, expect, test } from "bun:test";
import { MemoryResourceStore, packWarmResource, WriteThroughResourceStore } from "./memory-resource-store";

describe("MemoryResourceStore", () => {
  test("returns expired records only when requested", () => {
    const store = new MemoryResourceStore();
    const key = {
      namespace: "plugins:prediction-markets",
      kind: "catalog",
      entityKey: "kalshi:all:all",
      sourceKey: "remote",
    };

    store.set(key, ["expired"], {
      cachePolicy: { staleMs: -2, expireMs: -1 },
      fetchedAt: Date.now(),
    });

    expect(store.get(key)).toBeNull();
    expect(store.get<string[]>(key, { allowExpired: true })?.value).toEqual([
      "expired",
    ]);
  });
});

test("serialized bootstrap data decodes only when read and a live write replaces it", () => {
  const key = { namespace: "plugin:warm", kind: "test", entityKey: "listing" };
  const options = { cachePolicy: { staleMs: 0, expireMs: 60_000 } };
  const initial = new MemoryResourceStore();
  const snapshot = packWarmResource(initial.set(key, { price: 1 }, options));
  expect(snapshot).toHaveProperty("valueJson", '{"price":1}');
  expect(snapshot).not.toHaveProperty("value");
  const view = new WriteThroughResourceStore([snapshot], { set() {}, delete() {}, setProResourceAccess() {} }, () => true);
  expect(view.get(key)?.value).toEqual({ price: 1 });
  const live = { price: 2 };
  view.set(key, live, options);
  expect(view.get(key)?.value).toBe(live);
});

test("memory evicts the least recently used rows without deleting durable copies", () => {
  const key = (entityKey: string) => ({ namespace: "pane:restore", kind: "test", entityKey });
  const options = { cachePolicy: { staleMs: 0, expireMs: 60_000 } };
  const onDisk = new Map<string, unknown>();
  const store = new WriteThroughResourceStore([], {
    set: (record) => { onDisk.set(record.entityKey, record.value); },
    delete: (record) => { onDisk.delete(record.entityKey); },
  }, () => true, { maxRows: 2, maxBytes: 16 });
  store.set(key("first"), "aaaa", options);
  store.set(key("second"), "bbbb", options);
  store.get(key("first"), { touchIntervalMs: 60_000 });
  store.set(key("third"), "c", options);
  expect(store.get(key("second"))).toBeNull();
  expect(onDisk.get("second")).toBe("bbbb");
  store.set(key("third"), "ééééé", options);
  expect(store.get(key("first"))).toBeNull();
  expect(store.get(key("third"))?.sizeBytes).toBe(12);
  store.set(key("oversized"), "much larger than the cache budget", options);
  expect(store.get(key("oversized"))).toBeNull();
  expect(store.get(key("third"))?.value).toBe("ééééé");
});
