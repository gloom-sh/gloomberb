import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import { AppPersistence } from "../../data/app-persistence";
import { TickerRepository } from "../../data/ticker-repository";
import { getLoadablePlugins } from "../../plugins/catalog";
import { runPaneFunction, runPaneScreenshot } from "../pane-functions";
import * as paneShot from "../desktop-pane-shot";
import type { MarketContext } from "../types";
import { createDefaultConfig } from "../../types/config";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { createMovedSymbolsProvider, HFC_HOP, MOVED_SYMBOL_CHANGES as CHANGES } from "../../test-support/moved-symbols";
import { captureConsole } from "../../test-support/console";
import { createTestFinancials, createTestQuote } from "../../test-support/data-provider";
import { DEFAULT_CLI_OPTIONS } from "../options";
import { printCliError } from "../errors";
import { marketDataCliCommands } from "./market";
import { overviewCliCommands } from "./overview";
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
  let warnings: string[] = [];
  const error = await ticker(symbol, {
    initMarketData: async () => ({
      config, dataDir: "/tmp/gloom-moved-symbols-fixture", dataProvider,
      store: { loadTicker: async () => null, loadAllTickers: async () => [] }, persistence: { close: () => {} },
    }) as unknown as MarketContext,
    fail: (message) => { throw new Error(message); },
    printResult: (result) => { data = result.data; warnings = result.warnings ?? []; },
  }).then(() => null, (failure: unknown) => failure);
  return { error, data, warnings };
}

/** What `--json` prints for a failure: the same printer the CLI ends every failed command with. */
async function jsonError(error: unknown) {
  const { stderr } = await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  return JSON.parse(stderr) as { ok: boolean; error: Record<string, unknown> };
}

test("history and ticker of a symbol whose company moved serve nothing of their own and name its new symbol, in one line and in --json", async () => {
  const hfc = await runHistory(["HFC"]);
  expect((hfc.error as Error).message).toBe("HFC became DINO on 2022-03-15: `gloom history DINO`");
  expect(hfc.printed).toBeUndefined();
  expect(await jsonError(hfc.error)).toEqual({
    ok: false,
    error: {
      code: "ticker_moved",
      message: "HFC became DINO on 2022-03-15: `gloom history DINO`",
      retry: "gloom history DINO",
      tickerChange: {
        symbol: "HFC", kind: "moved", note: "HFC became DINO on 2022-03-15", changes: [HFC_HOP],
        tradesAs: "DINO", issuer: "HF Sinclair", listed: null,
      },
    },
  });
  // The range asked for carries over; SHEL's bars are not served under RDS-A's name.
  const rds = await runHistory(["RDS-A", "--range", "5Y"]);
  expect((rds.error as Error).message).toBe("RDS-A became SHEL on 2022-01-31: `gloom history SHEL --range 5Y`");
  expect(rds.printed).toBeUndefined();

  for (const [symbol, line] of [
    ["HFC", "HFC became DINO on 2022-03-15: `gloom ticker DINO`"],
    ["RDS-A", "RDS-A became SHEL on 2022-01-31: `gloom ticker SHEL`"],
  ] as const) {
    const report = await runTicker(symbol);
    expect((report.error as Error).message).toBe(line);
    expect(report.data).toBeNull();
    expect((await jsonError(report.error)).error).toMatchObject({ code: "ticker_moved", retry: line.split("`")[1] });
  }
});

test("a dated window, holders and filings of a moved symbol whose own request fails name its new symbol, never the source's dead end", async () => {
  // FI's window before the listing that reused the symbol: the dated request fails, and the whole history starts in 2026.
  const reused = source(undefined, {
    getDetailedPriceHistoryWithMetadata: async () => { throw new Error("No data for HFC from 2022-03-10 to 2022-03-18."); },
    getPriceHistoryWithMetadata: async () => ({ resolution: "1mo", points: [{ date: new Date("2026-07-01"), open: 1, high: 1, low: 1, close: 1, volume: 0 }] }),
    getHolders: async () => { throw new Error("No holders on record for HFC."); },
    getSecFilings: async () => { throw new Error("Unknown ticker HFC"); },
  });
  const window = await runHistory(["HFC", "--from", "2022-03-10", "--to", "2022-03-18", "--interval", "daily"], reused);
  expect((window.error as Error).message).toBe("HFC became DINO on 2022-03-15: `gloom history DINO --from 2022-03-10 --to 2022-03-18 --interval daily`");
  for (const [name, line] of [["holders", "`gloom holders DINO`"], ["13f", "`gloom 13f DINO`"], ["filings", "`gloom filings DINO`"]] as const) {
    const command = marketDataCliCommands.find((entry) => entry.name === name)!;
    const cli = createTestCliContext({ config, dataProvider: reused });
    const error = await command.execute(["HFC"], cli.context).then(() => null, (failure: unknown) => failure);
    expect((error as Error).message, name).toBe(`HFC became DINO on 2022-03-15: ${line}`);
  }
});

test("a read of a symbol that trades costs no change lookup and no second quote; one whose line stopped still names the new symbol", async () => {
  const counted = () => {
    const counts = { quote: 0, changes: 0 };
    const provider = source(async (symbol) => { counts.changes++; return CHANGES[symbol] ?? null; }, {
      // The shipped listings know both as US stocks, as the command line's provider says.
      knownUsStock: (symbol) => symbol === "AAPL" || symbol === "META",
      getHolders: async (symbol) => ({ symbol, holders: [{ name: "Vanguard Group", shares: 1, value: 1, percentHeld: 0.1, reportDate: "2026-09-30", ownerType: "institution" }] }) as never,
      getSecFilings: async () => [{ form: "10-Q", filingDate: "2026-10-30", accessionNumber: "0000320193-26-000001", filingUrl: "https://www.sec.gov/x" }] as never,
    });
    const quote = provider.getQuote.bind(provider);
    provider.getQuote = async (...args) => { counts.quote++; return quote(...args); };
    return { counts, provider };
  };
  const commands = [...marketDataCliCommands, ...overviewCliCommands];
  // Each reads AAPL's quote once for itself (correlation each symbol's), as before: the quote says the line trades.
  for (const [name, args, quotes] of [["holders", ["AAPL"], 1], ["13f", ["AAPL"], 1], ["filings", ["AAPL"], 1], ["correlation", ["AAPL", "META"], 2]] as const) {
    const { counts, provider } = counted();
    const cli = createTestCliContext({ config, dataProvider: provider });
    await commands.find((command) => command.name === name)!.execute([...args], cli.context);
    expect(cli.printed, name).toHaveLength(1);
    expect(counts, name).toEqual({ quote: quotes, changes: 0 });
  }
  // HFC's holders come back, but its quote stopped in 2022: its change is looked up and named.
  const { provider } = counted();
  const cli = createTestCliContext({ config, dataProvider: provider });
  const error = await marketDataCliCommands.find((command) => command.name === "holders")!.execute(["HFC"], cli.context).then(() => null, (failure: unknown) => failure);
  expect((error as Error).message).toBe("HFC became DINO on 2022-03-15: `gloom holders DINO`");
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
    "HFC became DINO on 2022-03-15: `gloom quote DINO`",
    "RDS-A became SHEL on 2022-01-31: `gloom quote SHEL`",
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
  // Its served bar leads; a quote that says the session trades adds the day's bar after it, as for any daily history.
  expect((meta.printed!.result.data as Array<{ close: number }>)[0]!.close).toBe(736.72);
  expect(meta.printed!.result.warnings).toContain("Asked 1Y, data starts 2026-10-14 (first available bar)");
  expect(meta.printed!.result.warnings!.join(" ")).not.toMatch(/became|no longer trading/);
  expect((await runTicker("AAPL")).error).toBeNull();
  // A change lookup that fails is no note and no failure: the bars are served.
  const offline = await runHistory(["HFC"], source(async () => { throw new Error("fetch failed"); }));
  expect(offline.error).toBeNull();
  expect(offline.printed!.result.data).toHaveLength(1);
});

test("a stopped line waits for a slow change lookup before serving, while a symbol that trades never waits on one", async () => {
  // Bars answer at once (a cached history); the change answers 500 ms later, past the short grace.
  const slow = source((symbol) => Bun.sleep(500).then(() => CHANGES[symbol] ?? null));
  expect(((await runHistory(["HFC"], slow)).error as Error).message).toBe("HFC became DINO on 2022-03-15: `gloom history DINO`");
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
const GOGL_FUND = createTestQuote({ symbol: "GOGL", name: "Corgi GOOGL 2x Daily ETF", price: 15.19, listingExchangeName: "BATS", exchangeName: "BATS" });
const GOGL_BAR = { date: new Date("2026-10-14"), open: 15, high: 15, low: 15, close: 15, volume: 0 };

/** GOGL: Golden Ocean merged into CMB.Tech in 2025 and a fund lists there now; the change answers after the data, past the short grace. */
const mergedAway = () => source((symbol) => Bun.sleep(300).then(() => symbol === "GOGL" ? {
  symbol, moved: null, formerly: null, listedName: null, changes: [],
  formerIssuer: { symbol, name: "Golden Ocean Group Ltd", until: "2025-08-20", successor: { symbol: "CMBT", name: "Cmb.Tech NV" } },
} : null), {
  getQuote: async () => GOGL_FUND,
  getQuotesBatch: async (targets) => targets.map((target) => ({ target, quote: GOGL_FUND })),
  getTickerFinancials: async () => createTestFinancials({ quote: GOGL_FUND }),
  getPriceHistory: async () => [GOGL_BAR],
  getPriceHistoryWithMetadata: async () => ({ resolution: "1d", points: [GOGL_BAR] }),
});

test("history, ticker, fn and fn G of a symbol whose company merged away say what became of it, as quote does", async () => {
  const line = "GOGL was Golden Ocean Group until 2025, now Cmb.Tech: CMBT";
  expect((await runHistory(["GOGL"], mergedAway())).printed!.result.warnings).toContain(line);
  expect((await runTicker("GOGL", mergedAway())).warnings).toContain(line);
  for (const fn of ["GIP", "G"]) expect((await runFn([fn, "GOGL"], mergedAway())).printed!.result.warnings, fn).toContain(line);
});

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

async function runFn(args: string[], dataProvider = source(), command = runPaneFunction) {
  const persistence = new AppPersistence(":memory:");
  const iv = spyOn(apiClient, "impliedVolatility").mockImplementation(async (path: string) => impliedVolatility(path) as never);
  const cli = createTestCliContext({ config, dataProvider, persistence, store: new TickerRepository(persistence.tickers) });
  (cli.context as { plugins?: unknown }).plugins = getLoadablePlugins();
  try {
    const { result: error } = await captureConsole(() => command(args, cli.context).then(() => null, (failure: unknown) => failure));
    return { error, printed: cli.printed[0] as PrintedCliResult | undefined };
  } finally {
    iv.mockRestore();
    persistence.close();
  }
}

test("fn HIVG and fn VCA of a moved symbol serve nothing and name the new symbol with the same function; META's are served", async () => {
  for (const [args, line] of [
    [["HIVG", "HFC"], "HFC became DINO on 2022-03-15: `gloom fn HIVG DINO`"],
    [["HIVG", "RDS-A"], "RDS-A became SHEL on 2022-01-31: `gloom fn HIVG SHEL`"],
    [["VCA", "HFC"], "HFC became DINO on 2022-03-15: `gloom fn VCA DINO`"],
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

test("fn of a function that reads a company by symbol reads a moved one as its new symbol; a refusal names the code typed", async () => {
  const dino = createTestQuote({ symbol: "DINO", name: "HF Sinclair Corp", price: 52.1, listingExchangeName: "NYSE", exchangeName: "NYSE", marketState: "REGULAR" });
  const provider = source(undefined, { getQuote: async (symbol) => symbol === "DINO" ? dino : (await source().getQuote(symbol))! });
  // The quote board asks for DINO and says why; HFC's 2022 line is never its row.
  const board = await runFn(["QQ", "HFC"], provider);
  expect(board.error).toBeNull();
  expect(board.printed!.result.warnings).toContain("HFC became DINO on 2022-03-15; showing DINO.");
  expect(JSON.stringify(board.printed!.result.data)).toContain("DINO");
  expect(JSON.stringify(board.printed!.result.data)).not.toContain("36.39");
  // A pane that shows one ticker refuses it, with the code as typed: DES is Ticker Research's alias of T.
  const render = spyOn(paneShot, "renderDesktopPaneScreenshot").mockRejectedValue(new Error("Listing unavailable"));
  try {
    for (const code of ["DES", "T"]) {
      const { error } = await runFn([code, "HFC"]);
      expect((error as Error).message, code).toBe(`HFC became DINO on 2022-03-15: \`gloom fn ${code} DINO\``);
    }
  } finally {
    render.mockRestore();
  }
});

test("fn given a company's name where its ticker goes answers as quote does: not a ticker, and the search that finds it", async () => {
  for (const code of ["RDCF", "HIVG"]) {
    const { error, printed } = await runFn([code, "Palantir"]);
    expect(printed).toBeUndefined();
    expect((error as Error).message).toBe("Not a ticker: PALANTIR.");
    // The same hint `quote` adds, from what the reader typed.
    const { stderr } = await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, color: false }, { command: "fn", args: [code, "Palantir"] }));
    expect(stderr).toBe("error: Not a ticker: PALANTIR. Try `gloom search Palantir`.");
  }
  // A ticker the function has data for is served as before.
  expect((await runFn(["HIVG", "META"])).error).toBeNull();
});

test("shot rejects a company's name before starting a renderer, including charts that retain failed series", async () => {
  const render = spyOn(paneShot, "renderDesktopPaneScreenshot").mockImplementation(async () => {
    throw new Error("Capture renderer reached");
  });
  const provider = source(undefined, {
    getPriceHistoryWithMetadata: async (symbol) => {
      if (symbol === "PALANTIR") throw new Error("Not a ticker: PALANTIR.");
      return { resolution: "1d", points: [{ date: new Date("2026-10-14"), close: 736.72 }] };
    },
  });
  try {
    for (const code of ["G", "RDCF", "HIVG"]) {
      const { error, printed } = await runFn([code, "palantir"], provider, runPaneScreenshot);
      expect(printed).toBeUndefined();
      expect((error as Error).message).toBe("Not a ticker: PALANTIR.");
      const { stderr } = await captureConsole(() => printCliError(error, { ...DEFAULT_CLI_OPTIONS, color: false }, { command: "shot", args: [code, "palantir"] }));
      expect(stderr).toBe("error: Not a ticker: PALANTIR. Try `gloom search palantir`.");
    }
    expect(render).not.toHaveBeenCalled();
    // A known ticker and a source outage still take the capture path.
    for (const dataProvider of [provider, source(undefined, {
      getTickerFinancials: async () => { throw new Error("Source unavailable"); },
      getPriceHistoryWithMetadata: async () => { throw new Error("Source unavailable"); },
    })]) {
      expect(((await runFn(["G", "META"], dataProvider, runPaneScreenshot)).error as Error).message).toBe("Capture renderer reached");
    }
    expect(render).toHaveBeenCalledTimes(2);
  } finally {
    render.mockRestore();
  }
});
