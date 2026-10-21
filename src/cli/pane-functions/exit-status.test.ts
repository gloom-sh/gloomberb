import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { getLoadablePlugins } from "../../plugins/catalog";
import { captureConsole } from "../../test-support/console";
import { createTestCliContext } from "../../test-support/cli-context";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import { reportFailure, runPaneFunction } from ".";
import { serializeCliResult } from "../result";
import { DEFAULT_CLI_OPTIONS } from "../options";

let finra: ReturnType<typeof spyOn> | null = null;
afterEach(() => {
  finra?.mockRestore();
  // A list that finds nothing sets the exit status; it must not become the test run's.
  process.exitCode = 0;
});

/** FINRA settles GME; every other name has no settlement. */
beforeEach(() => {
  finra = spyOn(apiClient, "getCloudShortInterest").mockImplementation(async (symbol: string) => symbol === "GME"
    ? { status: "success", data: { symbol, issueName: "GameStop", points: [
      { settlementDate: "2026-09-30", sharesShort: 42_670_000, previousSharesShort: 39_000_000, averageDailyVolume: null, daysToCover: 3.98, changePercent: 9.2, revised: false },
    ] } } as never
    : { status: "empty" } as never);
});

async function runSiw(...args: string[]) {
  const persistence = new AppPersistence(":memory:");
  const cli = createTestCliContext({
    config: createDefaultConfig("/tmp/gloomberb-list-exit-test"),
    dataProvider: createTestDataProvider(),
    persistence,
    store: new TickerRepository(persistence.tickers),
  });
  (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
  process.exitCode = 0;
  const { exitCode } = await captureConsole(() => runPaneFunction(["SIW", ...args], cli.context));
  const { data, failure } = cli.printed[0]!.result as { data: { rowCount: number; symbols: string[]; errors: string[] }; failure?: unknown };
  // JSON's `ok` is the exit status's word: false exactly when it is 1.
  expect(!failure).toBe((exitCode ?? 0) === 0);
  return { exitCode: exitCode ?? 0, ...data };
}

test("fn SIW exits 1 when no name resolved and 0 when some did, naming the ones left out", async () => {
  // Every entry skipped: each is named with its reason, and nothing is left to look up.
  expect(await runSiw("BTC-USD", "BRK-B-nonsense")).toMatchObject({
    exitCode: 1,
    rowCount: 0,
    errors: ["Left out: BTC-USD: not a US ticker symbol; BRK-B-NONSENSE: not a US ticker symbol."],
  });
  // Names looked up that FINRA has nothing for.
  expect(await runSiw("ZZZZ")).toMatchObject({ exitCode: 1, rowCount: 1 });
  // One name with data is a result; the one skipped stays listed.
  expect(await runSiw("GME;BTC-USD")).toMatchObject({
    exitCode: 0,
    symbols: ["GME"],
    errors: ["Left out: BTC-USD: not a US ticker symbol."],
  });
});

test("fn fails a report with no data for what was asked, and JSON says ok: false with why beside the data", () => {
  const report = { empty: false, rowCount: 6, symbols: ["SCHD"], unavailableSymbols: ["SCHD"], errors: ["Coverage for new underlyings is full; try again later."] };
  // A report of six empty statistics for SCHD has nothing for SCHD.
  const failure = reportFailure(report, "fn HIVG SCHD");
  expect(failure).toEqual({ code: "no_data", message: "fn HIVG SCHD: Coverage for new underlyings is full; try again later." });
  expect(reportFailure({ empty: true, rowCount: 0, symbols: ["TWTR"], unavailableSymbols: ["TWTR"], errors: ["A current underlying price is required"] }, "fn OVDV TWTR"))
    .toEqual({ code: "no_data", message: "fn OVDV TWTR: A current underlying price is required." });
  // An empty board asked about no symbol fails too; a listing key is its symbol.
  expect(reportFailure({ empty: true, rowCount: 0, symbols: [], unavailableSymbols: [] }, "fn HALT")?.message).toBe("fn HALT: no data.");
  expect(reportFailure({ empty: false, rowCount: 1, symbols: ["SAN:EPA"], unavailableSymbols: ["SAN"] }, "fn DVD SAN:EPA")).not.toBeNull();
  // Data for some of what was asked, errors and all, is a result.
  expect(reportFailure({ empty: false, rowCount: 2, symbols: ["SPY", "QQQ"], unavailableSymbols: ["QQQ"], errors: ["QQQ: timed out"] }, "fn G SPY,QQQ")).toBeNull();
  expect(reportFailure({ empty: false, rowCount: 18, symbols: ["SPY"], unavailableSymbols: [], errors: ["2027-01-15: no quotes"] }, "fn OVDV SPY")).toBeNull();

  const json = JSON.parse(serializeCliResult({ data: report, failure: failure! }, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  expect(json).toMatchObject({ ok: false, error: { code: "no_data" }, data: { symbols: ["SCHD"] } });
  expect(JSON.parse(serializeCliResult({ data: report }, { ...DEFAULT_CLI_OPTIONS, format: "json" })).ok).toBe(true);
});
