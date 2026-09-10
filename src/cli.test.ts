import { afterEach, describe, expect, spyOn, test } from "bun:test";
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

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
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
  config.disabledPlugins = [...new Set([...(config.disabledPlugins ?? []), "yahoo", "gloomberb-cloud"])];
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

async function captureConsole<T>(fn: () => Promise<T> | T): Promise<{ result: T; stdout: string; stderr: string }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    logs.push(String(chunk).replace(/\n$/, ""));
    return true;
  });

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };

  try {
    const result = await fn();
    return {
      result,
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    stdout.mockRestore();
  }
}

async function captureConsoleFailure(fn: () => Promise<unknown> | unknown): Promise<{ stdout: string; stderr: string; exitCode: string | number | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;

  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    logs.push(String(chunk).replace(/\n$/, ""));
    return true;
  });

  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  process.exitCode = undefined;

  try {
    await fn();
    if (process.exitCode == null || process.exitCode === 0) {
      throw new Error("Expected command to fail.");
    }
    return {
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
      exitCode: process.exitCode,
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode ?? 0;
    stdout.mockRestore();
  }
}

function makeTicker(overrides: Partial<TickerRecord["metadata"]> = {}): TickerRecord {
  return {
    metadata: {
      ticker: "NVDA",
      exchange: "NASDAQ",
      currency: "USD",
      name: "NVIDIA Corporation",
      portfolios: [],
      watchlists: [],
      positions: [],
      custom: {},
      tags: [],
      ...overrides,
    },
  };
}

describe("CLI watchlist commands", () => {
  test("help lists the prediction markets launcher", async () => {
    const { result, stdout } = await captureConsole(() => runCli(["help"]));

    expect(result).toBe(true);
    expect(stdout).toContain("predictions [...]");
    expect(stdout).toContain("Prediction Launch");
    expect(stdout).toContain("gloomberb predictions world");
    expect(stdout).toContain("Portfolio Actions");
    expect(stdout).toContain("Watchlist Actions");
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
    expect(addResult.stdout).toContain('Added NVDA to "Growth".');

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

    const result = await captureConsoleFailure(() => runCli(["portfolio", "create", "Research"]));
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
    expect(addResult.stdout).toContain('Added NVDA to "Research".');

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
    expect(first.stdout).toContain('Set position for NVDA in "Research".');
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
    expect(removeResult.stdout).toContain('Removed NVDA from "Research".');
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

    const result = await captureConsoleFailure(() => runCli(["portfolio", "add", "IBKR Account", "NVDA"]));
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
          providerId: "yahoo",
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
    expect(report).toContain("yahoo");
  });

  test("renders an empty state when no search results match", () => {
    const report = buildSearchReport({
      query: "zzzz",
      candidates: [],
    });

    expect(report).toContain("Search: zzzz");
    expect(report).toContain("No matches found.");
  });
});
