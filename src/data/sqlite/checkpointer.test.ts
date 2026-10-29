import { afterEach, expect, test } from "bun:test";
import { openSync, readSync, closeSync, statSync } from "fs";
import { SqliteDatabase } from "./database";
import { createTempDbPath, removeTempDbFiles } from "../../test-support/temp-db";

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
  const database = new SqliteDatabase(dbPath, { interactive: true });
  const { connection, access } = database;
  try {
    connection.exec("CREATE TABLE blobs (k INTEGER PRIMARY KEY, v BLOB NOT NULL)");
    const pageSize = connection.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
    const put = connection.query("INSERT INTO blobs (v) VALUES (zeroblob(?))");
    for (let index = 0; index < 30; index += 1) access.write("put", () => { put.run(50 * pageSize); });
    // A commit that checkpointed would have started the WAL over at 1,000 pages.
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(1_400 * pageSize);

    const sequence = walCheckpointSequence(dbPath);
    const deadline = performance.now() + 5_000;
    while (walCheckpointSequence(dbPath) === sequence && performance.now() < deadline) {
      await Bun.sleep(100);
      access.write("put", () => { put.run(1); });
    }
    expect(walCheckpointSequence(dbPath)).not.toBe(sequence);
  } finally {
    database.close();
  }
});
