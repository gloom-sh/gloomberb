import { afterEach, expect, test } from "bun:test";
import { AppPersistence } from "../../../../data/app-persistence";
import { TickerRepository } from "../../../../data/ticker-repository";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { createTestTicker } from "../../../../test-support/ticker";
import { createDefaultConfig } from "../../../../types/config";
import { portfolioCliCommand } from "./portfolio-command";
import { watchlistCliCommand } from "./watchlist-command";

const persistences: AppPersistence[] = [];

afterEach(() => {
  for (const persistence of persistences.splice(0)) persistence.close();
});

/** SAN saved twice: Sanofi under the bare key, Banco Santander's New York line under its venue key. */
async function savedSan() {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const membership = { portfolios: ["main"], watchlists: ["growth"] };
  await store.saveTicker(createTestTicker("SAN", "Sanofi", { exchange: "EPA", currency: "EUR", ...membership }));
  await store.saveTicker(createTestTicker("SAN:XNYS", "Banco Santander", { exchange: "NYSE", ...membership }));
  const config = {
    ...createDefaultConfig("/unused-listing-remove"),
    portfolios: [{ id: "main", name: "Main", currency: "USD" }],
    watchlists: [{ id: "growth", name: "Growth" }],
  };
  return { store, ...createTestCliContext({ config, store }) };
}

test("watchlist and portfolio remove take the listing --exchange or SYM:EXCH names, not the bare symbol's row", async () => {
  const run = await savedSan();

  await watchlistCliCommand.execute(["remove", "growth", "SAN", "--exchange", "NYSE"], run.context);
  const removed = run.printed[0]!;
  expect(removed.result.data).toMatchObject({ changed: true, listing: "SAN:NYSE", name: "Banco Santander", watchlist: "Growth" });
  expect(removed.options?.text?.(removed.result.data)).toContain('Removed SAN:NYSE (Banco Santander) from "Growth".');
  expect((await run.store.loadTicker("SAN"))?.metadata.watchlists).toEqual(["growth"]);
  expect((await run.store.loadTicker("SAN:XNYS"))?.metadata.watchlists).toEqual([]);

  await portfolioCliCommand.execute(["remove", "main", "SAN:XPAR"], run.context);
  expect(run.printed[1]!.result.data).toMatchObject({ changed: true, listing: "SAN:EPA", name: "Sanofi", portfolio: "Main" });
  expect((await run.store.loadTicker("SAN"))?.metadata.portfolios).toEqual([]);
  expect((await run.store.loadTicker("SAN:XNYS"))?.metadata.portfolios).toEqual(["main"]);

  // A listing that is saved but not on this list, and one that is not saved at all, each say which.
  await expect(watchlistCliCommand.execute(["remove", "growth", "SAN:NYSE"], run.context)).rejects.toThrow('SAN:NYSE is not in "Growth".');
  await expect(watchlistCliCommand.execute(["remove", "growth", "SAN", "--exchange", "LSE"], run.context))
    .rejects.toThrow('Ticker "SAN:LSE" was not found in your local data.');
});
