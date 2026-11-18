import { afterEach, expect, test } from "bun:test";
import { createTempDbPath, removeTempDbFiles } from "../test-support/temp-db";
import { AppPersistence } from "./app-persistence";
import { applyResourceSync, createBatchedResourceSink } from "./durable-resources";
import { WriteThroughResourceStore } from "./memory-resource-store";
import { readSavedCopy, setSavedCopyStore, writeSavedCopy } from "./pane-saved-copies";

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
  const last = new Map([["XYZ", { price: 7, asOf: new Date("2022-01-03T20:00:00Z") }]]);
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
