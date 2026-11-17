import { describe, expect, test } from "bun:test";
import { createTestTicker } from "../test-support/ticker";
import { AppPersistence } from "./app-persistence";
import { TickerRepository } from "./ticker-repository";

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
});
