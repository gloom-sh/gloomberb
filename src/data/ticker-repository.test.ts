import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createTestTicker } from "../test-support/ticker";
import { AppPersistence } from "./app-persistence";
import { TickerRepository } from "./ticker-repository";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ticker rows shared with another program", () => {
  test("the app saving its copy of a row keeps what a command changed in it since", async () => {
    const persistence = new AppPersistence(":memory:");
    try {
      // Two programs on one profile: the app, and a `gloom watchlist add` beside it.
      const app = new TickerRepository(persistence.tickers);
      const command = new TickerRepository(persistence.tickers);
      await app.saveTicker(createTestTicker("Z74", "Singtel", { exchange: "SGX", watchlists: ["watchlist"] }));
      const [appCopy] = await app.loadAllTickers();
      const [commandCopy] = await command.loadAllTickers();

      await command.saveTicker({ metadata: { ...commandCopy!.metadata, watchlists: ["watchlist", "cli"] } });
      await app.saveTicker({ metadata: { ...appCopy!.metadata, portfolios: ["main"] } });
      expect((await command.loadTicker("Z74"))!.metadata).toMatchObject({ watchlists: ["watchlist", "cli"], portfolios: ["main"] });

      // Saved again from the same copy, which never read the command's change, the row still keeps it.
      await app.saveTicker({ metadata: { ...appCopy!.metadata, portfolios: ["main"], tags: ["core"] } });
      expect((await command.loadTicker("Z74"))!.metadata).toMatchObject({ watchlists: ["watchlist", "cli"], portfolios: ["main"], tags: ["core"] });
    } finally {
      persistence.close();
    }
  });

  test("a row another program deletes stays deleted when the app saves its copy, until the app has taken in that it is gone", async () => {
    const persistence = new AppPersistence(":memory:");
    try {
      // The terminal app, and the desktop app beside it removing a broker profile's rows.
      const app = new TickerRepository(persistence.tickers);
      const other = new TickerRepository(persistence.tickers);
      await app.saveTicker(createTestTicker("Z74", "Singtel", { exchange: "SGX", watchlists: ["watchlist"] }));
      const [appCopy] = await app.loadAllTickers();
      await other.loadAllTickers();
      await other.deleteTicker("Z74");

      // Its copy saved unchanged, or changed: the row it holds is gone, and comes back neither way.
      await app.saveTicker(appCopy!);
      await app.saveTicker({ metadata: { ...appCopy!.metadata, tags: ["core"] } });
      expect(await other.loadTicker("Z74")).toBeNull();

      // A read of every row finds it gone and still holds the copy: a save of it stays dropped.
      expect(await app.loadAllTickers()).toEqual([]);
      await app.saveTicker(appCopy!);
      expect(await other.loadTicker("Z74")).toBeNull();
      // Once the app has taken that in, adding the ticker again is a new row.
      expect(app.takeRowsDeletedElsewhere()).toEqual(["Z74"]);
      expect(app.takeRowsDeletedElsewhere()).toEqual([]);
      await app.saveTicker(createTestTicker("Z74", "Singtel", { exchange: "SGX", portfolios: ["main"] }));
      expect((await other.loadTicker("Z74"))!.metadata).toMatchObject({ portfolios: ["main"], watchlists: [] });
    } finally {
      persistence.close();
    }
  });

  test("a save held up by another program's lock folds in what that program committed meanwhile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gloomberb-ticker-lock-"));
    tempDirs.push(dir);
    const path = join(dir, "profile.db");
    const persistence = new AppPersistence(path, { interactive: true });
    const command = new Database(path);
    try {
      const app = new TickerRepository(persistence.tickers);
      await app.saveTicker(createTestTicker("Z74", "Singtel", { exchange: "SGX", watchlists: ["watchlist"] }));
      const [copy] = await app.loadAllTickers();

      // A command holds the database while the app saves: the save waits in the app's queue.
      command.exec("BEGIN IMMEDIATE");
      await app.saveTicker({ metadata: { ...copy!.metadata, portfolios: ["main"] } });
      const stored = JSON.parse(command.query<{ metadata: string }, []>("SELECT metadata FROM tickers WHERE symbol = 'Z74'").get()!.metadata);
      command.query("UPDATE tickers SET metadata = ? WHERE symbol = 'Z74'").run(JSON.stringify({ ...stored, watchlists: ["watchlist", "cli"] }));
      command.exec("COMMIT");

      // The queued save lands now, and keeps the command's commit beside its own change.
      expect(persistence.database.access.flush()).toBe(true);
      const row = JSON.parse(command.query<{ metadata: string }, []>("SELECT metadata FROM tickers WHERE symbol = 'Z74'").get()!.metadata);
      expect(row).toMatchObject({ watchlists: ["watchlist", "cli"], portfolios: ["main"] });
    } finally {
      command.close();
      persistence.close();
    }
  });
});
