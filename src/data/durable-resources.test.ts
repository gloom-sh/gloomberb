import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createTempDbPath, removeTempDbFiles } from "../test-support/temp-db";
import { AppPersistence } from "./app-persistence";
import { applyResourceSync, createBatchedResourceSink } from "./durable-resources";
import { MemoryResourceStore, WriteThroughResourceStore } from "./memory-resource-store";
import { readSavedCopy, setSavedCopyStore, writeSavedCopy } from "./pane-saved-copies";
import type { ResourceCacheKey } from "./resource-store";
import { handleDesktopViewResourceRequest } from "../renderers/electrobun/bun/desktop/view-resources";

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
  const sink = createBatchedResourceSink((payload) => handleDesktopViewResourceRequest({ persistence }, {
    method: "resources.sync", payload,
  }));
  const options = { cachePolicy: { staleMs: 0, expireMs: 30_000 } };
  const account = 'test"account';
  const scope = (id: string | null, pro: boolean) => JSON.stringify([id, id !== null, pro]);
  const pane = (entityKey: string): ResourceCacheKey => ({ namespace: "pane:saved-copies", kind: "loaded", entityKey });
  const market = { namespace: "market", kind: "holders", entityKey: "AAPL", sourceKey: `provider:gloomberb-cloud:${scope(account, true)}` };
  const plugin = { namespace: "plugin:earnings", kind: "earnings-history", entityKey: `AAPL|${JSON.stringify([account, true])}:pro`, sourceKey: "gloom-cloud" };
  const paid = pane(JSON.stringify(["quote", JSON.stringify(["router", scope(account, true)]), "AAPL"]));
  const legacy = pane(JSON.stringify(["catalysts", {}, `${JSON.stringify([account, true])}:full`]));
  const preserved = [
    pane(JSON.stringify(["risk", scope(account, false)])), pane(JSON.stringify(["risk", scope(`${account}-other`, true)])),
    pane(JSON.stringify(["risk", scope(null, false)])), pane("unscoped"),
    { ...paid, namespace: "plugin:test-broker", kind: "account-snapshot" },
  ];
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

const proAccount = "queued-pro";
const proKey = { namespace: "pane:test", kind: "data", entityKey: JSON.stringify([proAccount, true, true]) };
const cacheOptions = { cachePolicy: { staleMs: 0, expireMs: 30_000 } };

test("a Free launch does not read resource_cache for revocation, even with another account's paid copies", () => {
  const path = createTempDbPath("free-launch");
  const seed = new AppPersistence(path);
  seed.resources.set(proKey, "other account", cacheOptions);
  seed.close();
  const reopened = new AppPersistence(path);
  const query = spyOn(reopened.database.connection, "query");
  try {
    reopened.resources.setProResourceAccess("never-pro", false);
    expect(query.mock.calls.some(([sql]) => /\bresource_cache\b/i.test(sql))).toBe(false);
  } finally {
    query.mockRestore();
    reopened.close();
  }
});

test("a SQLite purge queued behind a writer cannot delete a refreshed Pro copy", () => {
  const path = createTempDbPath("queued-pro");
  const app = new AppPersistence(path, { interactive: true });
  const writer = new Database(path);
  try {
    const { resources } = app;
    resources.set(proKey, "old copy", cacheOptions);
    expect(app.database.access.write("commit the test cache seed", () => {})).toBe(true);
    writer.exec("BEGIN IMMEDIATE");
    resources.setProResourceAccess(proAccount, false);
    expect(resources.get(proKey)).toBeNull();
    resources.setProResourceAccess(proAccount, true);
    writer.exec("COMMIT");
    resources.set(proKey, "fresh copy", cacheOptions);
    expect(app.database.access.flush()).toBe(true);
    expect(resources.get(proKey)?.value).toBe("fresh copy");
  } finally {
    writer.close();
    app.close();
  }
});

test("a desktop batch supersedes a downgrade before saving the renewed subscription's copy", async () => {
  const persistence = new AppPersistence(":memory:");
  const sink = createBatchedResourceSink((batch) => applyResourceSync(persistence.resources, batch));
  const view = new WriteThroughResourceStore([], sink, () => true);
  try {
    view.set(proKey, "old copy", cacheOptions);
    await sink.flush();
    view.setProResourceAccess(proAccount, false);
    view.setProResourceAccess(proAccount, true);
    view.set(proKey, "fresh copy", cacheOptions);
    await sink.flush();
    expect(persistence.resources.get(proKey)?.value).toBe("fresh copy");
  } finally {
    persistence.close();
  }
});

test("legacy SQLite copies are cleaned off the launch path and the index persists", async () => {
  const path = createTempDbPath("legacy-pro");
  const seed = new AppPersistence(path);
  seed.resources.set(proKey, "paid", cacheOptions);
  seed.resources.set({ ...proKey, entityKey: "unscoped" }, "public", cacheOptions);
  seed.database.connection.exec("DELETE FROM resource_pro_backfill; DELETE FROM resource_pro_candidates");
  seed.close();
  const reopened = new AppPersistence(path);
  try {
    reopened.resources.setProResourceAccess(proAccount, false);
    const db = reopened.database.connection;
    const present = () => db.query("SELECT 1 FROM resource_cache WHERE entity_key = ?").get(proKey.entityKey);
    expect(present()).not.toBeNull();
    const deadline = performance.now() + 2_000;
    while (present() && performance.now() < deadline) await Bun.sleep(25);
    expect(present()).toBeNull();
    expect(db.query("SELECT 1 FROM resource_pro_backfill WHERE covered_through = legacy_end").get()).not.toBeNull();
    expect(reopened.resources.get({ ...proKey, entityKey: "unscoped" })?.value).toBe("public");
  } finally {
    reopened.close();
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
