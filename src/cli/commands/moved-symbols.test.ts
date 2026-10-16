import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { getLoadablePlugins } from "../../plugins/catalog";
import { runPaneFunction } from "../pane-functions";
import type { MarketContext } from "../types";
import { createDefaultConfig } from "../../types/config";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createMovedSymbolsProvider, HFC_HOP, MOVED_SYMBOL_CHANGES as CHANGES } from "../../test-support/moved-symbols";
import { captureConsole } from "../../test-support/console";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { printCliError } from "../errors";
import { marketDataCliCommands } from "./market";
import { ticker } from "./ticker";

const history = marketDataCliCommands.find((command) => command.name === "history")!;
const quote = marketDataCliCommands.find((command) => command.name === "quote")!;
const config = createDefaultConfig("/tmp/gloom-moved-symbols-fixture");

afterEach(() => { process.exitCode = 0; });

const source = createMovedSymbolsProvider;

async function runHistory(args: string[], dataProvider = source()) {
  const cli = createTestCliContext({ config, dataProvider });
  const error = await history.execute(args, cli.context).then(() => null, (failure: unknown) => failure);
  return { error, printed: cli.printed[0] as PrintedCliResult | undefined };
}

async function runTicker(symbol: string, dataProvider = source()) {
  let data: unknown = null;
  const error = await ticker(symbol, {
    initMarketData: async () => ({
      config, dataDir: "/tmp/gloom-moved-symbols-fixture", dataProvider,
      store: { loadTicker: async () => null, loadAllTickers: async () => [] }, persistence: { close: () => {} },
    }) as unknown as MarketContext,
    fail: (message) => { throw new Error(message); },
    printResult: (result) => { data = result.data; },
  }).then(() => null, (failure: unknown) => failure);
  return { error, data };
}

/** What `--json` prints for a failure: the same printer the CLI ends every failed command with. */
async function jsonError(error: unknown) {
  const { stderr } = await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  return JSON.parse(stderr) as { ok: boolean; error: Record<string, unknown> };
}

test("history and ticker of a symbol whose company moved serve nothing of their own and name its new symbol, in one line and in --json", async () => {
  const hfc = await runHistory(["HFC"]);
  expect((hfc.error as Error).message).toBe("HFC became DINO on 2022-03-15: `gloomberb history DINO`");
  expect(hfc.printed).toBeUndefined();
  expect(await jsonError(hfc.error)).toEqual({
    ok: false,
    error: {
      code: "ticker_moved",
      message: "HFC became DINO on 2022-03-15: `gloomberb history DINO`",
      retry: "gloomberb history DINO",
      tickerChange: {
        symbol: "HFC", kind: "moved", note: "HFC became DINO on 2022-03-15", changes: [HFC_HOP],
        tradesAs: "DINO", issuer: "HF Sinclair", listed: null,
      },
    },
  });
  // The range asked for carries over; SHEL's bars are not served under RDS-A's name.
  const rds = await runHistory(["RDS-A", "--range", "5Y"]);
  expect((rds.error as Error).message).toBe("RDS-A became SHEL on 2022-01-31: `gloomberb history SHEL --range 5Y`");
  expect(rds.printed).toBeUndefined();

  for (const [symbol, line] of [
    ["HFC", "HFC became DINO on 2022-03-15: `gloomberb ticker DINO`"],
    ["RDS-A", "RDS-A became SHEL on 2022-01-31: `gloomberb ticker SHEL`"],
  ] as const) {
    const report = await runTicker(symbol);
    expect((report.error as Error).message).toBe(line);
    expect(report.data).toBeNull();
    expect((await jsonError(report.error)).error).toMatchObject({ code: "ticker_moved", retry: line.split("`")[1] });
  }
});

async function runQuote(symbols: string[]) {
  const cli = createTestCliContext({ config, dataProvider: source() });
  await quote.execute(symbols, cli.context);
  const [{ result, options }] = cli.printed as [PrintedCliResult];
  return { result, rows: options!.rows!(result.data) as Array<{ symbol: string; session: string; price: string }> };
}

test("quote of a moved symbol names its new symbol beside the old line's last price and reads STALE; META and AAPL are served as before", async () => {
  const moved = await runQuote(["HFC", "RDS-A"]);
  expect(moved.result.warnings).toEqual([
    "HFC became DINO on 2022-03-15: `gloomberb quote DINO`",
    "RDS-A became SHEL on 2022-01-31: `gloomberb quote SHEL`",
    "HFC: no longer trading since 2022-03-14 (last price $36.39)",
    "RDS-A (Shell Plc Sponsored American Depositary Receipt): no longer trading since 2022-01-28 (last price $51.04)",
  ]);
  expect(moved.rows.map(({ symbol, session, price }) => [symbol, session, price])).toEqual([["HFC", "STALE", "$36.39"], ["RDS-A", "STALE", "$51.04"]]);
  // A dead line's market is not where its price is: the closing line says nothing of the session beside it.
  expect(moved.result.freshness?.market).toBeUndefined();
  const current = await runQuote(["META", "AAPL"]);
  expect(current.result.warnings).toBeUndefined();
  expect(current.rows.map(({ symbol, session }) => [symbol, session])).toEqual([["META", "OPEN"], ["AAPL", "OPEN"]]);

  // META (a new company holds it) and AAPL (no change) serve their own bars and report, with nothing extra.
  const meta = await runHistory(["META"]);
  expect(meta.error).toBeNull();
  expect((meta.printed!.result.data as Array<{ close: number }>).map((row) => row.close)).toEqual([736.72]);
  expect(meta.printed!.result.warnings).toEqual(["Asked 1Y, data starts 2026-10-14 (first available bar)"]);
  expect((await runTicker("AAPL")).error).toBeNull();
  // A change lookup that fails is no note and no failure: the bars are served.
  const offline = await runHistory(["HFC"], source(async () => { throw new Error("fetch failed"); }));
  expect(offline.error).toBeNull();
  expect(offline.printed!.result.data).toHaveLength(1);
});

test("a stopped line waits for a slow change lookup before serving, while a symbol that trades never waits on one", async () => {
  // Bars answer at once (a cached history); the change answers 500 ms later, past the short grace.
  const slow = source((symbol) => Bun.sleep(500).then(() => CHANGES[symbol] ?? null));
  expect(((await runHistory(["HFC"], slow)).error as Error).message).toBe("HFC became DINO on 2022-03-15: `gloomberb history DINO`");
  // A lookup that hangs: META's bars come back without waiting for it.
  const hung = source((_symbol, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const started = performance.now();
  const meta = await runHistory(["META"], hung);
  expect(meta.error).toBeNull();
  expect(performance.now() - started).toBeLessThan(1_500);
});

/** Gloom Cloud's stored IV: a reading for META, none yet for anything else. */
function impliedVolatility(path: string) {
  const symbol = new URLSearchParams(path.split("?")[1]).get("symbol") ?? "";
  const symbols = new URLSearchParams(path.split("?")[1]).get("symbols")?.split(",") ?? [];
  const latest = (date: string) => ({
    date, method: "quote-mid", capturedAt: `${date}T19:55:00Z`, spot: 736.72, iv7: null, iv30: 0.43, iv60: null, iv90: 0.38, iv180: null, iv365: null,
  });
  if (path.startsWith("history")) {
    return { version: 1, symbol, asOf: "2026-10-15", status: "ready", coverage: null, stats: { iv30: null, iv90: null }, latest: null, series: [], warnings: [] };
  }
  return { version: 1, asOf: "2026-10-15", rows: symbols.map((entry) => ({
    symbol: entry, status: "ready", iv30: null, iv90: null, skew: null, latest: entry === "META" ? latest("2026-10-15") : null,
  })) };
}

async function runFn(args: string[], dataProvider = source()) {
  const persistence = new AppPersistence(":memory:");
  const iv = spyOn(apiClient, "impliedVolatility").mockImplementation(async (path: string) => impliedVolatility(path) as never);
  const cli = createTestCliContext({ config, dataProvider, persistence, store: new TickerRepository(persistence.tickers) });
  (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
  try {
    const { result: error } = await captureConsole(() => runPaneFunction(args, cli.context).then(() => null, (failure: unknown) => failure));
    return { error, printed: cli.printed[0] as PrintedCliResult | undefined };
  } finally {
    iv.mockRestore();
    persistence.close();
  }
}

test("fn HIVG and fn VCA of a moved symbol serve nothing and name the new symbol with the same function; META's are served", async () => {
  for (const [args, line] of [
    [["HIVG", "HFC"], "HFC became DINO on 2022-03-15: `gloomberb fn HIVG DINO`"],
    [["HIVG", "RDS-A"], "RDS-A became SHEL on 2022-01-31: `gloomberb fn HIVG SHEL`"],
    [["VCA", "HFC"], "HFC became DINO on 2022-03-15: `gloomberb fn VCA DINO`"],
  ] as const) {
    const { error, printed } = await runFn([...args]);
    expect((error as Error).message).toBe(line);
    expect(printed).toBeUndefined();
    const { stderr } = await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, color: false }));
    expect(stderr).toBe(`error: ${line}`);
    expect(await jsonError(error)).toEqual({
      ok: false,
      error: { code: "ticker_moved", message: line, retry: line.split("`")[1], tickerChange: expect.objectContaining({ kind: "moved" }) },
    });
  }
  expect(((await jsonError((await runFn(["HIVG", "HFC"])).error)).error.tickerChange)).toEqual({
    symbol: "HFC", kind: "moved", note: "HFC became DINO on 2022-03-15", changes: [HFC_HOP], tradesAs: "DINO", issuer: "HF Sinclair", listed: null,
  });
  for (const fn of ["HIVG", "VCA"]) {
    const meta = await runFn([fn, "META"]);
    expect(meta.error).toBeNull();
    expect(meta.printed!.result.data).toMatchObject({ target: fn, symbols: ["META"] });
  }
  // In a list, a moved symbol is a row with no figures of its own beside the others'.
  // Forty sessions of bars for every symbol, HFC's included: enough for an HV20.
  const bars = Array.from({ length: 40 }, (_, day) => {
    const close = 700 + (day % 3) * 9;
    return { date: new Date(Date.UTC(2026, 7, 1 + day)), open: close, high: close, low: close, close, volume: 0 };
  });
  const list = await runFn(["VCA", "HFC,META"], source(undefined, {
    getPriceHistory: async () => bars,
    getPriceHistoryWithMetadata: async () => ({ resolution: "1d", points: bars }),
  }));
  expect(list.error).toBeNull();
  const rows = (list.printed!.result.data as { sections: Array<{ rows: Array<{ symbol: string; hv: number | null; note?: string }> }> }).sections[0]!.rows;
  expect(rows.map(({ symbol, hv, note }) => [symbol, hv, note ?? null])).toEqual([
    ["HFC", null, "HFC became DINO on 2022-03-15"],
    ["META", expect.any(Number), null],
  ]);
});

test("fn given a company's name where its ticker goes answers as quote does: not a ticker, and the search that finds it", async () => {
  for (const code of ["RDCF", "HIVG"]) {
    const { error, printed } = await runFn([code, "Palantir"]);
    expect(printed).toBeUndefined();
    expect((error as Error).message).toBe("Not a ticker: PALANTIR.");
    // The same hint `quote` adds, from what the reader typed.
    const { stderr } = await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, color: false }, { command: "fn", args: [code, "Palantir"] }));
    expect(stderr).toBe("error: Not a ticker: PALANTIR. Try `gloomberb search Palantir`.");
  }
  // A ticker the function has data for is served as before.
  expect((await runFn(["HIVG", "META"])).error).toBeNull();
});
