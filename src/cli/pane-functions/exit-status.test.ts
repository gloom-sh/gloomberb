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

/** A report's export: one table, its first column a label or date. */
const tables = (columns: string[], ...rows: Array<Array<string | number>>) => ({ tables: [{ title: "Report", columns, rows }], footer: [] });

test("fn fails a report with no data for what was asked, and JSON says ok: false with why beside the data", () => {
  const twtr = { empty: true, rowCount: 0, symbols: ["TWTR"], unavailableSymbols: ["TWTR"], errors: ["A current underlying price is required"] };
  const failure = reportFailure(twtr, "fn OVDV TWTR", { tables: { tables: [], footer: [] } });
  expect(failure).toEqual({ code: "no_data", message: "fn OVDV TWTR: A current underlying price is required." });
  // An empty board asked about no symbol fails too.
  expect(reportFailure({ empty: true, rowCount: 0, symbols: [], unavailableSymbols: [] }, "fn HALT")?.message).toBe("fn HALT: no data.");
  // Rows of labels with no value in them, for a symbol with nothing, are no data.
  const blank = tables(["Measure", "Current", "status"], ["IV 30d ATM (%)", "", "Current: no history"], ["IV 90d ATM (%)", "", ""]);
  expect(reportFailure({ empty: false, rowCount: 2, symbols: ["ZZZQ"], unavailableSymbols: ["ZZZQ"] }, "fn HIVG ZZZQ", { tables: blank })).not.toBeNull();

  const json = JSON.parse(serializeCliResult({ data: twtr, failure: failure! }, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  expect(json).toMatchObject({ ok: false, error: { code: "no_data" }, data: { symbols: ["TWTR"] } });
  expect(JSON.parse(serializeCliResult({ data: twtr }, { ...DEFAULT_CLI_OPTIONS, format: "json" })).ok).toBe(true);
});

test("partial data exits 0: a symbol without its headline figure whose tables have rows, or one listing of several", () => {
  // A loss-maker's P/E band has no P/E, so the report names the symbol, but its EPS history is data.
  const band = tables(["Period end", "EPS", "P/E"], ["2026-06-30", -0.42, "N/M"], ["2026-03-31", -0.38, "N/M"]);
  expect(reportFailure({ empty: false, rowCount: 2, symbols: ["RIVN"], unavailableSymbols: ["RIVN"], errors: ["No positive trailing EPS."] },
    "fn PEB RIVN", { tables: band })).toBeNull();
  // IV history with only realized volatility.
  const hv = tables(["Measure", "Current", "status"], ["IV 30d ATM (%)", "", ""], ["HV 20 (%)", 12.5, ""]);
  expect(reportFailure({ empty: false, rowCount: 2, symbols: ["SCHD"], unavailableSymbols: ["SCHD"] }, "fn HIVG SCHD", { tables: hv })).toBeNull();
  expect(reportFailure({ empty: false, rowCount: 2, symbols: ["SPY", "QQQ"], unavailableSymbols: ["QQQ"], errors: ["QQQ: timed out"] }, "fn G SPY,QQQ",
    { tables: tables(["Date"]) })).toBeNull();
});

test("a listing unavailable is that listing: another listing of the symbol, or another series, keeps its data", () => {
  const none = tables(["Date", "Value"]);
  const failed = (symbols: string[], unavailableSymbols: string[]) => reportFailure(
    { empty: false, rowCount: 1, symbols, unavailableSymbols }, `fn G ${symbols.join(",")}`, { tables: none }) !== null;
  // BHP in Sydney has nothing; BHP as asked, its US listing, does.
  expect(failed(["BHP:XASX", "BHP"], ["BHP:XASX"])).toBe(false);
  expect(failed(["fred:DGS10", "fred:DGS2"], ["fred:DGS10"])).toBe(false);
  expect(failed(["BHP:XASX", "BHP"], ["BHP:XASX", "BHP"])).toBe(true);
  // A report that names the listing by its bare symbol, or a bare symbol by the listing it resolved to, still means it.
  expect(failed(["SAN:EPA"], ["SAN"])).toBe(true);
  expect(failed(["sxr8"], ["SXR8:XETRA"])).toBe(true);
  // A bare name that could be either of two listings asked is neither.
  expect(failed(["SAN:EPA", "SAN:MCE"], ["SAN"])).toBe(false);
});
