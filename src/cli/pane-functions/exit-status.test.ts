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
import { DATA_SERVICE_UNREACHABLE_MESSAGE } from "../../utils/network-failure";
import { serializeCliResult } from "../result";
import { DEFAULT_CLI_OPTIONS, type CliGlobalOptions } from "../options";
import { isCliFailure } from "../errors";
import { setCliPlainOverride } from "../../utils/cli-output";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

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

function siwContext(cliOptions: Partial<CliGlobalOptions> = {}) {
  const persistence = new AppPersistence(":memory:");
  return createTestCliContext({
    config: createDefaultConfig("/tmp/gloomberb-list-exit-test"),
    dataProvider: createTestDataProvider(),
    persistence,
    store: new TickerRepository(persistence.tickers),
  }, cliOptions);
}

async function runSiw(...args: string[]) {
  const cli = siwContext();
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

// Offline, `fn FXC` printed a board with PEN "unavailable" beside saved ARS rates and exited 0, as if PEN had no rate.
test("a part missing because the data service could not be reached fails as retryable, whatever else the report shows", () => {
  const unreached = `PEN: ${DATA_SERVICE_UNREACHABLE_MESSAGE}`;
  expect(reportFailure({ empty: false, rowCount: 6, symbols: ["USD", "ARS", "PEN"], unavailableSymbols: ["PEN"], errors: [unreached] }, "fn FXC"))
    .toEqual({ code: "service_unreachable", message: `fn FXC: ${unreached}.`, details: expect.stringMatching(/^Check the internet connection/), retryable: true });
  expect(reportFailure({ empty: false, rowCount: 1, symbols: ["GGAL"], unavailableSymbols: ["GGAL"], errors: [`GGAL: ${DATA_SERVICE_UNREACHABLE_MESSAGE}`] },
    "fn SIW GGAL", { failsWithoutData: true })?.code).toBe("service_unreachable");
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

// `fn RV NEE --csv --output rv.csv` printed the CSV, wrote nothing and exited 0.
test("fn --output writes the report to the file, in the format asked for, and says where; what only shot draws fails", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gloom-fn-output-"));
  try {
    const cli = siwContext({ format: "csv" });
    (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
    const target = join(folder, "new folder", "siw.csv");
    const { stdout, exitCode } = await captureConsole(() => runPaneFunction(["SIW", "GME", "--output", target], cli.context));
    expect(exitCode ?? 0).toBe(0);
    expect(stdout).toBe(`Saved ${target}`);
    // Nothing is printed through the command's own result: the rows went to the file.
    expect(cli.printed).toEqual([]);
    const csv = await readFile(target, "utf8");
    expect(csv.split("\n")[0]).toContain(",");
    expect(csv).toContain("GME");
    expect(csv).not.toContain("\x1b[");

    const shot = siwContext();
    (shot.context as { plugins?: unknown }).plugins = getLoadablePlugins();
    await expect(runPaneFunction(["SIW", "GME", "--theme", "amber"], shot.context)).rejects.toThrow("--theme is an option of shot");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

/** Runs with stdout a terminal `columns` wide that takes colour, as an interactive shell has it. */
async function asTerminal<T>(columns: number, run: () => Promise<T>): Promise<T> {
  const stdout = process.stdout as { isTTY?: boolean; columns?: number };
  const saved = { isTTY: stdout.isTTY, columns: stdout.columns, noColor: process.env.NO_COLOR, term: process.env.TERM };
  stdout.isTTY = true;
  stdout.columns = columns;
  delete process.env.NO_COLOR;
  process.env.TERM = "xterm-256color";
  try {
    return await run();
  } finally {
    stdout.isTTY = saved.isTTY;
    stdout.columns = saved.columns;
    if (saved.noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = saved.noColor;
    if (saved.term === undefined) delete process.env.TERM;
    else process.env.TERM = saved.term;
  }
}

// From a terminal, `fn ... --output` wrote the colour codes and the terminal-width table the report was drawn with.
test("fn --output from a terminal writes text as a redirect gets it: no colour, every cell whole", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gloom-fn-output-"));
  try {
    const target = join(folder, "siw.txt");
    const report = async (...args: string[]) => {
      const cli = siwContext();
      (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
      await captureConsole(() => runPaneFunction(["SIW", "GME", ...args], cli.context));
      return cli.printed[0] ? serializeCliResult(cli.printed[0].result, DEFAULT_CLI_OPTIONS, cli.printed[0].options) : "";
    };
    // Drawn for a 30-column terminal: in colour, its lines wrapped to the width.
    const terminal = await asTerminal(30, () => report());
    expect(terminal).toContain("\x1b[");
    // As a redirect draws it: plain, at no width.
    setCliPlainOverride(true);
    const redirected = await report().finally(() => setCliPlainOverride(null));
    expect(redirected).not.toBe(terminal.replace(/\x1b\[[0-9;]*m/g, ""));
    // The file written from that terminal is the redirect's.
    await asTerminal(30, () => report("--output", target));
    const text = await readFile(target, "utf8");
    expect(text).not.toContain("\x1b[");
    expect(text).toBe(`${redirected}\n`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("fn --output refuses a folder, writes nothing for a report with no data and fails as --json does, and --json says what it saved", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gloom-fn-output-"));
  try {
    const run = async (format: "json" | "csv", ...args: string[]) => {
      const cli = siwContext({ format });
      (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
      const output = await captureConsole(() => runPaneFunction(["SIW", ...args], cli.context));
      return { ...output, printed: cli.printed };
    };
    await expect(run("csv", "GME", "--output", folder)).rejects.toThrow(`Cannot write ${folder}: it is a folder.`);

    // No data: the same code as plain --json gives, and no file.
    const plain = await run("json", "BTC-USD");
    const expected = (plain.printed[0]!.result as { failure: { code: string } }).failure;
    const empty = join(folder, "empty.csv");
    const failed = await run("json", "BTC-USD", "--output", empty).then(() => null, (error: unknown) => error);
    expect(isCliFailure(failed)).toBe(true);
    expect(failed).toMatchObject({ code: "no_data", message: (expected as { message: string }).message, details: `Nothing was written to ${empty}.` });
    expect(expected.code).toBe("no_data");
    await expect(readFile(empty, "utf8")).rejects.toThrow();

    // --json prints the envelope of what it saved.
    const saved = join(folder, "siw.json");
    const written = await run("json", "GME", "--output", saved);
    expect(JSON.parse(written.stdout)).toMatchObject({ ok: true, data: { output: saved, format: "json", rows: 1 } });
    expect(JSON.parse(await readFile(saved, "utf8"))).toMatchObject({ ok: true });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
