import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AppPersistence } from "../../../../data/app-persistence";
import { TickerRepository } from "../../../../data/ticker-repository";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { createTestTicker } from "../../../../test-support/ticker";
import { loadConfig, saveConfig } from "../../../../data/config/store";
import { createDefaultConfig } from "../../../../types/config";
import { portfolioCliCommand } from "./portfolio-command";
import { watchlistCliCommand } from "./watchlist-command";

const persistences: AppPersistence[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  for (const persistence of persistences.splice(0)) persistence.close();
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** SAN saved twice: Sanofi under the bare key, Banco Santander's New York line under its venue key. */
async function savedSan() {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const membership = { portfolios: ["main"], watchlists: ["growth"] };
  await store.saveTicker(createTestTicker("SAN", "Sanofi", { exchange: "EPA", currency: "EUR", ...membership }));
  await store.saveTicker(createTestTicker("SAN:XNYS", "Banco Santander", { exchange: "NYSE", ...membership }));
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-listing-commands-"));
  dataDirs.push(dataDir);
  const config = {
    ...createDefaultConfig(dataDir),
    portfolios: [{ id: "main", name: "Main", currency: "USD" }],
    watchlists: [{ id: "growth", name: "Growth" }],
  };
  await saveConfig(config);
  return { store, dataDir, ...createTestCliContext({ config, store }) };
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

test("target and position commands change the row of the listing --exchange or SYM:EXCH names, not the bare symbol's", async () => {
  const run = await savedSan();
  // Each command is its own CLI run: it reads the config the last one saved.
  const exec = async (...args: string[]) => {
    const { context, printed } = createTestCliContext({ config: await loadConfig(run.dataDir), store: run.store });
    await portfolioCliCommand.execute(args, context);
    const { result, options } = printed[0]!;
    return { data: result.data, text: options!.text!(result.data) };
  };
  const targets = async () => (await loadConfig(run.dataDir)).portfolios[0]!.targetWeights ?? {};

  // The bare SAN row is Sanofi in Paris; New York's line is saved under its venue key.
  const nyse = await exec("target", "set", "main", "SAN", "20", "--exchange", "NYSE");
  expect(nyse.data).toMatchObject({ listing: "SAN:NYSE", name: "Banco Santander", portfolio: "Main", targetWeight: 20 });
  expect(nyse.text).toContain('Set the target for SAN:NYSE (Banco Santander) in "Main" to 20.0%.');
  expect(await targets()).toEqual({ "SAN:XNYS": 20 });

  const paris = await exec("target", "set", "main", "SAN:XPAR", "10");
  expect(paris.text).toContain('Set the target for SAN:EPA (Sanofi) in "Main" to 10.0%.');
  expect(await targets()).toEqual({ SAN: 10, "SAN:XNYS": 20 });

  const position = await exec("position", "set", "main", "SAN", "7", "13", "--exchange", "NYSE");
  expect(position.data).toMatchObject({ listing: "SAN:NYSE", shares: 7, avgCost: 13, currency: "USD" });
  expect(position.text).toContain('Set position for SAN:NYSE (Banco Santander) in "Main".');
  expect((await run.store.loadTicker("SAN"))?.metadata.positions).toEqual([]);
  expect((await run.store.loadTicker("SAN:XNYS"))?.metadata.positions).toMatchObject([{ portfolio: "main", shares: 7 }]);

  const cleared = await exec("target", "clear", "main", "SAN", "--exchange", "NYSE");
  expect(cleared.data).toMatchObject({ changed: true, listing: "SAN:NYSE", removedTargets: 1 });
  expect(await targets()).toEqual({ SAN: 10 });

  // A bare symbol still means the row saved under that key.
  expect((await exec("target", "clear", "main", "SAN")).text).toContain('Cleared the target for SAN:EPA (Sanofi) in "Main".');
  expect(await targets()).toEqual({});
});
