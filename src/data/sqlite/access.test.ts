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
// In the app the checkpointer's thread flushes user data: on Windows the
// flush held the app's thread for seconds. A command has no checkpointer,
// and its user writes flush themselves.
test("commits stop flushing only where WAL took, and user data flushes on the app's thread only where nothing else does", () => {
  const levels = (database: SqliteDatabase) => {
    const { connection, access } = database;
    const seen: Record<string, number | undefined> = { connection: synchronousLevel(connection) };
    access.write("probe user write", () => { seen.userWrite = synchronousLevel(connection); });
    access.writeCache("probe cache write", () => { seen.cacheWrite = synchronousLevel(connection); });
    seen.after = synchronousLevel(connection);
    return seen;
  };
  const wal = new SqliteDatabase(createTempDbPath("sync-wal"), { interactive: true });
  const command = new SqliteDatabase(createTempDbPath("sync-command"));
  // An in-memory database is one where journal_mode=WAL does not take.
  const noWal = new SqliteDatabase(":memory:", { interactive: true });
  try {
    expect(levels(wal)).toEqual({ connection: 1, userWrite: 1, cacheWrite: 1, after: 1 });
    expect(levels(command)).toEqual({ connection: 1, userWrite: 2, cacheWrite: 1, after: 1 });
    expect(noWal.connection.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).not.toBe("wal");
    expect(levels(noWal)).toEqual({ connection: 2, userWrite: 2, cacheWrite: 2, after: 2 });
  } finally {
    wal.close();
    command.close();
    noWal.close();
  }
});

// A batch of quotes or a list's rows used to commit one row at a time. A
// user write does not wait in that batch: it commits on its own.
test("in the app, the cache writes of one turn commit together, and a user write commits them first", async () => {
  const dbPath = createTempDbPath("cache-batch");
  const database = new SqliteDatabase(dbPath, { interactive: true });
  const { connection, access } = database;
  connection.exec("CREATE TABLE batched (k TEXT PRIMARY KEY)");
  const other = new Database(dbPath, { readonly: true });
  const committed = () => other.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM batched").get()?.c;
  const put = (k: string) => () => { connection.query("INSERT INTO batched (k) VALUES (?)").run(k); };
  try {
    expect(access.writeCache("put", put("a"))).toBe(true);
    expect(access.writeCache("put", put("b"))).toBe(true);
    expect(committed()).toBe(0);
    await Bun.sleep(1);
    expect(committed()).toBe(2);

    access.writeCache("put", put("c"));
    let inTransaction: boolean | undefined;
    access.write("user write", () => {
      inTransaction = connection.inTransaction;
      put("user")();
    });
    expect(committed()).toBe(4);
    expect(inTransaction).toBe(false);
  } finally {
    other.close();
    database.close();
  }
});

// A cache write made from a user write's callback, or from a queued write's
// `settled`, opened a batch the next user write then ran inside: a failed
// commit of that batch rolls the user write back with the cache's.
test("in the app, a user write never lands in a cache batch, whatever opened it", async () => {
  const dbPath = createTempDbPath("cache-batch-durable");
  const database = new SqliteDatabase(dbPath, { interactive: true });
  const { connection, access } = database;
  connection.exec("CREATE TABLE rows (k TEXT PRIMARY KEY)");
  const put = (k: string) => () => { connection.query("INSERT OR REPLACE INTO rows (k) VALUES (?)").run(k); };
  const seen: boolean[] = [];
  const probe = (k: string) => () => {
    seen.push(connection.inTransaction);
    put(k)();
  };
  const locker = new Database(dbPath);
  try {
    access.write("user write", () => {
      access.writeCache("cache write", put("cache-inside"));
      probe("inside")();
    });
    locker.exec("BEGIN IMMEDIATE");
    access.write("queued", put("first"), { settled: () => { access.writeCache("cache write", put("cache-settled")); } });
    access.write("queued", probe("second"));
    locker.exec("ROLLBACK");
    await Bun.sleep(150);
    expect(access.flush()).toBe(true);
    expect(seen).toEqual([false, false]);
  } finally {
    if (locker.inTransaction) locker.exec("ROLLBACK");
    locker.close();
    database.close();
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
  /** How many of the slow writes each tick ran. */
  const slowWritesPerTick: number[] = [];
  let tick = 0;
  const write = (k: string, v: number, spinMs = 0) => () => {
    put.run(k, v);
    ran.push(`${k}=${v}`);
    if (spinMs === 0) return;
    slowWritesPerTick[tick] = (slowWritesPerTick[tick] ?? 0) + 1;
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

    for (; tick < 50; tick += 1) {
      if (access.flush()) break;
    }

    // A tick starts writes for 40 ms. Each slow write takes at least 15 ms,
    // so a tick starts at most three; a slow disk only lowers that. Without
    // the budget one tick would run all ten.
    const counts = Array.from(slowWritesPerTick, (count) => count ?? 0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(3);
    expect(counts.filter((count) => count > 0).length).toBeGreaterThanOrEqual(4);
    expect(ran).toEqual(["clear", "a=2", ...Array.from({ length: 10 }, (_, index) => `n${index}=${index}`)]);
    expect(connection.query("SELECT v FROM queued WHERE k = 'a'").get()).toEqual({ v: 2 });
    expect(connection.query("SELECT COUNT(*) AS count FROM queued").get()).toEqual({ count: 11 });
  } finally {
    if (held) locker.exec("ROLLBACK");
    locker.close();
    database.close();
  }
});
