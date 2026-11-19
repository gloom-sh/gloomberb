import { afterEach, expect, test } from "bun:test";
import { createTempDbPath, removeTempDbFiles } from "../test-support/temp-db";
import { AppPersistence } from "./app-persistence";
import { applyResourceSync, createBatchedResourceSink } from "./durable-resources";
import { MemoryResourceStore, WriteThroughResourceStore } from "./memory-resource-store";
import { readSavedCopy, setSavedCopyStore, writeSavedCopy } from "./pane-saved-copies";
import type { ResourceCacheKey } from "./resource-store";

afterEach(removeTempDbFiles);

test("view writes reach SQLite without a shutdown flush and reopen with their original age and version", async () => {
  const file = createTempDbPath("saved-pane");
  const persistence = new AppPersistence(file);
  const committed = Promise.withResolvers<void>();
  const sink = createBatchedResourceSink((batch) => {
    applyResourceSync(persistence.resources, batch);
    committed.resolve();
  }, { delayMs: 1 });
  const store = new WriteThroughResourceStore([], sink, () => true);
  const previous = setSavedCopyStore(store);
  const key = { key: ["prices", "XYZ", "NYSE"], version: 2 };
  const last = new Map([["XYZ", { price: 7, asOf: new Date("2022-01-03T20:00:00Z"), history: "歷史".repeat(9_000) }]]);
  const fetchedAt = Date.UTC(2022, 0, 3, 20, 1);
  try {
    writeSavedCopy(key, new Map([["XYZ", { price: 3, asOf: new Date(0) }]]), fetchedAt - 10);
    writeSavedCopy(key, last, fetchedAt);
    await committed.promise;
    const reopened = new AppPersistence(file);
    try {
      const saved = reopened.resources.listRecent(["pane:"], { maxRows: 50, maxBytes: 1_000 });
      setSavedCopyStore(new WriteThroughResourceStore(saved, sink, () => true));
      expect(readSavedCopy({ ...key, key: ["prices", "XYZ", "NASDAQ"] })).toBeNull();
      expect(readSavedCopy(key)).toEqual({ value: last, fetchedAt });
      expect(readSavedCopy({ ...key, version: 3 })).toBeNull();
    } finally {
      reopened.close();
    }
  } finally {
    setSavedCopyStore(previous);
    await sink.flush();
    persistence.close();
  }
});

test("a large record cannot hide smaller saved copies that still fit in the view bootstrap", () => {
  const persistence = new AppPersistence(createTempDbPath("warm-resource-budget"));
  const options = { cachePolicy: { staleMs: 0, expireMs: 1 } };
  const write = (entityKey: string, length: number) => persistence.resources.set({ namespace: "pane:test", kind: "data", entityKey }, "x".repeat(length), options);
  try {
    write("small", 10);
    write("large", 90);
    write("newest", 30);
    const saved = persistence.resources.listRecent(["pane:"], { maxRows: 2, maxBytes: 100 });
    expect(saved.map((record) => record.entityKey)).toEqual(["newest", "small"]);
  } finally {
    persistence.close();
  }
});

test.each(["terminal", "desktop"] as const)("%s purges only the downgraded account's paid records, even outside the warm set", async (renderer) => {
  const path = createTempDbPath("revoked-pro");
  const persistence = new AppPersistence(path);
  const sink = createBatchedResourceSink((batch) => applyResourceSync(persistence.resources, batch));
  const options = { cachePolicy: { staleMs: 0, expireMs: 30_000 } };
  const account = 'test"account';
  const scope = (id: string | null, pro: boolean) => JSON.stringify([id, id !== null, pro]);
  const pane = (entityKey: string): ResourceCacheKey => ({ namespace: "pane:saved-copies", kind: "loaded", entityKey });
  const market = { namespace: "market", kind: "holders", entityKey: "AAPL", sourceKey: `provider:gloomberb-cloud:${scope(account, true)}` };
  const plugin = { namespace: "plugin:earnings", kind: "earnings-history", entityKey: `AAPL|${JSON.stringify([account, true])}:pro`, sourceKey: "gloom-cloud" };
  const paid = pane(JSON.stringify(["quote", JSON.stringify(["router", scope(account, true)]), "AAPL"]));
  const legacy = pane(JSON.stringify(["catalysts", {}, `${JSON.stringify([account, true])}:full`]));
  const preserved = [pane(JSON.stringify(["risk", scope(account, false)])), pane(JSON.stringify(["risk", scope(`${account}-other`, true)])), pane(JSON.stringify(["risk", scope(null, false)]))];
  try {
    for (const key of [market, plugin, legacy, ...preserved, paid]) persistence.resources.set(key, "original", options);
    const store = renderer === "terminal" ? persistence.resources : new WriteThroughResourceStore(
      [persistence.resources.get(paid)!], sink, () => true,
    );
    expect(store.get(paid)?.value).toBe("original");
    store.set(paid, "queued refresh", options);
    store.setProResourceAccess(account, false);
    store.set(paid, "late refresh", options);
    expect(store.get(paid)).toBeNull();
    await sink.flush();
    const reopened = new AppPersistence(path);
    try {
      for (const key of [market, plugin, paid, legacy]) expect(reopened.resources.get(key)).toBeNull();
      for (const key of preserved) expect(reopened.resources.get(key)?.value).toBe("original");
      store.setProResourceAccess(account, true);
      expect(store.get(paid)).toBeNull();
      store.set(paid, "new subscription", options);
      await sink.flush();
      expect(reopened.resources.get(paid)?.value).toBe("new subscription");
    } finally {
      reopened.close();
    }
  } finally {
    await sink.flush();
    persistence.close();
  }
});

test("pane snapshots share repeated chart data and do not serialize callbacks", () => {
  const previous = setSavedCopyStore(new MemoryResourceStore());
  const key = { key: ["test-chart"] };
  const points = [{ date: new Date(0), value: Number.NaN }];
  const chart = { visible: points, buffered: points, tags: new Set([points]), other: { __gloomSaved: "ref", value: null } };
  try {
    writeSavedCopy(key, chart);
    const restored = readSavedCopy<typeof chart>(key)?.value;
    expect(restored).toEqual(chart);
    expect(restored?.visible).toBe(restored?.buffered);
    expect(restored?.tags.has(restored.visible)).toBe(true);
    writeSavedCopy(key, { run: () => "not display data" });
    expect(readSavedCopy<typeof chart>(key)?.value).toEqual(chart);
  } finally {
    setSavedCopyStore(previous);
  }
});
