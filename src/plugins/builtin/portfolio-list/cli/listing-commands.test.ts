import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AppPersistence } from "../../../../data/app-persistence";
import { TickerRepository } from "../../../../data/ticker-repository";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { createNotFoundProvider, createTestDataProvider, createTestQuote } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import { loadConfig, saveConfig } from "../../../../data/config/store";
import { createDefaultConfig } from "../../../../types/config";
import { setCliColorEnabledOverride } from "../../../../utils/cli-output";
import type { CliCommandDef } from "../../../../types/plugin";
import type { TickerChanges } from "../../../../types/ticker-changes";
import { portfolioCliCommand } from "./portfolio-command";
import { watchlistCliCommand } from "./watchlist-command";

const persistences: AppPersistence[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  // A list that adds nothing sets the exit status; it must not become the test run's.
  process.exitCode = 0;
  setCliColorEnabledOverride(null);
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

test("watchlist and portfolio actions that change a list without a preview refuse --dry-run and write nothing", async () => {
  const run = await savedSan();
  const { context, printed } = createTestCliContext({ config: await loadConfig(run.dataDir), store: run.store }, { dryRun: true });
  const attempts: Array<[CliCommandDef, string[], string]> = [
    [watchlistCliCommand, ["remove", "growth", "SAN"], "watchlist remove has no --dry-run; it changes the watchlist when it runs."],
    [watchlistCliCommand, ["create", "Fresh"], "watchlist create has no --dry-run; it changes the watchlist when it runs."],
    [watchlistCliCommand, ["delete", "growth"], "watchlist delete has no --dry-run; it changes the watchlist when it runs."],
    [portfolioCliCommand, ["remove", "main", "SAN"], "portfolio remove has no --dry-run; it changes the portfolio when it runs."],
  ];
  for (const [command, args, message] of attempts) {
    await expect(command.execute(args, context)).rejects.toThrow(message);
  }
  expect(printed).toEqual([]);
  expect((await run.store.loadTicker("SAN"))?.metadata).toMatchObject({ watchlists: ["growth"], portfolios: ["main"] });
  expect((await loadConfig(run.dataDir)).watchlists).toEqual([{ id: "growth", name: "Growth" }]);
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

test("portfolio show, target show and watchlist show label two listings of one symbol SAN:NYSE and SAN:EPA, not by stored key", async () => {
  const run = await savedSan();
  // Both rows are held, so the table lists them under the key each is stored with: SAN and SAN:XNYS.
  for (const symbol of ["SAN", "SAN:XNYS"]) {
    const record = (await run.store.loadTicker(symbol))!;
    await run.store.saveTicker({ metadata: { ...record.metadata, positions: [{ portfolio: "main", shares: 5, avgCost: 10, currency: record.metadata.currency, broker: "manual" }] } });
  }
  const config = await loadConfig(run.dataDir);
  const market = {
    config: { ...config, portfolios: [{ ...config.portfolios[0]!, targetWeights: { SAN: 10, "SAN:XNYS": 20 } }] },
    store: run.store,
    // New York's line has no quote, so the notes under the table name it too.
    dataProvider: createTestDataProvider({ getQuote: async (symbol) => {
      if (symbol === "SAN:XNYS") throw new Error("No quote");
      return createTestQuote({ symbol, price: 12, currency: "EUR" });
    } }),
  };
  setCliColorEnabledOverride(false);
  const output = async (command: typeof portfolioCliCommand, args: string[]) => {
    const lines: string[] = [];
    const logger = spyOn(console, "log").mockImplementation((...parts) => { lines.push(parts.join(" ")); });
    try { await command.execute(args, createTestCliContext(market).context); } finally { logger.mockRestore(); }
    return lines.join("\n").split("\n");
  };
  const firstCells = (lines: string[]) => lines.filter((line) => /^SAN/.test(line)).map((line) => line.split(/\s+/)[0]);

  const shown = await output(portfolioCliCommand, ["show", "main"]);
  expect(firstCells(shown)).toEqual(["SAN:EPA", "SAN:NYSE"]);
  expect(shown).toContain("P&L unavailable for SAN:NYSE.");
  const targets = await output(portfolioCliCommand, ["target", "show", "main"]);
  expect(firstCells(targets)).toEqual(["SAN:EPA", "SAN:NYSE"]);
  expect(targets.join("\n")).toMatch(/SAN:EPA +Sanofi +10\.0%/);
  expect(targets.join("\n")).toMatch(/SAN:NYSE +Banco Santander +20\.0%/);
  expect(firstCells(await output(watchlistCliCommand, ["show", "growth"]))).toEqual(["SAN:EPA", "SAN:NYSE"]);

  // Scripts keep reading the stored key.
  const json = createTestCliContext(market, { format: "json" });
  await portfolioCliCommand.execute(["show", "main"], json.context);
  expect((json.printed[0]!.result.data as { symbol: string }[]).map((row) => row.symbol)).toEqual(["SAN", "SAN:XNYS"]);
  const targetJson = createTestCliContext(market, { format: "json" });
  await portfolioCliCommand.execute(["target", "show", "main"], targetJson.context);
  expect((targetJson.printed[0]!.result.data as { symbol: string }[]).map((row) => row.symbol)).toEqual(["SAN", "SAN:XNYS"]);
});

test("a bare coin ticker on a fund says it is not the coin on every add and position path, a named listing does not", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  await store.saveTicker(createTestTicker("ETH", "Grayscale Ethereum Mini Trust ETF", { exchange: "ARCA", assetCategory: "ETF" }));
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-coin-hints-"));
  dataDirs.push(dataDir);
  const config = { ...createDefaultConfig(dataDir), portfolios: [{ id: "family", name: "Family", currency: "USD" }], watchlists: [{ id: "growth", name: "Growth" }] };
  await saveConfig(config);
  const note = "ETH is Grayscale Ethereum Mini Trust ETF, not ethereum. For ethereum use ETH-USD.";
  const run = async (command: typeof portfolioCliCommand, args: string[]) => {
    const cli = createTestCliContext({ config: await loadConfig(dataDir), store });
    await command.execute(args, cli.context);
    return cli.printed[0]!.result;
  };

  expect((await run(portfolioCliCommand, ["add", "family", "ETH"])).warnings).toContain(note);
  expect((await run(portfolioCliCommand, ["position", "set", "FAMILY", "ETH", "10", "20"])).warnings).toContain(note);
  expect((await run(portfolioCliCommand, ["target", "set", "Family", "ETH", "5"])).warnings).toContain(note);
  expect((await run(watchlistCliCommand, ["add", "growth", "ETH"])).warnings).toContain(note);
  // A list carries it per symbol, as a field of its own.
  const rows = (await run(watchlistCliCommand, ["add", "growth", "ETH", "AAPL"])).data as Array<{ hint: string | null }>;
  expect(rows.map((row) => row.hint)).toEqual([note, null]);
  // Naming the listing asks for the fund on purpose.
  expect((await run(portfolioCliCommand, ["add", "family", "ETH:ARCA"])).warnings ?? []).not.toContain(note);
});

/** A command context whose failures carry the hint line under them, as the CLI prints it. */
function hintedContext(market: Record<string, unknown>, cliOptions: Parameters<typeof createTestCliContext>[1] = {}) {
  const cli = createTestCliContext(market, cliOptions);
  (cli.context as { fail: (message: string, details?: string) => never }).fail = (message, details) => {
    throw Object.assign(new Error(message), { details });
  };
  return cli;
}

const caught = async (result: unknown) => (await Promise.resolve(result).then(() => null, (error: unknown) => error)) as (Error & { details?: string }) | null;

test("one pasted list where the list name goes is a list of symbols, not a missing watchlist or portfolio", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  await store.saveTicker(createTestTicker("NVDA", "NVIDIA Corporation", { exchange: "NASDAQ" }));
  await store.saveTicker(createTestTicker("MSFT", "Microsoft Corporation", { exchange: "NASDAQ" }));
  const config = {
    ...createDefaultConfig("/unused"),
    portfolios: [{ id: "main", name: "Main", currency: "USD" }],
    watchlists: [{ id: "growth", name: "Growth" }, { id: "watch-two", name: "Watch Two" }],
  };
  const run = (command: CliCommandDef, args: string[]) => caught(command.execute(args, hintedContext({ config, store }).context));
  const watchlistUsage = "Usage: gloom watchlist add <watchlist> <symbols...> [--file <path>]";

  const pasted = await run(watchlistCliCommand, ["add", "  usdngn=x , USDZAR=X;  usdsar=x\n"]);
  expect(pasted?.message).toBe(
    '"usdngn=x , USDZAR=X; usdsar=x" reads as a list of symbols, not a watchlist name; did you mean `gloom watchlist add <name> <list>`; lists: Growth, Watch Two',
  );
  expect(pasted?.details).toBe(watchlistUsage);
  // Whichever separator the paste has, and for remove and portfolios too.
  for (const text of ["NVDA,MSFT", "NVDA;MSFT", "NVDA MSFT", "NVDA\nMSFT", "NVDA, "]) {
    expect((await run(watchlistCliCommand, ["add", text]))?.message).toContain("reads as a list of symbols");
  }
  expect((await run(watchlistCliCommand, ["remove", "NVDA MSFT"]))?.message).toContain("`gloom watchlist remove <name> <list>`");
  const portfolio = await run(portfolioCliCommand, ["add", "nvda, msft"]);
  expect(portfolio?.message).toBe('"nvda, msft" reads as a list of symbols, not a portfolio name; did you mean `gloom portfolio add <name> <list>`; portfolios: Main');
  expect(portfolio?.details).toBe("Usage: gloom portfolio add <portfolio> <symbols...> [--file <path>]");
  expect((await caught(watchlistCliCommand.execute(["add", "NVDA,MSFT"], hintedContext({ config: { ...config, watchlists: [] }, store }).context)))?.message)
    .toContain("no lists yet, create one with `gloom watchlist create <name>`");

  // A name that exists keeps its behaviour, with spaces or without; one that does not, with no separators or with --file, is still not found.
  expect((await run(watchlistCliCommand, ["add", "Growth"]))?.message).toBe(watchlistUsage);
  expect((await run(watchlistCliCommand, ["add", "watch two"]))?.message).toBe(watchlistUsage);
  expect((await run(watchlistCliCommand, ["add", "Groth"]))?.message).toBe('Watchlist "Groth" was not found.');
  expect((await run(watchlistCliCommand, ["add", "Groth", "NVDA"]))?.message).toBe('Watchlist "Groth" was not found.');
  expect((await run(watchlistCliCommand, ["add", "My Lisst", "--file", "holdings.csv"]))?.message).toBe('Watchlist "My Lisst" was not found.');

  // With the name first the same paste adds.
  const added = hintedContext({ config, store });
  await watchlistCliCommand.execute(["add", "Growth", "  nvda , MSFT;\n"], added.context);
  expect((added.printed[0]!.result.data as Array<{ status: string; listing: string }>).map((row) => [row.status, row.listing])).toEqual([["added", "NVDA:NASDAQ"], ["added", "MSFT:NASDAQ"]]);
});

test("a symbol search finds no listing for names the near match search lists, in a list and alone, and stays quiet otherwise", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const config = { ...createDefaultConfig("/unused"), portfolios: [], watchlists: [{ id: "growth", name: "Growth" }] };
  const naira = { providerId: "test", symbol: "USDNGN=X", name: "US Dollar/Nigerian Naira", exchange: "CCY", type: "CURRENCY" };
  const market = (search: () => Promise<typeof naira[]>) => ({ config, store, dataProvider: createNotFoundProvider({ search }) });
  const exec = async (args: string[], search: () => Promise<typeof naira[]>) => {
    const cli = hintedContext(market(search), { color: false });
    await watchlistCliCommand.execute(args, cli.context);
    const { result, options } = cli.printed[0]!;
    return { rows: result.data as Array<Record<string, unknown>>, text: options!.text!(result.data) };
  };
  const found = async () => [naira];

  const list = await exec(["add", "Growth", "USD_NGN", "XXXXX"], found);
  expect(list.text).toContain("Not found: USD_NGN; did you mean USDNGN=X (US Dollar/Nigerian Naira)?");
  expect(list.text).toContain("Not found: XXXXX");
  expect(list.text).not.toContain("XXXXX;");
  expect(list.text).toContain('Watchlist "Growth": 0 added, 2 not found: USD_NGN, XXXXX.');
  expect(list.rows.map((row) => row.suggestion)).toEqual(["USDNGN=X (US Dollar/Nigerian Naira)", undefined]);

  // One symbol typed alone fails with the same line.
  const alone = await caught(watchlistCliCommand.execute(["add", "Growth", "USD_NGN"], hintedContext(market(found)).context));
  expect(alone?.message).toBe('No ticker match found for "USD_NGN"; did you mean USDNGN=X (US Dollar/Nigerian Naira)?');

  // A search that finds nothing, or fails, leaves the plain answer.
  const refused = async (): Promise<typeof naira[]> => { throw new Error("Gloom Cloud refused the request"); };
  for (const search of [async () => [], refused]) {
    expect((await exec(["add", "Growth", "USD_NGN", "XXXXX"], search)).text).not.toContain("did you mean");
    expect((await caught(watchlistCliCommand.execute(["add", "Growth", "USD_NGN"], hintedContext(market(search)).context)))?.message)
      .toBe('No ticker match found for "USD_NGN".');
  }

  // A spelling of the pair itself is the pair, not a near miss.
  expect((await exec(["add", "Growth", "USD-NGN", "XXXXX"], found)).rows.map((row) => [row.status, row.listing]))
    .toEqual([["added", "USDNGN=X:CCY"], ["not_found", null]]);
});

test("a list file with a separator left on a symbol adds the symbol and names the separator, never asks which listing `UPST;` is", async () => {
  const persistence = new AppPersistence(":memory:");
  persistences.push(persistence);
  const store = new TickerRepository(persistence.tickers);
  const config = { ...createDefaultConfig("/unused"), watchlists: [{ id: "growth", name: "Growth" }] };
  const searched: string[] = [];
  // Several listings carry UPST, as search lists it, so a symbol that is not exactly UPST has no answer.
  const dataProvider = createTestDataProvider({
    search: async (query) => {
      searched.push(query);
      return query === "UPST"
        ? ["NASDAQ", "BMV"].map((exchange) => ({ providerId: "test", symbol: "UPST", name: "Upstart Holdings Inc.", exchange, type: "Common Stock", currency: "USD" }))
        : [];
    },
    getQuote: async (symbol) => {
      if (symbol !== "UPST") throw new Error(`Not a ticker: ${symbol}.`);
      return createTestQuote({ symbol, name: "Upstart Holdings Inc.", listingExchangeName: "NASDAQ", exchangeName: "NASDAQ" });
    },
  });
  const dataDir = await mkdtemp(join(tmpdir(), "gloomberb-stray-"));
  dataDirs.push(dataDir);
  // No delimiter on the first line, so the later cells keep their own trailing `;`.
  const file = join(dataDir, "symbols.txt");
  await Bun.write(file, "Symbol\nUPST;\n");
  const cli = createTestCliContext({ config, store, dataProvider });
  await watchlistCliCommand.execute(["add", "Growth", "--file", file], cli.context);
  const { result } = cli.printed[0]!;
  expect((result.data as Array<Record<string, unknown>>).map((row) => [row.status, row.listing])).toEqual([["added", "UPST:NASDAQ"]]);
  expect(result.warnings).toContain('Ignored the stray ";" after UPST.');
  expect(searched.filter((query) => query.includes(";"))).toEqual([]);
});

test("a list of more than ten symbols checks each one's history, and one symbol alone is decided the same: a match abroad, a dead listing or a symbol taken over lately needs a choice and saves nothing", async () => {
  const day = 24 * 60 * 60_000;
  const daysAgo = (days: number) => new Date(Date.now() - days * day).toISOString().slice(0, 10);
  const row = (symbol: string, exchange: string, name: string, currency = "USD") => ({ providerId: "test", symbol, exchange, name, currency, type: "Common Stock" });
  const banks = Array.from({ length: 10 }, (_, index) => `ZB${index}`);
  // Search finds DFS Furniture in London, Flagstar's old NYCB line, which stopped trading, a fund that took BRKL
  // from Brookline Bancorp lately, Five Star Bancorp, which took FSBC years ago, and the dollar in yen.
  const listings: Record<string, ReturnType<typeof row>> = {
    DFS: row("DFS", "LSE", "DFS Furniture plc", "GBp"),
    NYCB: row("NYCB", "NYSE", "Flagstar Financial Corporation"),
    BRKL: row("BRKL", "BATS", "Corgi Brookline ETF"),
    FSBC: row("FSBC", "NASDAQ", "Five Star Bancorp"),
    USDJPY: { ...row("USDJPY=X", "CCY", "USD/JPY", "JPY"), type: "CURRENCY" },
    ...Object.fromEntries(banks.map((symbol) => [symbol, row(symbol, "NYSE", `${symbol} Bancorp`)])),
  };
  const former = (symbol: string, name: string, until: string, successor: { symbol: string; name: string }): TickerChanges => ({
    symbol, moved: null, formerly: null, listedName: null, changes: [], formerIssuer: { symbol, name, until, successor, source: null },
  });
  const brooklineLeft = daysAgo(200);
  const changes: Record<string, TickerChanges> = {
    DFS: former("DFS", "Discover Financial Services", "2025-05-18", { symbol: "COF", name: "Capital One Financial" }),
    NYCB: { symbol: "NYCB", moved: { symbol: "FLG", name: "Flagstar Financial", hops: [{ from: "NYCB", to: "FLG", date: "2024-10-28" }] },
      formerly: null, listedName: null, changes: [{ from: "NYCB", to: "FLG", date: "2024-10-28" }] },
    BRKL: former("BRKL", "Brookline Bancorp", brooklineLeft, { symbol: "BBT", name: "Beacon Financial" }),
    FSBC: former("FSBC", "First Savings Bancorp", daysAgo(5 * 365), { symbol: "KNDR", name: "Kinder Holdings" }),
  };
  const listingOf = (symbol: string) => listings[symbol.replace(/=X$/, "")];
  const dataProvider = createTestDataProvider({
    search: async (query) => listingOf(query) ? [listingOf(query)!] : [],
    getQuote: async (symbol, exchange) => {
      const listing = listingOf(symbol);
      if (!listing || (exchange && exchange !== listing.exchange)) throw new Error(`Not a ticker: ${symbol}.`);
      const ended = symbol === "NYCB" ? { lastUpdated: Date.now() - 700 * day, stale: true } : {};
      return createTestQuote({ symbol: listing.symbol, name: listing.name, currency: listing.currency, listingExchangeName: listing.exchange, exchangeName: listing.exchange, ...ended });
    },
    getTickerChanges: async (symbol) => changes[symbol] ?? null,
  });
  const config = { ...createDefaultConfig("/unused"), watchlists: [{ id: "banks", name: "Banks" }] };
  const choices = ["DFS", "NYCB", "BRKL"];
  const add = async (symbols: string[], dryRun: boolean) => {
    const persistence = new AppPersistence(":memory:");
    persistences.push(persistence);
    const store = new TickerRepository(persistence.tickers);
    const cli = hintedContext({ config, store, dataProvider }, { color: false, dryRun });
    const error = await caught(watchlistCliCommand.execute(["add", "Banks", ...symbols], cli.context));
    const printed = cli.printed[0];
    return { error, rows: printed?.result.data as Array<Record<string, unknown>>, text: printed?.options!.text!(printed.result.data) ?? "",
      saved: (await store.loadAllTickers()).map((ticker) => ticker.metadata.ticker) };
  };

  for (const dryRun of [false, true]) {
    const { rows, text, saved } = await add([...banks, "FSBC", "USDJPY", ...choices], dryRun);
    expect(rows.slice(-5).map((entry) => [entry.status, entry.listing, entry.tradesAs ?? null])).toEqual([
      ["added", "FSBC:NASDAQ", "KNDR"],
      ["added", "USDJPY=X:CCY", null],
      ["needs_choice", "DFS:LSE", "COF"],
      ["needs_choice", "NYCB:NYSE", "FLG"],
      ["needs_choice", "BRKL:BATS", "BBT"],
    ]);
    expect(text).toContain("Needs a choice, not added (3):");
    expect(text).toContain("DFS was Discover Financial Services until 2025, now Capital One Financial: COF; DFS matched DFS:LSE (DFS Furniture plc), a listing abroad");
    expect(text).toContain(`BRKL was Brookline Bancorp until ${brooklineLeft.slice(0, 4)}, now Beacon Financial: BBT; BRKL matched BRKL:BATS (Corgi Brookline ETF), another company's listing`);
    expect(text).toContain("Add what they trade as now: gloom watchlist add Banks COF FLG BBT");
    expect(text).toContain("To keep a match instead, name its listing: gloom watchlist add Banks DFS:LSE NYCB:NYSE BRKL:BATS");
    // Five Star took FSBC years ago: added, saying who had it.
    expect(text).toContain("  FSBC was First Savings Bancorp until");
    expect(text).toContain('Watchlist "Banks": 12 added; 3 need a choice: DFS, NYCB, BRKL.');
    // No match is saved, nor, in a dry run, anything else.
    expect(saved.filter((key) => choices.some((symbol) => key.startsWith(symbol)))).toEqual([]);
    expect(saved.length).toBe(dryRun ? 0 : 12);
  }

  // One symbol alone fails with the same choice, and saves nothing.
  for (const [symbol, successor, match] of [["DFS", "COF", "DFS:LSE"], ["BRKL", "BBT", "BRKL:BATS"]] as const) {
    const { error, saved } = await add([symbol], false);
    expect(error?.message).toStartWith(`${symbol} was `);
    expect(error?.details).toBe(`Add what it trades as now: gloom watchlist add Banks ${successor}\nTo keep the match instead, name its listing: gloom watchlist add Banks ${match}`);
    expect(saved).toEqual([]);
  }
  expect((await add(["FSBC"], false)).saved).toEqual(["FSBC"]);
});
