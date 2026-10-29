import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { SqliteDatabase } from "./database";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";

afterEach(removeTempDbFiles);

function synchronousLevel(connection: Database): number | undefined {
  return connection.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous;
}

// Without WAL (a network share can refuse it) a commit that skips the flush
// can leave the database corrupt after a power cut, not just a commit short.
test("commits stop flushing only where WAL took, and user data always flushes", () => {
  const levels = (database: SqliteDatabase) => {
    const { connection, access } = database;
    const seen: Record<string, number | undefined> = { connection: synchronousLevel(connection) };
    access.write("probe user write", () => { seen.userWrite = synchronousLevel(connection); });
    access.writeCache("probe cache write", () => { seen.cacheWrite = synchronousLevel(connection); });
    seen.after = synchronousLevel(connection);
    return seen;
  };
  const wal = new SqliteDatabase(createTempDbPath("sync-wal"), { interactive: true });
  // An in-memory database is one where journal_mode=WAL does not take.
  const noWal = new SqliteDatabase(":memory:", { interactive: true });
  try {
    expect(levels(wal)).toEqual({ connection: 1, userWrite: 2, cacheWrite: 1, after: 1 });
    expect(noWal.connection.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).not.toBe("wal");
    expect(levels(noWal)).toEqual({ connection: 2, userWrite: 2, cacheWrite: 2, after: 2 });
  } finally {
    wal.close();
    noWal.close();
  }
});

// The queue runs on the app's only thread. Writes that piled up behind a
// long lock must not land in one tick that freezes the app, and a row
// written again while queued needs writing once, after what came before it.
test("in the app, a queue tick writes only its budget's worth, in order, and a later write of a row replaces a queued one", () => {
  const dbPath = createTempDbPath("queue-ticks");
  const database = new SqliteDatabase(dbPath, { interactive: true });
  const { connection, access } = database;
  connection.exec("CREATE TABLE queued (k TEXT PRIMARY KEY, v INTEGER NOT NULL)");
  const put = connection.query("INSERT OR REPLACE INTO queued (k, v) VALUES (?, ?)");
  const ran: string[] = [];
  const write = (k: string, v: number, spinMs = 0) => () => {
    put.run(k, v);
    ran.push(`${k}=${v}`);
    const until = performance.now() + spinMs;
    while (performance.now() < until) { /* stand in for a slow commit */ }
  };
  const locker = new Database(dbPath);
  locker.exec("BEGIN IMMEDIATE");
  let held = true;
  try {
    expect(access.write("put", write("a", 1), { key: "a" })).toBe(false);
    access.write("clear", () => { connection.exec("DELETE FROM queued"); ran.push("clear"); });
    access.write("put", write("a", 2), { key: "a" });
    for (let index = 0; index < 10; index += 1) access.write("put", write(`n${index}`, index, 15));
    locker.exec("ROLLBACK");
    held = false;

    const ticks: number[] = [];
    for (let tick = 0; tick < 50; tick += 1) {
      const startedAt = performance.now();
      const empty = access.flush();
      ticks.push(performance.now() - startedAt);
      if (empty) break;
    }

    // 150 ms of writes took several ticks, none much past its budget plus the write it was in.
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...ticks)).toBeLessThan(120);
    expect(ran).toEqual(["clear", "a=2", ...Array.from({ length: 10 }, (_, index) => `n${index}=${index}`)]);
    expect(connection.query("SELECT v FROM queued WHERE k = 'a'").get()).toEqual({ v: 2 });
    expect(connection.query("SELECT COUNT(*) AS count FROM queued").get()).toEqual({ count: 11 });
  } finally {
    if (held) locker.exec("ROLLBACK");
    locker.close();
    database.close();
  }
});
