import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AppPersistence } from "../../../../data/app-persistence";
import { TickerRepository } from "../../../../data/ticker-repository";
import { loadConfig, saveConfig } from "../../../../data/config/store";
import { createDefaultConfig } from "../../../../types/config";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import { setCliColorEnabledOverride } from "../../../../utils/cli-output";
import { portfolioCliCommand } from "./portfolio-command";

const persistences: AppPersistence[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  setCliColorEnabledOverride(null);
  for (const persistence of persistences.splice(0)) persistence.close();
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const NAMES: Record<string, string> = { AAPL: "Apple Inc.", MSFT: "Microsoft Corp" };

async function setup() {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  await store.saveTicker(createTestTicker("XOM", "Exxon Mobil", {
    exchange: "NYSE", portfolios: ["main"], positions: [{ portfolio: "main", shares: 5, avgCost: 100, currency: "USD", broker: "manual" }],
  }));
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-positions-import-"));
  dataDirs.push(dataDir);
  await saveConfig({ ...createDefaultConfig(dataDir), portfolios: [{ id: "main", name: "Main", currency: "USD" }] });
  const file = join(dataDir, "holdings.csv");
  await writeFile(file, "Symbol,Shares,Avg Cost\nAAPL,10,150\nMSFT,5,300\nCASH,100,\nZZZZ,1,1\n");
  const dataProvider = createTestDataProvider({
    search: async (query) => NAMES[query]
      ? [{ providerId: "test", symbol: query, name: NAMES[query]!, exchange: "NASDAQ", type: "Common Stock", currency: "USD" }]
      : [],
    getQuote: async (symbol) => {
      if (!NAMES[symbol]) throw new Error(`Not a ticker: ${symbol}.`);
      return createTestQuote({ symbol, name: NAMES[symbol], listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" });
    },
  });
  const run = async (args: string[], options: { dryRun?: boolean } = {}) => {
    const cli = createTestCliContext({ config: await loadConfig(dataDir), store, dataProvider }, options);
    await portfolioCliCommand.execute(["import", ...args], cli.context);
    return cli.printed[0]!;
  };
  return { store, dataDir, file, run };
}

test("portfolio import <file> previews with --dry-run, creates the portfolio, needs --merge or --replace for one that holds tickers, and refuses a replace the file cannot fill", async () => {
  const { store, dataDir, file, run } = await setup();
  setCliColorEnabledOverride(false);
  spyOn(console, "error").mockImplementation(() => {});

  const preview = await run([file], { dryRun: true });
  expect(preview.result.data).toMatchObject({ changed: false, action: "created", portfolio: "holdings", layout: "generic" });
  expect((preview.result.data as { positions: Array<{ listing: string; shares: number; avgCost: number; status: string }> }).positions
    .map((row) => [row.listing, row.shares, row.avgCost, row.status])).toEqual([["AAPL:NASDAQ", 10, 150, "new"], ["MSFT:NASDAQ", 5, 300, "new"]]);
  expect((preview.result.data as { skipped: Array<{ label: string }> }).skipped.map((row) => row.label)).toEqual(["CASH", "ZZZZ"]);
  const text = preview.options?.text?.(preview.result.data) ?? "";
  expect(text).toContain('Would create portfolio "holdings" with 2 positions from holdings.csv.');
  expect(text).toContain("cash or money market");
  // Nothing saved.
  expect((await loadConfig(dataDir)).portfolios.map((portfolio) => portfolio.name)).toEqual(["Main"]);
  expect(await store.loadTicker("AAPL")).toBeNull();

  await run([file]);
  const created = (await loadConfig(dataDir)).portfolios.find((portfolio) => portfolio.name === "holdings")!;
  expect((await store.loadTicker("AAPL"))?.metadata.positions).toEqual([{ portfolio: created.id, shares: 10, avgCost: 150, currency: "USD", broker: "manual" }]);

  await expect(run([file, "--name", "Main"])).rejects.toThrow('Portfolio "Main" already holds 1 ticker.');
  // ZZZZ does not resolve: a replace would leave the portfolio short of the file, so it is refused and nothing changes.
  await expect(run([file, "--name", "Main", "--replace"])).rejects.toThrow("1 of the file's positions could not be imported (ZZZZ)");
  expect((await store.loadTicker("XOM"))?.metadata.portfolios).toEqual(["main"]);
  await writeFile(file, "Symbol,Shares,Avg Cost\nAAPL,10,150\nMSFT,5,300\nCASH,100,\n");
  const replaced = await run([file, "--name", "Main", "--replace"]);
  expect(replaced.result.data).toMatchObject({ action: "replace", removed: [{ listing: "XOM:NYSE" }] });
  expect((await store.loadTicker("XOM"))?.metadata.portfolios).toEqual([]);
  expect((await store.loadTicker("MSFT"))?.metadata.portfolios).toEqual([created.id, "main"]);
});
