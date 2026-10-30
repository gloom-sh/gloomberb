import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AppPersistence } from "../app-persistence";
import { ResourceStore } from "../resource-store";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";

afterEach(removeTempDbFiles);

const QUOTE_POLICY = { cachePolicy: { staleMs: 60_000, expireMs: 3_600_000 }, schemaVersion: 1 };

describe("AppPersistence", () => {
  test("stores and returns cached resources", () => {
    const dbPath = createTempDbPath("resource-cache");
    const persistence = new AppPersistence(dbPath);
    persistence.resources.set({
      namespace: "market",
      kind: "quote",
      entityKey: "AAPL",
      sourceKey: "provider:gloom",
    }, {
      price: 123,
    }, {
      cachePolicy: { staleMs: 60_000, expireMs: 120_000 },
      schemaVersion: 1,
      fetchedAt: 1,
    });

    expect(persistence.resources.get<{ price: number }>({
      namespace: "market",
      kind: "quote",
      entityKey: "AAPL",
      sourceKey: "provider:gloom",
    }, { allowExpired: true })?.value.price).toBe(123);
    const listed = persistence.resources.list<{ price: number }>({
      namespace: "market", kind: "quote", entityKey: "AAPL",
    }, { allowExpired: true });
    expect(listed[0]?.lastAccessedAt).toBeGreaterThan(1);
    persistence.close();
  });

  // Eviction drops the least recently accessed row first. A quote or price
  // history read on every tick must stay recent without a write per read, and
  // without being read with touch: false, which would leave it the first to go.
  test("a read with a touch interval refreshes a row's eviction order once per interval", () => {
    const persistence = new AppPersistence(createTempDbPath("resource-touch-interval"));
    try {
      setSystemTime(new Date("2026-10-14T10:00:00Z"));
      const key = { namespace: "market", kind: "quote", entityKey: "AAPL" };
      persistence.resources.set({ ...key, sourceKey: "provider:gloom" }, { price: 1 }, {
        cachePolicy: { staleMs: 60_000, expireMs: 3_600_000 },
        schemaVersion: 1,
      });
      const accessed = (options: { touch?: boolean; touchIntervalMs?: number }) =>
        persistence.resources.list(key, { allowExpired: true, ...options })[0]!.lastAccessedAt;
      const written = accessed({ touch: false });

      setSystemTime(new Date("2026-10-14T10:05:00Z"));
      expect(accessed({ touchIntervalMs: 600_000 })).toBe(written);
      setSystemTime(new Date("2026-10-14T10:11:00Z"));
      const refreshed = accessed({ touchIntervalMs: 600_000 });
      expect(refreshed).toBe(Date.parse("2026-10-14T10:11:00Z"));
      expect(accessed({ touch: false })).toBe(refreshed);
      setSystemTime(new Date("2026-10-14T10:20:00Z"));
      expect(accessed({ touch: false })).toBe(refreshed);
    } finally {
      setSystemTime();
      persistence.close();
    }
  });

  // A read used to write too: one commit per row read, many a second. The
  // eviction order still has to hold every read, and reach the disk.
  // The app's close writes them inside a cache batch, which its database's
  // close then commits; a command's connection writes them straight away.
  test.each([
    ["a command", false],
    ["the app", true],
  ] as const)("reads move rows up the eviction order in memory, and close writes it in one go (%s)", async (_, interactive) => {
    const dbPath = createTempDbPath("resource-touch-batch");
    const persistence = new AppPersistence(dbPath, { interactive });
    const onDisk = new Database(dbPath, { readonly: true });
    const lastAccessedOnDisk = (entityKey: string) => onDisk
      .query<{ last_accessed_at: number }, [string]>("SELECT last_accessed_at FROM resource_cache WHERE entity_key = ?")
      .get(entityKey)?.last_accessed_at;
    try {
      setSystemTime(new Date("2026-10-14T10:00:00Z"));
      const written = Date.now();
      persistence.resources.set({ namespace: "market", kind: "quote", entityKey: "AAPL" }, { price: 1 }, QUOTE_POLICY);
      persistence.resources.set({ namespace: "market", kind: "quote", entityKey: "MSFT" }, { price: 2 }, QUOTE_POLICY);
      await Bun.sleep(1);

      setSystemTime(new Date("2026-10-14T10:05:00Z"));
      const read = Date.now();
      expect(persistence.resources.get({ namespace: "market", kind: "quote", entityKey: "AAPL" })?.lastAccessedAt).toBe(read);
      expect(persistence.resources.list({ namespace: "market", kind: "quote", entityKey: "MSFT" })[0]?.lastAccessedAt).toBe(read);
      await Bun.sleep(1);
      expect(lastAccessedOnDisk("AAPL")).toBe(written);
      expect(lastAccessedOnDisk("MSFT")).toBe(written);
      expect(persistence.resources.get({ namespace: "market", kind: "quote", entityKey: "AAPL" }, { touch: false })?.lastAccessedAt).toBe(read);

      persistence.close();
      expect(lastAccessedOnDisk("AAPL")).toBe(read);
      expect(lastAccessedOnDisk("MSFT")).toBe(read);
    } finally {
      setSystemTime();
      onDisk.close();
    }
  });

  // Another program holding the lock when the reads are written is a miss for
  // that flush only: the order waits in memory for the next one.
  test("a read under another program's lock still answers, and its eviction order waits for the next flush", async () => {
    const dbPath = createTempDbPath("resource-touch-lock");
    const persistence = new AppPersistence(dbPath, { interactive: true });
    const onDisk = new Database(dbPath, { readonly: true });
    const key = { namespace: "market", kind: "quote", entityKey: "AAPL", sourceKey: "provider:gloom" };
    const lastAccessedOnDisk = () => onDisk
      .query<{ last_accessed_at: number }, []>("SELECT last_accessed_at FROM resource_cache").get()?.last_accessed_at;
    const locker = new Database(dbPath);
    try {
      setSystemTime(new Date("2026-10-14T10:00:00Z"));
      persistence.resources.set(key, { price: 123 }, QUOTE_POLICY);
      await Bun.sleep(1);
      const written = Date.now();

      setSystemTime(new Date("2026-10-14T10:05:00Z"));
      const read = Date.now();
      locker.exec("BEGIN IMMEDIATE");
      expect(persistence.resources.get<{ price: number }>(key)?.value.price).toBe(123);
      expect(persistence.resources.flushTouches()).toBe(false);
      locker.exec("ROLLBACK");
      expect(lastAccessedOnDisk()).toBe(written);

      expect(persistence.resources.flushTouches()).toBe(true);
      await Bun.sleep(1);
      expect(lastAccessedOnDisk()).toBe(read);
    } finally {
      setSystemTime();
      if (locker.inTransaction) locker.exec("ROLLBACK");
      locker.close();
      onDisk.close();
      persistence.close();
    }
  });

  // Close used to stop at the first error: the queued user writes never
  // reached the database and the connection stayed open.
  test("a failed write of the eviction order at close still lets queued user writes land and the database close", async () => {
    const dbPath = createTempDbPath("resource-touch-close-failure");
    const persistence = new AppPersistence(dbPath, { interactive: true });
    const locker = new Database(dbPath);
    persistence.resources.set({ namespace: "market", kind: "quote", entityKey: "AAPL" }, { price: 1 }, QUOTE_POLICY);
    await Bun.sleep(1);
    persistence.resources.get({ namespace: "market", kind: "quote", entityKey: "AAPL" });
    locker.exec("BEGIN IMMEDIATE");
    persistence.pluginState.set("notes", "draft", { text: "queued" });
    locker.exec("ROLLBACK");
    locker.close();
    // What the reviewer saw: the table the order is written to is gone.
    persistence.database.connection.exec("DROP TABLE resource_cache");

    expect(() => persistence.close()).not.toThrow();
    expect(() => persistence.database.connection.query("SELECT 1").get()).toThrow();
    const reopened = new Database(dbPath, { readonly: true });
    try {
      expect(reopened.query<{ value: string }, []>("SELECT value FROM plugin_state WHERE plugin_id = 'notes'").get()?.value)
        .toBe(JSON.stringify({ text: "queued" }));
    } finally {
      reopened.close();
    }
  });

  // The app runs SQLite on the thread that answers the user. Another program
  // holding the write lock (a second copy of the app, the gloom command) used
  // to freeze it for up to eight seconds per statement.
  test("in the app, another program's lock never holds a cache read, touch or write", async () => {
    const dbPath = createTempDbPath("resource-interactive-lock");
    const persistence = new AppPersistence(dbPath, { interactive: true });
    const key = { namespace: "market", kind: "quote", entityKey: "AAPL", sourceKey: "provider:gloom" };
    const policy = { cachePolicy: { staleMs: 60_000, expireMs: 120_000 }, schemaVersion: 1 };
    persistence.resources.set(key, { price: 1 }, policy);
    await Bun.sleep(1);
    const locker = new Database(dbPath);
    locker.exec("BEGIN IMMEDIATE");
    try {
      const startedAt = performance.now();
      const read = persistence.resources.get<{ price: number }>(key);
      const listed = persistence.resources.list({ namespace: "market", kind: "quote", entityKey: "AAPL" });
      persistence.resources.set(key, { price: 2 }, policy);
      expect(performance.now() - startedAt).toBeLessThan(50);
      expect(read?.value.price).toBe(1);
      expect(listed).toHaveLength(1);
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
    // The skipped write was the cache's to skip; the next one lands.
    expect(persistence.resources.get<{ price: number }>(key)?.value.price).toBe(1);
    persistence.resources.set(key, { price: 3 }, policy);
    expect(persistence.resources.get<{ price: number }>(key)?.value.price).toBe(3);
    persistence.close();
  });

  test("in the app, a user write that finds the database locked is read back, then lands in order once the lock is gone", async () => {
    const dbPath = createTempDbPath("user-write-queue");
    const persistence = new AppPersistence(dbPath, { interactive: true });
    const locker = new Database(dbPath);
    locker.exec("BEGIN IMMEDIATE");
    let held = true;
    try {
      const startedAt = performance.now();
      persistence.pluginState.set("notes", "draft", { text: "first" });
      persistence.sessions.set("app", { focusedPaneId: "chart:1" });
      persistence.pluginState.set("notes", "draft", { text: "second" });
      persistence.tickers.save("AAPL", { ticker: "AAPL", portfolios: ["main"] });
      persistence.tickers.delete("MSFT");
      // The first waits a moment for the lock; the rest queue behind it at once.
      expect(performance.now() - startedAt).toBeLessThan(1_000);

      expect(persistence.pluginState.get<{ text: string }>("notes", "draft")?.value.text).toBe("second");
      expect(persistence.pluginState.keys("notes")).toEqual(["draft"]);
      expect(persistence.sessions.get<{ focusedPaneId: string }>("app")?.value.focusedPaneId).toBe("chart:1");
      expect(persistence.tickers.getAll().map((row) => row.symbol)).toEqual(["AAPL"]);

      locker.exec("ROLLBACK");
      held = false;
      await Bun.sleep(400);
      const reader = new Database(dbPath, { readonly: true });
      try {
        expect(reader.query("SELECT value FROM plugin_state WHERE plugin_id = 'notes'").all()).toEqual([{ value: "{\"text\":\"second\"}" }]);
        expect(reader.query("SELECT symbol FROM tickers").all()).toEqual([{ symbol: "AAPL" }]);
        expect(reader.query("SELECT COUNT(*) AS count FROM session_snapshots").get()).toEqual({ count: 1 });
      } finally {
        reader.close();
      }
    } finally {
      if (held) locker.exec("ROLLBACK");
      locker.close();
      persistence.close();
    }
  });

  test("runs resource maintenance on the first write and at write, byte, or time intervals", () => {
    const dbPath = createTempDbPath("resource-maintenance-frequency");
    const persistence = new AppPersistence(dbPath);
    const connection = persistence.database.connection;
    let maintenanceScans = 0;
    const observedConnection = new Proxy(connection, {
      get(target, property) {
        if (property === "query") {
          return (sql: string) => {
            if (sql.includes("SELECT COUNT(*) as count")) maintenanceScans += 1;
            return target.query(sql);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database;
    const resources = new ResourceStore(observedConnection);
    const realDateNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    const write = (entityKey: string) => resources.set({
      namespace: "test",
      kind: "maintenance",
      entityKey,
    }, { entityKey }, {
      cachePolicy: { staleMs: 60_000, expireMs: 120_000 },
    });

    try {
      write("first");
      expect(maintenanceScans).toBe(1);

      for (let index = 0; index < 249; index++) write(`below-${index}`);
      expect(maintenanceScans).toBe(1);

      write("write-interval");
      expect(maintenanceScans).toBe(2);

      write("below-time-interval");
      expect(maintenanceScans).toBe(2);

      now += 5 * 60_000;
      write("time-interval");
      expect(maintenanceScans).toBe(3);

      resources.set({
        namespace: "test",
        kind: "maintenance",
        entityKey: "byte-interval",
      }, "x".repeat(512 * 1024), {
        cachePolicy: { staleMs: 60_000, expireMs: 120_000 },
      });
      expect(maintenanceScans).toBe(4);
    } finally {
      Date.now = realDateNow;
      persistence.close();
    }
  });

  // Reading the footprint is on a timer while the app runs, and the payloads
  // are large enough that scanning the table for it reads the whole cache off
  // disk: half a second of frozen UI on a 30MB cache.
  test("reads the cache footprint without touching the payloads", () => {
    const dbPath = createTempDbPath("resource-footprint-plan");
    const persistence = new AppPersistence(dbPath);
    try {
      persistence.resources.set({
        namespace: "market",
        kind: "price-history",
        entityKey: "NVDA",
      }, "x".repeat(64 * 1024), { cachePolicy: { staleMs: 60_000, expireMs: 120_000 } });

      const plan = persistence.database.connection
        .query<{ detail: string }, []>(
          `EXPLAIN QUERY PLAN
           SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM resource_cache`,
        )
        .all()
        .map((row) => row.detail)
        .join(" ");

      expect(plan).toContain("COVERING INDEX");
    } finally {
      persistence.close();
    }
  });

  test("evicts a full cache in batches instead of reading every row", () => {
    const dbPath = createTempDbPath("resource-batched-pruning");
    const persistence = new AppPersistence(dbPath);
    const connection = persistence.database.connection;
    try {
      // More rows than the soft limit allows, each accounted at 8KB: the
      // shape of a cache that has been in use for months. The stored payload
      // stays small so the test does not write a quarter of a gigabyte.
      const insert = connection.query(
        `INSERT INTO resource_cache (
           namespace, kind, entity_key, variant_key, source_key, schema_version,
           payload, provenance, fetched_at, stale_at, expires_at, last_accessed_at, size_bytes
         ) VALUES ('market', 'filler', ?, '', '', 1, '"filler"', NULL, ?, ?, ?, ?, ?)`,
      );
      const now = Date.now();
      connection.transaction(() => {
        for (let index = 0; index < 26_000; index += 1) {
          insert.run(`filler-${index}`, now, now + 600_000, now + 600_000, now - 600_000 + index, 8 * 1024);
        }
      })();

      const selects: string[] = [];
      const query = connection.query.bind(connection);
      (connection as { query: typeof query }).query = ((sql: string) => {
        if (sql.includes("FROM resource_cache") && sql.includes("ORDER BY last_accessed_at")) selects.push(sql);
        return query(sql);
      }) as typeof query;

      persistence.resources.set({
        namespace: "market",
        kind: "filler",
        entityKey: "trigger",
      }, "x".repeat(8 * 1024), { cachePolicy: { staleMs: 60_000, expireMs: 600_000 } });

      const remaining = connection
        .query<{ count: number }, []>("SELECT COUNT(*) as count FROM resource_cache")
        .get();
      expect(remaining?.count).toBeLessThanOrEqual(25_000);
      // The oldest rows go first, and the row that triggered the pass stays.
      expect(connection.query("SELECT 1 FROM resource_cache WHERE entity_key = 'filler-0'").get()).toBeNull();
      expect(connection.query("SELECT 1 FROM resource_cache WHERE entity_key = 'trigger'").get()).not.toBeNull();
      expect(selects.every((sql) => sql.includes("LIMIT"))).toBe(true);
      // Picking what to evict reads the recency index alone: a row's size sits
      // after its payload, and asking it of the oldest batch read megabytes.
      for (const sql of selects) {
        const plan = query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN ${sql}`).all(512).map((row) => row.detail).join(" ");
        expect(plan).toContain("COVERING INDEX");
      }
    } finally {
      persistence.close();
    }
  });

  // An entity can hold dozens of variants (every range of a price history,
  // from every source); a list read all their payloads and kept one.
  test("a list reads only the variants and sources it asks for", () => {
    const dbPath = createTempDbPath("resource-list-filter");
    const persistence = new AppPersistence(dbPath);
    const connection = persistence.database.connection;
    try {
      const write = (variantKey: string, sourceKey: string) => persistence.resources.set({
        namespace: "market",
        kind: "price-history",
        entityKey: "AAPL",
        variantKey,
        sourceKey,
      }, { variantKey, sourceKey }, { cachePolicy: { staleMs: 60_000, expireMs: 120_000 } });
      write("range=1y", "provider:a");
      write("range=1y", "provider:b");
      write("range=5y", "provider:a");
      write("range=max", "provider:a");

      const lists: string[] = [];
      const query = connection.query.bind(connection);
      (connection as { query: typeof query }).query = ((sql: string) => {
        if (sql.includes("FROM resource_cache") && sql.includes("entity_key = ?") && sql.includes("payload")) lists.push(sql);
        return query(sql);
      }) as typeof query;
      const listed = persistence.resources.list<{ variantKey: string; sourceKey: string }>(
        { namespace: "market", kind: "price-history", entityKey: "AAPL" },
        { variantKeys: ["range=1y", "range=5y"], sourceKeys: ["provider:a"] },
      );
      (connection as { query: typeof query }).query = query;

      expect(listed.map((record) => record.value).sort((a, b) => a.variantKey.localeCompare(b.variantKey))).toEqual([
        { variantKey: "range=1y", sourceKey: "provider:a" },
        { variantKey: "range=5y", sourceKey: "provider:a" },
      ]);
      // The filter runs on the key columns, ahead of the payload in each row:
      // a row it rejects never has its payload read.
      expect(lists).toHaveLength(1);
      expect(lists[0]).toMatch(/variant_key IN \(\?, \?\) AND source_key IN \(\?\)/);
    } finally {
      persistence.close();
    }
  });

  test("prunes only enough least-recently-used resources to restore the byte budget", () => {
    const dbPath = createTempDbPath("resource-byte-pruning");
    const persistence = new AppPersistence(dbPath);
    const now = Date.now();
    const write = (entityKey: string, value: unknown, fetchedAt: number) => persistence.resources.set({
      namespace: "test",
      kind: "byte-pruning",
      entityKey,
    }, value, {
      cachePolicy: { staleMs: 60_000, expireMs: 10 * 60_000 },
      fetchedAt,
    });

    try {
      write("oldest", { value: 1 }, now - 2);
      write("newer", { value: 2 }, now - 1);
      persistence.database.connection.query(
        `UPDATE resource_cache
         SET size_bytes = CASE entity_key
           WHEN 'oldest' THEN ?
           WHEN 'newer' THEN ?
           ELSE size_bytes
         END
         WHERE namespace = 'test' AND kind = 'byte-pruning'`,
      ).run(60 * 1024 * 1024, 50 * 1024 * 1024);

      write("trigger", "x".repeat(512 * 1024), now);

      const remaining = persistence.database.connection
        .query<{ entity_key: string }, []>(
          `SELECT entity_key
           FROM resource_cache
           WHERE namespace = 'test' AND kind = 'byte-pruning'
           ORDER BY fetched_at ASC`,
        )
        .all()
        .map((row) => row.entity_key);
      expect(remaining).toEqual(["newer", "trigger"]);
    } finally {
      persistence.close();
    }
  });

  test("invalidates plugin state when schema versions differ", () => {
    const dbPath = createTempDbPath("plugin-version");
    const persistence = new AppPersistence(dbPath);
    persistence.pluginState.set("ai", "conversation", { messages: ["hello"] }, 2);

    expect(persistence.pluginState.get("ai", "conversation", 1)).toBeNull();
    expect(persistence.pluginState.get("ai", "conversation", 2)).toBeNull();
    persistence.close();
  });

  test("returns a stable plugin state snapshot until the row changes", () => {
    const dbPath = createTempDbPath("plugin-snapshot-cache");
    const persistence = new AppPersistence(dbPath);
    persistence.pluginState.set("ai", "resume:screener-pane:test", {
      tabs: [{ id: "1", prompt: "durable compounders" }],
    }, 1);

    const first = persistence.pluginState.get<{ tabs: Array<{ id: string; prompt: string }> }>("ai", "resume:screener-pane:test", 1);
    const second = persistence.pluginState.get<{ tabs: Array<{ id: string; prompt: string }> }>("ai", "resume:screener-pane:test", 1);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).toBe(first);

    persistence.pluginState.set("ai", "resume:screener-pane:test", {
      tabs: [{ id: "2", prompt: "new leaders" }],
    }, 1);
    const third = persistence.pluginState.get<{ tabs: Array<{ id: string; prompt: string }> }>("ai", "resume:screener-pane:test", 1);

    expect(third).not.toBeNull();
    expect(third).not.toBe(first);
    expect(third?.value.tabs[0]?.id).toBe("2");
    persistence.close();
  });

  test("lists plugin ids that have stored state", () => {
    const dbPath = createTempDbPath("plugin-state-ids");
    const persistence = new AppPersistence(dbPath);
    persistence.pluginState.set("gloomberb-cloud", "session", { sessionToken: "token" }, 1);
    persistence.pluginState.set("ai", "provider", "openai", 1);

    expect(persistence.pluginState.pluginIds()).toEqual(["ai", "gloomberb-cloud"]);
    persistence.close();
  });

  test("stores multiple plugin state records in one batch", () => {
    const dbPath = createTempDbPath("plugin-state-batch");
    const persistence = new AppPersistence(dbPath);
    persistence.pluginState.setMany([
      { pluginId: "ai", key: "provider", value: "openai", schemaVersion: 1 },
      { pluginId: "news", key: "resume:read", value: { ids: ["1"] }, schemaVersion: 2 },
    ]);

    expect(persistence.pluginState.get<string>("ai", "provider", 1)?.value).toBe("openai");
    expect(persistence.pluginState.get<{ ids: string[] }>("news", "resume:read", 2)?.value.ids).toEqual(["1"]);
    persistence.close();
  });

  test("stores and returns session snapshots", () => {
    const dbPath = createTempDbPath("session-snapshot");
    const persistence = new AppPersistence(dbPath);
    persistence.sessions.set("app", { focusedPaneId: "ticker-detail:main" }, 1);

    expect(persistence.sessions.get<{ focusedPaneId: string }>("app", 1)?.value.focusedPaneId).toBe("ticker-detail:main");
    persistence.close();
  });
});
