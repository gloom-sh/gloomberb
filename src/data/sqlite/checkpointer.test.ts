import { afterEach, expect, test } from "bun:test";
import { openSync, readSync, closeSync, statSync } from "fs";
import type { WalCheckpointResult } from "./checkpointer";
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
    // The write asks for a checkpoint a second later, which never answers.
    expect(userWriteLevel()).toBe(1);
    const deadline = performance.now() + 3_000;
    while (userWriteLevel() === 1 && performance.now() < deadline) await Bun.sleep(50);
    expect(userWriteLevel()).toBe(2);
    expect(pragma("wal_autocheckpoint")).toBe(1_000);
  } finally {
    database.close();
  }
});
