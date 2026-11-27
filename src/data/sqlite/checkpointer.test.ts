import { afterEach, expect, test } from "bun:test";
import { openSync, readSync, closeSync, statSync } from "fs";
import { startWalCheckpointer, type WalCheckpointResult } from "./checkpointer";
import { SqliteDatabase } from "./database";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";
import { withDeadline } from "../../utils/async-deadline";

afterEach(removeTempDbFiles);

/** Bumped each time a writer starts the WAL over, which only follows a checkpoint of all of it. */
function walCheckpointSequence(dbPath: string): number {
  const header = Buffer.alloc(16);
  const fd = openSync(`${dbPath}-wal`, "r");
  try {
    readSync(fd, header, 0, 16, 0);
  } finally {
    closeSync(fd);
  }
  return header.readUInt32BE(12);
}

// Past 1,000 pages SQLite copies the WAL into the database inside the commit
// that crossed it: 150 ms to a second of frozen app, every few hundred writes.
test("in the app, commits leave copying the WAL into the database to the checkpointer's thread", async () => {
  const dbPath = createTempDbPath("checkpointer");
  let copiedWal!: (result: WalCheckpointResult) => void;
  const checkpoint = new Promise<WalCheckpointResult>((resolve) => { copiedWal = resolve; });
  const database = new SqliteDatabase(dbPath, { interactive: true, checkpointer: { onCheckpoint: copiedWal } });
  const { connection, access } = database;
  try {
    connection.exec("CREATE TABLE blobs (k INTEGER PRIMARY KEY, v BLOB NOT NULL)");
    const pageSize = connection.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
    const put = connection.query("INSERT INTO blobs (v) VALUES (zeroblob(?))");
    for (let index = 0; index < 30; index += 1) access.write("put", () => { put.run(50 * pageSize); });
    // A commit that checkpointed would have started the WAL over at 1,000 pages.
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(1_400 * pageSize);

    // No commit while the thread copies: one that lands inside a checkpoint
    // leaves its frame behind, and the checkpoint takes as long as the disk
    // does, so a stream of commits can keep the WAL from ever being whole.
    const sequence = walCheckpointSequence(dbPath);
    const result = await withDeadline(checkpoint, 20_000, "The checkpointer never copied the WAL");
    expect(result.checkpointed).toBe(result.log);
    // The first commit after a whole WAL is in the database starts it over.
    access.write("put", () => { put.run(1); });
    expect(walCheckpointSequence(dbPath)).not.toBe(sequence);
  } finally {
    database.close();
  }
}, 30_000);

// A thread stuck in a checkpoint sends no error event. The app's user writes
// skip their flush while the checkpointer runs, so without a clock on its
// answers they would go unflushed until the backstop checkpoint or close.
test("a checkpointer stuck in a checkpoint gives the app's user writes their flush back", async () => {
  const dbPath = createTempDbPath("checkpointer-stuck");
  const database = new SqliteDatabase(dbPath, {
    interactive: true,
    checkpointer: {
      stuckAfterMs: 300,
      // Opens, then never answers a checkpoint.
      workerSource: `self.onmessage = (event) => { if (event.data.type === "open") postMessage({ type: "ready" }); };`,
    },
  });
  const { connection, access } = database;
  const pragma = (name: string) => connection.query<Record<string, number>, []>(`PRAGMA ${name}`).get()?.[name];
  const userWriteLevel = () => {
    let level: number | undefined;
    access.write("probe user write", () => { level = pragma("synchronous"); });
    return level;
  };
  try {
    // The first write asks for a checkpoint, which never answers. While it is
    // pending Windows queues writes, so wait for the watchdog, not a probe write.
    expect(userWriteLevel()).toBe(1);
    const deadline = performance.now() + 5_000;
    while (pragma("wal_autocheckpoint") !== 1_000 && performance.now() < deadline) await Bun.sleep(50);
    expect(pragma("wal_autocheckpoint")).toBe(1_000);
    expect(userWriteLevel()).toBe(2);
  } finally {
    database.close();
  }
});

// A thread that takes `ms` over each checkpoint, as a slow disk does.
const slowCheckpointWorker = (ms: number) => `
  let closed;
  self.onmessage = (event) => {
    if (event.data.type === "open") {
      closed = new Int32Array(event.data.closed);
      postMessage({ type: "ready" });
    }
    if (event.data.type === "checkpoint") setTimeout(() => postMessage({ type: "checkpointed", ms: ${ms}, result: {} }), ${ms});
    if (event.data.type === "close") {
      Atomics.store(closed, 0, 1);
      Atomics.notify(closed, 0);
      self.close();
    }
  };
`;

// Commits of cached data ask for a late checkpoint, so each flush (a window
// in which the app's commits wait on Windows) comes rarely; a commit of user
// data asks for the usual one and must not wait out the late one.
test("a checkpoint asked for soon comes forward, one asked for later does not push it back, and its length is told", async () => {
  const checkpointer = startWalCheckpointer("unused.db", () => {}, { workerSource: slowCheckpointWorker(200) })!;
  const idle = new Promise<void>((resolve) => { checkpointer.onIdle(resolve); });
  try {
    checkpointer.nudge(30_000);
    await Bun.sleep(100);
    expect(checkpointer.busy()).toBe(false);

    checkpointer.nudge(50);
    checkpointer.nudge(30_000);
    await Bun.sleep(150);
    expect(checkpointer.busy()).toBe(true);
    await withDeadline(idle, 3_000, "The checkpoint never ended");
    expect(checkpointer.busy()).toBe(false);
  } finally {
    checkpointer.close();
  }
});

// A stream of cached quotes commits every few hundred ms. Each flush it set
// off a second later was a window in which Windows held the app's commits.
test("in the app, commits of cached data alone ask for a late flush, and a commit of user data for the usual one", async () => {
  const dbPath = createTempDbPath("checkpointer-lazy");
  let checkpoints = 0;
  const database = new SqliteDatabase(dbPath, { interactive: true, checkpointer: { onCheckpoint: () => { checkpoints += 1; } } });
  const { connection, access } = database;
  try {
    connection.exec("CREATE TABLE rows (k INTEGER PRIMARY KEY)");
    access.writeCache("cache write", () => { connection.exec("INSERT INTO rows DEFAULT VALUES"); });
    await Bun.sleep(1_500);
    expect(checkpoints).toBe(0);

    access.write("user write", () => { connection.exec("INSERT INTO rows DEFAULT VALUES"); });
    const deadline = performance.now() + 5_000;
    while (checkpoints === 0 && performance.now() < deadline) await Bun.sleep(50);
    expect(checkpoints).toBe(1);
  } finally {
    database.close();
  }
}, 10_000);
