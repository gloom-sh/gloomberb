import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqliteAccess } from "./access";
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

test("a Windows command waits out a long writer lock, but a durable write still expires at its deadline", async () => {
  const dbPath = createTempDbPath("command-lock-wait");
  const realWindows = process.platform === "win32";
  const command = new SqliteDatabase(dbPath, realWindows ? {} : { commandWriteWaitMs: 1_500 });
  const shortCommand = new SqliteDatabase(dbPath, { commandWriteWaitMs: 100 });
  const source = URL.createObjectURL(new Blob([`
    import { Database } from "bun:sqlite";
    self.onmessage = ({ data }) => {
      const db = new Database(data.path);
      db.exec("BEGIN IMMEDIATE");
      postMessage("locked");
      const lock = new Int32Array(data.signal);
      Atomics.wait(lock, 0, 0, data.holdMs);
      db.exec("ROLLBACK");
      db.close();
      postMessage("released");
    };
  `], { type: "application/javascript" }));
  const worker = new Worker(source);
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const locked = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  worker.onmessage = ({ data }) => (data === "locked" ? locked : released).resolve();
  worker.onerror = (error) => locked.reject(error);
  try {
    command.connection.exec("CREATE TABLE command_writes (id INTEGER PRIMARY KEY)");
    const write = (db: SqliteDatabase, id: number) => db.access.write("command write", () => {
      db.connection.query("INSERT INTO command_writes VALUES (?)").run(id);
    });
    worker.postMessage({ path: dbPath, signal: signal.buffer, holdMs: realWindows ? 9_000 : 500 });
    await locked.promise;
    const startedAt = performance.now();
    expect(() => write(shortCommand, 1)).toThrow(/database is locked|database is busy/i);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(write(command, 2)).toBe(true);
    expect(command.connection.query("SELECT id FROM command_writes").all()).toEqual([{ id: 2 }]);
    for (const db of [shortCommand, command]) {
      expect(db.connection.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 2_000 });
      expect(synchronousLevel(db.connection)).toBe(1);
    }
  } finally {
    Atomics.store(signal, 0, 1);
    Atomics.notify(signal, 0);
    await Promise.race([released.promise, Bun.sleep(1_000)]);
    worker.terminate();
    URL.revokeObjectURL(source);
    shortCommand.close();
    command.close();
  }
}, 45_000);

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

// On Windows a commit made while the checkpointer's thread flushes the WAL
// waits for the flush to end: 1.4 to 49 s of stall reports naming a commit.
// The app's thread commits nothing meanwhile, and what it held back lands the
// moment the flush ends (or, should that go unannounced, a poll later).
function holdFixture(name: string, options: { holdLimitMs?: number } = {}) {
  const dbPath = createTempDbPath(name);
  const connection = new Database(dbPath);
  connection.exec("PRAGMA journal_mode=WAL");
  connection.exec("PRAGMA synchronous=NORMAL");
  connection.exec("CREATE TABLE rows (k TEXT PRIMARY KEY)");
  const state = { flushing: true };
  const commits: string[] = [];
  const access = createSqliteAccess(connection, {
    interactive: true,
    relaxedCommits: true,
    holdCommits: () => state.flushing,
    onCommit: (kind) => { commits.push(kind); },
    ...options,
  });
  const observer = new Database(dbPath, { readonly: true });
  const committed = () => observer.query<{ k: string }, []>("SELECT k FROM rows ORDER BY k").all().map((row) => row.k);
  const put = (k: string) => () => { connection.query("INSERT OR REPLACE INTO rows (k) VALUES (?)").run(k); };
  return {
    state, commits, access, committed, put, connection,
    close: () => {
      access.close();
      observer.close();
      connection.close();
    },
  };
}

test("in the app, no commit is made while the WAL is being flushed, and what waited lands when the flush ends", async () => {
  const fixture = holdFixture("hold-commits");
  const { access, put, committed, state, commits, connection } = fixture;
  const seen: boolean[] = [];
  try {
    expect(access.writeCache("cache", put("cache"))).toBe(true);
    expect(access.write("user", () => { seen.push(connection.inTransaction); put("user")(); })).toBe(false);
    // Past several polls: the cache's batch is still open and the user write is queued.
    await Bun.sleep(350);
    expect(committed()).toEqual([]);
    expect(commits).toEqual([]);
    expect(access.flush()).toBe(false);

    state.flushing = false;
    access.resume();
    await Bun.sleep(30);
    expect(committed()).toEqual(["cache", "user"]);
    // The cache's batch was committed first, so the user write ran on its own.
    expect(seen).toEqual([false]);
    expect(commits).toEqual(["cache", "user"]);
    expect(access.flush()).toBe(true);
  } finally {
    fixture.close();
  }
});

test("in the app, held commits go ahead on their own when the end of a flush goes unannounced", async () => {
  const fixture = holdFixture("hold-poll");
  const { access, put, committed, state } = fixture;
  try {
    access.writeCache("cache", put("cache"));
    access.write("user", put("user"));
    state.flushing = false;
    await Bun.sleep(400);
    expect(committed()).toEqual(["cache", "user"]);
  } finally {
    fixture.close();
  }
});

test("in the app, a write queued for a flush is replaced by a later write of its key, and keeps its place among the others", async () => {
  const fixture = holdFixture("hold-order");
  const { access, put, committed, state, connection } = fixture;
  const ran: string[] = [];
  const write = (k: string, v: string) => () => { ran.push(`${k}=${v}`); put(`${k}=${v}`)(); };
  try {
    access.write("first", write("a", "1"), { key: "a" });
    access.write("second", write("b", "1"), { key: "b" });
    access.write("again", write("a", "2"), { key: "a" });
    state.flushing = false;
    access.resume();
    await Bun.sleep(30);
    expect(ran).toEqual(["b=1", "a=2"]);
    expect(committed()).toEqual(["a=2", "b=1"]);
    expect(connection.inTransaction).toBe(false);
  } finally {
    fixture.close();
  }
});

// A flush that lasts seconds is waited out; one that never ends (a thread
// the checkpointer gave up on) must not keep the user's writes back for good.
test("in the app, commits are held for a flush only up to the limit", async () => {
  const fixture = holdFixture("hold-limit", { holdLimitMs: 150 });
  const { access, put, committed } = fixture;
  try {
    access.write("user", put("user"));
    await Bun.sleep(50);
    expect(committed()).toEqual([]);
    await Bun.sleep(400);
    expect(committed()).toEqual(["user"]);
    // Past the limit this flush no longer holds anything back.
    access.write("later", put("later"));
    expect(committed()).toEqual(["later", "user"]);
  } finally {
    fixture.close();
  }
});

test("in the app, closing writes what a flush held back", () => {
  const fixture = holdFixture("hold-close");
  const { access, put, committed } = fixture;
  try {
    access.writeCache("cache", put("cache"));
    access.write("user", put("user"));
    access.close();
    expect(committed()).toEqual(["cache", "user"]);
  } finally {
    fixture.close();
  }
});
