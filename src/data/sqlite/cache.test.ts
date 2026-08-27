import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AppPersistence } from "../app-persistence";
import { ResourceStore } from "../resource-store";

const tempPaths: string[] = [];

function createTempDbPath(name: string): string {
  const path = join(tmpdir(), `gloomberb-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tempPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of tempPaths.splice(0)) {
    for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(candidate)) rmSync(candidate, { force: true });
    }
  }
});

describe("AppPersistence", () => {
  test("stores and returns cached resources", () => {
    const dbPath = createTempDbPath("resource-cache");
    const persistence = new AppPersistence(dbPath);
    persistence.resources.set({
      namespace: "market",
      kind: "quote",
      entityKey: "AAPL",
      sourceKey: "provider:yahoo",
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
      sourceKey: "provider:yahoo",
    }, { allowExpired: true })?.value.price).toBe(123);
    const listed = persistence.resources.list<{ price: number }>({
      namespace: "market", kind: "quote", entityKey: "AAPL",
    }, { allowExpired: true });
    expect(listed[0]?.lastAccessedAt).toBeGreaterThan(1);
    persistence.close();
  });

  test("returns cached resources when last-access touch is locked", () => {
    const dbPath = createTempDbPath("resource-touch-lock");
    const persistence = new AppPersistence(dbPath);
    const key = {
      namespace: "market",
      kind: "quote",
      entityKey: "AAPL",
      sourceKey: "provider:yahoo",
    };

    persistence.database.connection.exec("PRAGMA busy_timeout=1");
    persistence.resources.set(key, {
      price: 123,
    }, {
      cachePolicy: { staleMs: 60_000, expireMs: 120_000 },
      schemaVersion: 1,
    });

    const locker = new Database(dbPath);
    locker.exec("PRAGMA busy_timeout=1");
    locker.exec("BEGIN IMMEDIATE");
    try {
      const record = persistence.resources.get<{ price: number }>(key, { allowExpired: true });
      expect(record?.value.price).toBe(123);
    } finally {
      locker.exec("ROLLBACK");
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
