import { afterEach, expect, mock, spyOn, test } from "bun:test";
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
  // A console.error spy left in place swallows later files' logs, and their own spyOn gets it back with these calls.
  mock.restore();
  for (const persistence of persistences.splice(0)) persistence.close();
  await Promise.all(dataDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const NAMES: Record<string, string> = { AAPL: "Apple Inc.", MSFT: "Microsoft Corp" };

async function setup(providerOverrides: Parameters<typeof createTestDataProvider>[0] = {}) {
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
    ...providerOverrides,
  });
  const run = async (args: string[], options: { dryRun?: boolean } = {}) => {
    const cli = createTestCliContext({ config: await loadConfig(dataDir), store, dataProvider }, options);
    await portfolioCliCommand.execute(["import", ...args], cli.context);
    return cli.printed[0]!;
  };
  return { store, dataDir, file, run };
}

test("a verified last trade blocks a current snapshot but a stale quote alone does not", async () => {
  const delisting = { status: "delisted" as const, lastTradeDate: "2022-10-27", historyStart: "2016-01-04" };
  const known = (symbol: string, exchange: string, name: string) => ({ providerId: "test", symbol, name, exchange, currency: "USD", type: "STK" });
  const hop = { from: "SQ", to: "XYZ", date: "2025-01-21" };
  const { store, dataDir, file, run } = await setup({
    search: async (query) => query.startsWith("TWTR") ? [{ ...known("TWTR", "NYSE", "Twitter, Inc."), delisting }]
      : query.startsWith("SQ") ? [known("SQ", "NYSE", "Block, Inc."), known("SQ", "TSX", "Another Company")]
      : query === "AAPL" ? [known("AAPL", "NASDAQ", "Apple Inc.")] : [],
    getQuote: async (symbol) => {
      if (symbol === "SQ") throw new Error("Not a ticker: SQ.");
      const twitter = symbol === "TWTR";
      const exchange = twitter ? "NYSE" : "NASDAQ";
      return createTestQuote({ symbol, name: twitter ? "Twitter, Inc." : "Apple Inc.", listingExchangeName: exchange,
        lastUpdated: Date.parse("2022-10-27T20:00:00Z"), ...(twitter ? { delisting } : {}) });
    },
    getTickerChanges: async (symbol) => symbol === "SQ" ? {
      symbol, listedName: null, formerly: null, changes: [hop], moved: { symbol: "XYZ", name: "Block, Inc.", hops: [hop] },
    } : null,
  });
  await writeFile(file, "Symbol,Shares,Avg Cost,Security Type\nAAPL,10,150,Equity\nTWTR,15,44,Equity\nSQ,25,72.40,Equity\nXYZ 01/15/2027 80.00 C,1,9.10,Option\nCASH,100,,Cash\n");
  const preview = await run([file, "--name", "Main", "--merge"], { dryRun: true });
  expect(preview.result.data).toMatchObject({ positions: [{ listing: "AAPL:NASDAQ" }], skipped: [
    { label: "TWTR", reason: "Listing no longer trades (last traded 2022-10-27)." },
    { label: "SQ", reason: expect.stringMatching(/SQ:NYSE.*SQ:TSX.*SQ became XYZ on 2025-01-21/) },
    { label: "XYZ 01/15/2027 80.00 C", symbol: "XYZ 01/15/2027 80.00 C", kind: "option" },
    { label: "CASH", kind: "cash" },
  ] });
  expect(await store.loadTicker("AAPL")).toBeNull();
  const held = createTestTicker("TWTR", "Twitter, Inc.", { exchange: "NYSE", portfolios: ["main"],
    positions: [{ portfolio: "main", shares: 3, avgCost: 40, currency: "USD", broker: "manual" }] });
  await store.saveTicker(held);
  const originalConfig = await loadConfig(dataDir);
  await expect(run([file, "--name", "Main", "--replace"])).rejects.toThrow('Not replacing "Main"');
  expect(await loadConfig(dataDir)).toEqual(originalConfig);
  expect(await store.loadTicker("AAPL")).toBeNull();
  await run([file, "--name", "Main", "--merge"]);
  expect((await store.loadTicker("AAPL"))?.metadata.positions[0]?.shares).toBe(10);
  expect((await store.loadTicker("TWTR"))?.metadata.positions).toEqual(held.metadata.positions);
  expect(await store.loadTicker("XYZ")).toBeNull();
});

test.each([0, 86_400_000])("a withdrawal beats a matching quote %i ms old without excluding a reused symbol", async (age) => {
  const row = (symbol: string, name: string, exchange = "NYSE") => ({ providerId: "test", symbol, name, exchange, currency: "USD", type: "STK" });
  const withdrawal = { on: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), reason: "Exchange withdrawal" };
  const withdrawn = row("WDWN", "Willow Industrial Ltd");
  const reused = row("REUS", "Beacon Energy Holdings Ltd");
  const { store, dataDir, file, run } = await setup({
    search: async (query) => query.split(":")[0] === withdrawn.symbol ? [{ ...withdrawn, withdrawal }]
      : query.split(":")[0] === reused.symbol ? [
        { ...row(reused.symbol, "Beacon Energy Ltd"), withdrawal },
        { ...row(reused.symbol, reused.name, "NASDAQ"), withdrawal },
        reused,
      ] : [],
    getQuote: async (key) => {
      const listing = key.split(":")[0] === withdrawn.symbol ? withdrawn : reused;
      return createTestQuote({ symbol: listing.symbol, name: listing.name, listingExchangeName: listing.exchange,
        exchangeName: listing.exchange, lastUpdated: Date.now() - age });
    },
  });
  await writeFile(file, "Symbol,Shares,Avg Cost\nWDWN,10,150\nREUS,5,300\n");
  const expected = { positions: [{ listing: "REUS:NYSE", name: reused.name }], skipped: [
    { label: "WDWN", reason: expect.stringContaining("Exchange withdrawal") },
  ] };
  const preview = await run([file, "--name", "Main", "--merge"], { dryRun: true });
  expect(preview.result.data).toMatchObject(expected);
  expect(await store.loadTicker(withdrawn.symbol)).toBeNull();

  const held = createTestTicker(withdrawn.symbol, "Willow Industrial", { exchange: "NYSE", portfolios: ["main"],
    positions: [{ portfolio: "main", shares: 3, avgCost: 40, currency: "USD", broker: "manual" }] });
  await store.saveTicker(held);
  const original = await store.loadTicker(withdrawn.symbol);
  const save = spyOn(store, "saveTicker");
  const saveBatch = spyOn(store, "saveTickers");
  const create = spyOn(store, "createTicker");
  const remove = spyOn(store, "deleteTicker");
  const config = await Bun.file(join(dataDir, "config.json")).text();
  await expect(run([file, "--name", "Main", "--replace"])).rejects.toThrow("1 of the file's positions could not be imported (WDWN)");
  expect(save).not.toHaveBeenCalled();
  expect(saveBatch).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(await Bun.file(join(dataDir, "config.json")).text()).toBe(config);

  const merged = await run([file, "--name", "Main", "--merge"]);
  expect(merged.result.data).toMatchObject(expected);
  expect(await store.loadTicker(withdrawn.symbol)).toEqual(original);
  expect((await store.loadTicker(reused.symbol))?.metadata.positions?.[0]?.shares).toBe(5);
});

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
