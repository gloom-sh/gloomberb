import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { AppPersistence } from "./data/app-persistence";
import { loadConfig, saveConfig } from "./data/config/store";
import {
  buildSearchReport,
  runCli,
  searchCandidatesForCli,
} from "./cli/index";
import { createDefaultConfig } from "./types/config";
import { TickerRepository } from "./data/ticker-repository";
import type { TickerRecord } from "./types/ticker";
import { createTestDataProvider } from "./test-support/data-provider";
import { createTestTicker } from "./test-support/ticker";
import { captureConsole } from "./test-support/console";
import { apiClient } from "./api-client";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  mock.restore();
  process.env.HOME = originalHome;
  process.exitCode = 0;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function createCliFixture({
  portfolios,
  watchlists,
  tickers = [],
  baseCurrency,
}: {
  portfolios?: Array<{ id: string; name: string; currency: string; brokerId?: string; brokerInstanceId?: string; brokerAccountId?: string }>;
  watchlists: Array<{ id: string; name: string }>;
  tickers?: TickerRecord[];
  baseCurrency?: string;
}) {
  const homeDir = await createTempDir("gloomberb-cli-home-");
  const dataDir = await createTempDir("gloomberb-cli-data-");
  process.env.HOME = homeDir;

  await mkdir(join(homeDir, ".gloomberb"), { recursive: true });
  await writeFile(join(homeDir, ".gloomberb", "config.json"), JSON.stringify({ dataDir }), "utf-8");

  const config = createDefaultConfig(dataDir);
  if (baseCurrency) {
    config.baseCurrency = baseCurrency;
  }
  config.disabledPlugins = [...new Set([...(config.disabledPlugins ?? []), "gloomberb-cloud"])];
  if (portfolios) {
    config.portfolios = portfolios;
  }
  config.watchlists = watchlists;
  await saveConfig(config);

  const persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
  const store = new TickerRepository(persistence.tickers);
  for (const ticker of tickers) {
    await store.saveTicker(ticker);
  }
  persistence.close();

  return { dataDir };
}

const makeTicker = (overrides: Partial<TickerRecord["metadata"]> = {}) => createTestTicker("NVDA", "NVIDIA Corporation", overrides);

describe("CLI watchlist commands", () => {
  test("a help flag prints the command's help instead of running it", async () => {
    const { dataDir } = await createCliFixture({ watchlists: [] });

    const { result, stdout } = await captureConsole(() => runCli(["watchlist", "create", "--help"]));
    const config = await loadConfig(dataDir);

    expect(result).toBe(true);
    expect(config.watchlists).toEqual([]);
    expect(stdout).toContain("gloomberb watchlist create <name>");
  });

  test("a help flag after a function prints that function's options, not fn's", async () => {
    await createCliFixture({ watchlists: [] });
    spyOn(apiClient, "geo").mockResolvedValue({ series: [] });

    const own = await captureConsole(() => runCli(["fn", "BT", "--preset", "trend-200", "--help"]));
    expect(own.stdout).toContain("--include-partial <boolean>");
    expect(own.stdout).toContain("gloomberb fn BT <ticker> --csv --equity");
    expect(own.stdout).not.toContain("Run a market function");
    // A pane id runs the function, so it is helped like one.
    expect((await captureConsole(() => runCli(["fn", "backtest", "--help"]))).stdout).toContain("--include-partial <boolean>");
    // Without a function, or with a word that names none, the command's own help stands.
    for (const args of [["fn", "--help"], ["fn", "NOTAFUNCTION", "--help"]]) {
      expect((await captureConsole(() => runCli(args))).stdout).toContain("Run a market function and print its report");
    }
  });

  test("creates a watchlist and persists the generated id", async () => {
    const { dataDir } = await createCliFixture({ watchlists: [] });

    const { stdout } = await captureConsole(() => runCli(["watchlist", "create", "Growth Radar"]));
    const config = await loadConfig(dataDir);

    expect(config.watchlists).toEqual([{ id: "growth-radar", name: "Growth Radar" }]);
    expect(stdout).toContain('Created watchlist "Growth Radar".');
    expect(stdout).toContain("growth-radar");
  });

  test("adds a local ticker to a watchlist and cleans memberships on delete", async () => {
    const { dataDir } = await createCliFixture({
      watchlists: [{ id: "growth", name: "Growth" }],
      tickers: [makeTicker()],
    });

    const addResult = await captureConsole(() => runCli(["watchlist", "add", "Growth", "NVDA"]));
    expect(addResult.stdout).toContain('Added NVDA:NASDAQ (NVIDIA Corporation) to "Growth".');

    let persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
    let store = new TickerRepository(persistence.tickers);
    let savedTicker = await store.loadTicker("NVDA");
    persistence.close();

    expect(savedTicker?.metadata.watchlists).toEqual(["growth"]);

    const deleteResult = await captureConsole(() => runCli(["watchlist", "delete", "Growth"]));
    expect(deleteResult.stdout).toContain('Deleted watchlist "Growth".');
    expect(deleteResult.stdout).toContain("Cleaned Tickers");

    const config = await loadConfig(dataDir);
    expect(config.watchlists).toEqual([]);

    persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
    store = new TickerRepository(persistence.tickers);
    savedTicker = await store.loadTicker("NVDA");
    persistence.close();

    expect(savedTicker?.metadata.watchlists).toEqual([]);
  });
});

describe("CLI collection lists", () => {
  test("watchlist add takes many symbols: one line each, a summary, and never a symbol read into the list's name", async () => {
    const { dataDir } = await createCliFixture({
      watchlists: [{ id: "growth", name: "Growth" }],
      tickers: [makeTicker(), makeTicker({ ticker: "MSFT", name: "Microsoft Corporation" }), makeTicker({ ticker: "XOM", name: "Exxon Mobil", exchange: "NYSE", watchlists: ["growth"] })],
    });

    const added = await captureConsole(() => runCli(["watchlist", "add", "Growth", "nvda", "msft ,XXXXX", "xom ", "NVDA"]));
    expect(added.exitCode).not.toBe(1);
    expect(added.stdout).toContain("Added NVDA:NASDAQ (NVIDIA Corporation)");
    expect(added.stdout).toContain("Already in the list: XOM:NYSE (Exxon Mobil)");
    expect(added.stdout).toContain("Not found: XXXXX");
    expect(added.stdout).toContain('Watchlist "Growth": 2 added, 1 already in the list, 1 not found: XXXXX; 1 repeat skipped.');
    const persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
    const store = new TickerRepository(persistence.tickers);
    expect((await store.loadAllTickers()).filter((ticker) => ticker.metadata.watchlists.includes("growth")).map((ticker) => ticker.metadata.ticker).sort())
      .toEqual(["MSFT", "NVDA", "XOM"]);
    persistence.close();

    const again = await captureConsole(() => runCli(["watchlist", "add", "Growth", "NVDA,MSFT", "--json"]));
    const json = JSON.parse(again.stdout);
    expect(json.data.map((row: { status: string; listing: string }) => [row.status, row.listing])).toEqual([["already_listed", "NVDA:NASDAQ"], ["already_listed", "MSFT:NASDAQ"]]);
    expect(json.metadata).toMatchObject({ watchlist: "Growth", added: 0, alreadyListed: 2, notFound: 0 });

    // Nothing resolving is a failure; so is a list name nothing matches, named as typed.
    const none = await captureConsole(() => runCli(["watchlist", "add", "Growth", "FAKE1", "FAKE2"]));
    expect(none.exitCode).toBe(1);
    expect(none.stdout).toContain('Watchlist "Growth": 0 added, 2 not found: FAKE1, FAKE2.');
    const glued = await captureConsole(() => runCli(["watchlist", "add", "Groth", "nvda", "xom "]));
    expect(glued.exitCode).toBe(1);
    expect(glued.stderr).toContain('Watchlist "Groth" was not found.');
    expect(glued.stderr).toContain("Watchlists: Growth");

    const removed = await captureConsole(() => runCli(["watchlist", "remove", "Growth", "NVDA", "MSFT", "AAPL"]));
    expect(removed.stdout).toContain('Watchlist "Growth": 2 removed, 1 not found: AAPL.');

    const shown = await captureConsole(() => runCli(["watchlist", "show", "Growth", "--csv"]));
    const [header, ...rows] = shown.stdout.split("\n");
    expect(header!.split(",").slice(0, 5)).toEqual(["symbol", "listing", "name", "exchange", "kind"]);
    expect(rows.map((row) => row.split(",")[1])).toEqual(["XOM:NYSE"]);
  });

  test("portfolio add and remove take many symbols, and an unquoted name with spaces still names the portfolio", async () => {
    const { dataDir } = await createCliFixture({
      portfolios: [{ id: "research", name: "Research Book", currency: "USD" }],
      watchlists: [],
      tickers: [makeTicker(), makeTicker({ ticker: "MSFT", name: "Microsoft Corporation" })],
    });

    const added = await captureConsole(() => runCli(["portfolio", "add", "Research", "Book", "NVDA", "MSFT", "CASH"]));
    expect(added.stdout).toContain("Added MSFT:NASDAQ (Microsoft Corporation)");
    expect(added.stdout).toContain("Not added: CASH (CASH is the portfolio's cash line, not a ticker)");
    expect(added.stdout).toContain('Portfolio "Research Book": 2 added; 1 not added: CASH.');

    const removed = await captureConsole(() => runCli(["portfolio", "remove", "Research Book", "NVDA", "MSFT"]));
    expect(removed.stdout).toContain('Portfolio "Research Book": 2 removed.');
    const persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
    expect((await new TickerRepository(persistence.tickers).loadAllTickers()).some((ticker) => ticker.metadata.portfolios.includes("research"))).toBe(false);
    persistence.close();

    const glued = await captureConsole(() => runCli(["portfolio", "add", "Books", "NVDA", "MSFT"]));
    expect(glued.stderr).toContain('Portfolio "Books" was not found.');
  });
});

describe("CLI portfolio commands", () => {
  test("creates a manual portfolio and persists the generated id", async () => {
    const { dataDir } = await createCliFixture({
      portfolios: [{ id: "main", name: "Main Portfolio", currency: "USD" }],
      watchlists: [],
    });

    const { stdout } = await captureConsole(() => runCli(["portfolio", "create", "Research"]));
    const config = await loadConfig(dataDir);

    expect(config.portfolios).toEqual([
      { id: "main", name: "Main Portfolio", currency: "USD" },
      { id: "research", name: "Research", currency: "USD" },
    ]);
    expect(stdout).toContain('Created portfolio "Research".');
    expect(stdout).toContain("research");
  });

  test("rejects duplicate manual portfolio names", async () => {
    await createCliFixture({
      portfolios: [{ id: "research", name: "Research", currency: "USD" }],
      watchlists: [],
    });

    const result = await captureConsole(() => runCli(["portfolio", "create", "Research"]));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Portfolio "Research" already exists.');
  });

  test("adds a ticker to a manual portfolio and supports legacy show", async () => {
    const { dataDir } = await createCliFixture({
      portfolios: [{ id: "research", name: "Research", currency: "USD" }],
      watchlists: [],
      tickers: [makeTicker()],
    });

    const addResult = await captureConsole(() => runCli(["portfolio", "add", "Research", "NVDA"]));
    expect(addResult.stdout).toContain('Added NVDA:NASDAQ (NVIDIA Corporation) to "Research".');

    let persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
    let store = new TickerRepository(persistence.tickers);
    let savedTicker = await store.loadTicker("NVDA");
    persistence.close();

    expect(savedTicker?.metadata.portfolios).toEqual(["research"]);

    const showResult = await captureConsole(() => runCli(["portfolio", "Research"]));
    expect(showResult.stdout).toContain("Research (USD)");
    expect(showResult.stdout).toContain("NVDA");
  });

  test("sets and replaces a manual position for a portfolio ticker", async () => {
    const { dataDir } = await createCliFixture({
      portfolios: [{ id: "research", name: "Research", currency: "USD" }],
      watchlists: [],
      tickers: [makeTicker()],
      baseCurrency: "USD",
    });

    const first = await captureConsole(() => runCli(["portfolio", "position", "set", "Research", "NVDA", "10", "400"]));
    expect(first.stdout).toContain('Set position for NVDA:NASDAQ (NVIDIA Corporation) in "Research".');
    expect(first.stdout).toContain("Shares");
    expect(first.stdout).toContain("10");

    const second = await captureConsole(() => runCli(["portfolio", "position", "set", "Research", "NVDA", "12", "405", "EUR"]));
    expect(second.stdout).toContain("EUR");

    const persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
    const store = new TickerRepository(persistence.tickers);
    const savedTicker = await store.loadTicker("NVDA");
    persistence.close();

    expect(savedTicker?.metadata.portfolios).toEqual(["research"]);
    expect(savedTicker?.metadata.positions).toEqual([{
      portfolio: "research",
      shares: 12,
      avgCost: 405,
      currency: "EUR",
      broker: "manual",
    }]);
  });

  test("a size of 1.250 on a listing held in whole lots asks which was meant, as 1,250 does; a US listing takes it as 1.25", async () => {
    const { dataDir } = await createCliFixture({
      portfolios: [{ id: "lira", name: "Lira", currency: "TRY" }],
      watchlists: [],
      tickers: [
        createTestTicker("THYAO.IS", "Turk Hava Yollari", { exchange: "BIST", currency: "TRY", assetCategory: "STK" }),
        makeTicker({ assetCategory: "STK" }),
      ],
    });

    const lots = await captureConsole(() => runCli(["portfolio", "position", "set", "Lira", "THYAO.IS:BIST", "1.250", "312,50", "TRY"]));
    expect(lots.exitCode).toBe(1);
    expect(lots.stderr).toContain("Shares 1.250 could be 1250 (thousands) or 1.25 (decimal point), and THYAO.IS:BIST trades in whole shares; type 1250 or 1.25.");

    const fraction = await captureConsole(() => runCli(["portfolio", "position", "set", "Lira", "NVDA", "1.250", "180", "USD"]));
    expect(fraction.exitCode).toBe(0);
    const persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
    const store = new TickerRepository(persistence.tickers);
    expect((await store.loadTicker("NVDA"))?.metadata.positions[0]?.shares).toBe(1.25);
    expect((await store.loadTicker("THYAO.IS"))?.metadata.positions).toEqual([]);
    persistence.close();
  });

  test("removes portfolio membership and positions, then cleans all references on delete", async () => {
    const { dataDir } = await createCliFixture({
      portfolios: [
        { id: "main", name: "Main Portfolio", currency: "USD" },
        { id: "research", name: "Research", currency: "USD" },
      ],
      watchlists: [],
      tickers: [
        makeTicker({
          ticker: "NVDA",
          portfolios: ["research"],
          positions: [{
            portfolio: "research",
            shares: 5,
            avgCost: 350,
            currency: "USD",
            broker: "manual",
          }],
        }),
        makeTicker({
          ticker: "ASML",
          portfolios: ["research", "main"],
          positions: [{
            portfolio: "research",
            shares: 3,
            avgCost: 700,
            currency: "USD",
            broker: "manual",
          }, {
            portfolio: "main",
            shares: 1,
            avgCost: 650,
            currency: "USD",
            broker: "manual",
          }],
        }),
      ],
    });

    const removeResult = await captureConsole(() => runCli(["portfolio", "remove", "Research", "NVDA"]));
    expect(removeResult.stdout).toContain('Removed NVDA:NASDAQ (NVIDIA Corporation) from "Research".');
    expect(removeResult.stdout).toContain("Removed Positions");

    let persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
    let store = new TickerRepository(persistence.tickers);
    let savedTicker = await store.loadTicker("NVDA");
    persistence.close();

    expect(savedTicker?.metadata.portfolios).toEqual([]);
    expect(savedTicker?.metadata.positions).toEqual([]);

    const deleteResult = await captureConsole(() => runCli(["portfolio", "delete", "Research"]));
    expect(deleteResult.stdout).toContain('Deleted portfolio "Research".');
    expect(deleteResult.stdout).toContain("Removed Positions");

    const config = await loadConfig(dataDir);
    expect(config.portfolios).toEqual([{ id: "main", name: "Main Portfolio", currency: "USD" }]);

    persistence = new AppPersistence(join(dataDir, ".gloomberb-cache.db"));
    store = new TickerRepository(persistence.tickers);
    savedTicker = await store.loadTicker("ASML");
    persistence.close();

    expect(savedTicker?.metadata.portfolios).toEqual(["main"]);
    expect(savedTicker?.metadata.positions).toEqual([{
      portfolio: "main",
      shares: 1,
      avgCost: 650,
      currency: "USD",
      broker: "manual",
    }]);
  });

  test("rejects broker-managed portfolio mutations", async () => {
    await createCliFixture({
      portfolios: [{
        id: "broker:ibkr:acct",
        name: "IBKR Account",
        currency: "USD",
        brokerId: "ibkr",
        brokerInstanceId: "ibkr-live",
      }],
      watchlists: [],
      tickers: [makeTicker()],
    });

    const result = await captureConsole(() => runCli(["portfolio", "add", "IBKR Account", "NVDA"]));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Portfolio "IBKR Account" is broker-managed and cannot be modified manually.');
  });
});

describe("CLI search helpers", () => {
  test("merges local ticker matches with provider company search results", async () => {
    const candidates = await searchCandidatesForCli({
      query: "micro",
      tickers: [
        makeTicker({
          ticker: "MSFT",
          name: "Microsoft Corporation",
          exchange: "NASDAQ",
          assetCategory: "STK",
        }),
      ],
      dataProvider: createTestDataProvider({
        search: async () => [{
          providerId: "gloom",
          symbol: "MSTR",
          name: "MicroStrategy Incorporated",
          exchange: "NASDAQ",
          type: "EQUITY",
          currency: "USD",
        }],
      }),
    });

    expect(candidates.some((candidate) => candidate.label === "MSFT")).toBe(true);
    expect(candidates.some((candidate) => candidate.label === "MSTR")).toBe(true);

    const report = buildSearchReport({
      query: "micro",
      candidates,
    });

    expect(report).toContain("Search: micro");
    expect(report).toContain("MSFT");
    expect(report).toContain("Microsoft Corporation");
    expect(report).toContain("MSTR");
    expect(report).toContain("MicroStrategy Incorporated");
    expect(report).toContain("Saved");
    // Where a row came from is a saved ticker or a broker, never the data service's internal id.
    expect(report).not.toContain("gloom");
  });

  test("a bare symbol's listings go by the name its quote gives, as quote names them; another company keeps its own", async () => {
    const listing = (exchange: string, name: string) => ({ providerId: "gloom", symbol: "VTI", name, exchange, type: "ETF", currency: "USD" });
    const candidates = await searchCandidatesForCli({
      query: "vti",
      tickers: [],
      dataProvider: createTestDataProvider({
        // The catalogue still files VTI under its name from before the July 2026 rename.
        search: async () => [listing("ARCA", "Vanguard Total Stock Market ETF"), listing("BMV", "Vanguard Total Stock Market ETF"), listing("TSX", "Vitality Products Inc")],
        getQuote: async () => ({ symbol: "VTI", name: "Vanguard Morningstar Total Stock Market ETF", listingExchangeName: "ARCA", price: 381.94, currency: "USD", change: 0, changePercent: 0, lastUpdated: 0 }),
      }),
    });
    const names = Object.fromEntries(candidates.map((candidate) => [candidate.result?.exchange, candidate.detail.split(" | ")[0]]));
    expect(names).toEqual({
      ARCA: "Vanguard Morningstar Total Stock Market ETF",
      BMV: "Vanguard Morningstar Total Stock Market ETF",
      TSX: "Vitality Products Inc",
    });
  });

  test("an index code lists the index first as the primary listing, not behind the funds named for it", async () => {
    const funds = ["159100", "SPVT11", "HIGH11", "LVOL11", "NSDV11", "NDIV11", "NBOV11", "SPUB11", "IBOVX", "BOVV11", "BOVB11"]
      .map((symbol) => ({ providerId: "gloom", symbol, name: `${symbol} IBOV ETF`, exchange: "B3", type: "ETF" }));
    const search = async () => [
      { providerId: "gloom", symbol: "^BVSP", name: "Ibovespa", exchange: "B3", type: "INDEX", searchAliases: ["IBOV", "IBOV Index"] },
      { providerId: "gloom", symbol: "IBOV11", name: "IBOV11 Fund", exchange: "B3", type: "Common Stock" },
      ...funds,
    ];
    const candidates = await searchCandidatesForCli({ query: "IBOV", tickers: [], dataProvider: createTestDataProvider({ search }) });

    expect(candidates).toHaveLength(10);
    expect(candidates[0]).toMatchObject({ label: "^BVSP", category: "Primary Listing" });
    const headings = buildSearchReport({ query: "IBOV", candidates }).split("\n").filter((line) => /^(Primary Listing|Other Listings|Funds & Derivatives)/.test(line));
    expect(headings[0]).toContain("Primary Listing");
  });

  test("a company searched by name lists its home line as the primary listing, not a one-off cross-listing with its short name", async () => {
    const line = (symbol: string, exchange: string, name: string, extra: Record<string, unknown> = {}) =>
      ({ providerId: "gloom", symbol, name, exchange, type: "Common Stock", currency: "EUR", ...extra });
    const search = async () => [
      line("LHAB", "XSTU", "Lufthansa AG Sponsored ADR", { type: "American Depositary Receipt", popularity: 20005 }),
      line("LUFTH", "BUD", "LUFTHANSA", { currency: "HUF" }),
      line("LHA", "FWB2", "Deutsche Lufthansa AG", { popularity: 20050 }),
      line("LHA", "XETRA", "Deutsche Lufthansa AG", { popularity: 21027 }),
    ];
    const candidates = await searchCandidatesForCli({ query: "lufthansa", tickers: [], dataProvider: createTestDataProvider({ search }) });

    expect(candidates[0]).toMatchObject({ label: "LHA", category: "Primary Listing", result: { exchange: "XETRA" } });
    expect(candidates.filter((candidate) => candidate.category === "Primary Listing")).toHaveLength(1);
    expect(candidates.find((candidate) => candidate.label === "LUFTH")?.category).toBe("Other Listings");

    // A line that is already the most searched of its company stays, whatever else lists.
    const scored = await searchCandidatesForCli({ query: "deutsche bank", tickers: [], dataProvider: createTestDataProvider({ search: async () => [
      line("DB", "NYSE", "Deutsche Bank AG", { currency: "USD", popularity: 21718 }),
      line("DBK", "XETRA", "Deutsche Bank AG", { popularity: 20718 }),
    ] }) });
    expect(scored[0]).toMatchObject({ label: "DB", category: "Primary Listing" });
  });

  test("renders an empty state when no search results match", () => {
    const report = buildSearchReport({
      query: "zzzz",
      candidates: [],
    });

    expect(report).toContain("Search: zzzz");
    expect(report).toContain("No matches found.");
  });

  test("an empty search points at the catalog, which holds functions and terms rather than tickers", () => {
    const report = buildSearchReport({ query: "bitcoin perpetual", candidates: [] });

    expect(report).toContain('Try: gloomberb catalog "bitcoin perpetual"');
  });
});
