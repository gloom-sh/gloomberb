import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { serializeCliResult } from "../../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../../cli/options";
import { renderHeadlessPaneText } from "../../../../cli/pane-functions/headless";
import { getExtendedSessionDisplay, getRegularSessionDisplay } from "../../../../market-data/market/status";
import { createDefaultConfig } from "../../../../types/config";
import type { HeadlessPaneContext } from "../../../../types/headless";
import type { Quote } from "../../../../types/financials";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import { sessionQuotes } from "../../../../test-support/test-fixture-session-quotes";
import { setCliColorEnabledOverride } from "../../../../utils/cli-output";
import { collectionHoldingsHeadless } from "../headless";
import { showCollection } from "./render";
import { portfolioCliCommand } from "./portfolio-command";

afterEach(() => setCliColorEnabledOverride(null));

const config = {
  ...createDefaultConfig("/unused-collection-sessions"),
  portfolios: [{ id: "main", name: "Main", currency: "USD" }],
  watchlists: [{ id: "tech", name: "Tech" }],
};
const held = createTestTicker("XLK", "Technology Select Sector SPDR", {
  exchange: "ARCA", portfolios: ["main"], watchlists: ["tech"],
  positions: [{ portfolio: "main", shares: 10, avgCost: 150, currency: "USD", broker: "manual" }],
});

/** `portfolio show Main` and `watchlist show Tech` with XLK quoted as `quote`: the text, and the portfolio's JSON row. */
async function show(quote: Quote) {
  const market = { config, store: { loadAllTickers: async () => [held] }, dataProvider: createTestDataProvider({ getQuote: async () => quote }) };
  setCliColorEnabledOverride(false);
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try {
    await showCollection("Main", createTestCliContext(market).context);
    await showCollection("Tech", createTestCliContext(market).context);
  } finally { logger.mockRestore(); }
  const cli = createTestCliContext(market, { format: "json" });
  await showCollection("Main", cli.context);
  const json = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  const text = output.join("\n");
  return { text, rows: text.split("\n").filter((line) => line.startsWith("XLK")), json: json.data[0] };
}

test("portfolio and watchlist show headline the regular close beside the extended print, and value at the live price", async () => {
  for (const state of ["weekend", "afterHours", "preMarket", "overnight"] as const) {
    const quote = sessionQuotes()[state];
    const headline = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote)!;
    const { text, rows, json } = await show(quote);
    const figures = {
      weekend: /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/,
      afterHours: /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/,
      preMarket: /\$198\.78 +\+0\.51% +\$199\.50 \+0\.36%/,
      overnight: /\$198\.78 +\+0\.51% +\$198\.95 \+0\.09%/,
    }[state];
    expect(text).toContain({ weekend: "After Hours", afterHours: "After Hours", preMarket: "Pre-Market", overnight: "Overnight" }[state]);
    // The portfolio's row, then the watchlist's.
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row).toMatch(figures);
    expect(json).toMatchObject({ quotePrice: headline.price, extendedSession: extended.session, extendedPrice: extended.price,
      extendedChange: extended.change, extendedChangePercent: extended.changePercent });
    // The position is still worth its shares at the live print.
    expect(json.marketValue).toBeCloseTo(10 * extended.price, 8);
  }

  const open = await show(sessionQuotes().regular);
  expect(open.text).not.toMatch(/After Hours|Pre-Market/);
  for (const row of open.rows) expect(row).toMatch(/\$199\.10 +\+0\.67%/);
  expect(open.json).toMatchObject({ quotePrice: 199.1, extendedSession: null, extendedPrice: null, marketValue: 1991 });
});

test("PF reports a portfolio's and a watchlist's rows the same way", async () => {
  const { weekend } = sessionQuotes();
  const ctx = {
    config, signal: new AbortController().signal,
    marketData: createTestDataProvider({ getQuote: async () => weekend }),
    resolvePortfolio: async () => ({ portfolio: config.portfolios[0], tickers: [held] }),
    resolveWatchlist: async () => [held],
  } as unknown as HeadlessPaneContext;
  setCliColorEnabledOverride(false);
  for (const name of ["Main", "Tech"]) {
    const args = { rawArgument: name, argument: name, symbols: [], options: {} };
    const result = await collectionHoldingsHeadless.load(args, ctx);
    expect(result.rows[0]).toMatchObject({ symbol: "XLK", price: 198.78, changePercent: 0.5056, extendedSession: "POST", extendedPrice: 198.8 });
    const text = renderHeadlessPaneText(collectionHoldingsHeadless, result, args, "PF");
    expect(text).toContain("After Hours");
    expect(text.split("\n").find((line) => line.startsWith("XLK"))).toMatch(/198\.78 .*\+0\.51% +198\.80 \+0\.01%/);
  }
});

describe("what a portfolio is priced at and when each row's price is from", () => {
  // Over the weekend: XLK's last after-hours print beside Friday's close, and a listing with no extended hours.
  const xlk = createTestTicker("XLK", "Technology Select Sector SPDR", {
    exchange: "ARCA", portfolios: ["main"],
    positions: [{ portfolio: "main", shares: 1000, avgCost: 150, currency: "USD", broker: "manual" }],
  });
  const sap = createTestTicker("SAP", "SAP SE", {
    exchange: "XETRA", portfolios: ["main"],
    positions: [{ portfolio: "main", shares: 50, avgCost: 180, currency: "USD", broker: "manual" }],
  });
  const quotes: Record<string, Quote> = {
    XLK: sessionQuotes().weekend,
    SAP: { symbol: "SAP", currency: "USD", price: 200, change: 4, changePercent: 2.0408, previousClose: 196,
      listingExchangeName: "XETRA", marketState: "CLOSED", lastUpdated: Date.parse("2026-10-09T15:38:00Z") },
  };
  const market = { config, store: { loadAllTickers: async () => [xlk, sap] },
    dataProvider: createTestDataProvider({ getQuote: async (symbol) => quotes[symbol]! }) };
  const day = (time: string) => new RegExp(`Fri 9 Oct (2026 )?${time}`);

  async function showText(args: string[]) {
    setCliColorEnabledOverride(false);
    const output: string[] = [];
    const logger = spyOn(console, "log").mockImplementation((...line) => { output.push(line.join(" ")); });
    try { await portfolioCliCommand.execute(args, createTestCliContext(market).context); } finally { logger.mockRestore(); }
    return output.join("\n");
  }
  async function showExport(args: string[], format: "json" | "csv") {
    const cli = createTestCliContext(market, { format });
    await portfolioCliCommand.execute(args, cli.context);
    return serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format }, cli.printed[0]!.options);
  }

  test("by default the value is the latest print, said under the title, with each row's print time", async () => {
    const text = await showText(["show", "Main"]);
    expect(text).toContain("Priced at the latest print, extended hours included");
    expect(text).toContain("As of (UTC)");
    expect(text).not.toContain("Day's move");
    expect(text.split("\n").find((line) => line.startsWith("XLK"))).toMatch(new RegExp(`\\$198,800 .*${day("23:58").source}`));
    expect(text.split("\n").find((line) => line.startsWith("SAP"))).toMatch(day("15:38"));

    const json = JSON.parse(await showExport(["show", "Main"], "json"));
    expect(json.metadata.valuationBasis).toBe("latest-print");
    expect(json.data[1]).toMatchObject({ symbol: "XLK", quotePrice: 198.78, marketValue: 198_800, priceBasis: null,
      valuationBasis: "latest-print", valuationPrice: 198.8, valuationAsOf: "2026-10-09T23:58:08.000Z", quoteAsOf: Date.parse("2026-10-09T23:58:08Z") });
  });

  test("--close values every row at Last times its shares, totals them, and says the day's move and the close time", async () => {
    const text = await showText(["show", "Main", "--close"]);
    expect(text).toContain("Priced at the regular close");
    // ARCA closes at 16:00 New York time.
    expect(text.split("\n").find((line) => line.startsWith("XLK"))).toMatch(new RegExp(`\\$198\\.78 .*\\$198,780 .*${day("20:00").source}`));
    expect(text).toMatch(/TOTAL .*\$208,780/);
    // XLK +1.00 a share, SAP +4.00, from 197.78 and 196.
    expect(text).toContain("Day's move: +$1,200.00 (+0.58%)");

    const json = JSON.parse(await showExport(["show", "Main", "--close"], "json"));
    for (const row of json.data) expect(row.marketValue).toBe(row.quotePrice * row.shares);
    expect(json.data.map((row: { valuationAsOf: string }) => row.valuationAsOf)).toEqual(["2026-10-09T15:38:00.000Z", "2026-10-09T20:00:00.000Z"]);
    expect(json.metadata).toMatchObject({ valuationBasis: "regular-close", total: 208_780, dayChange: 1200 });
    expect(json.metadata.dayChangePercent).toBeCloseTo(1200 / 207_580 * 100, 8);
    // Exports are dated by the close, name the basis, and cite the oldest price too.
    expect(json.source).toMatchObject({ observationDate: "2026-10-09T20:00:00.000Z", oldestObservationDate: "2026-10-09T15:38:00.000Z" });

    const csv = await showExport(["show", "Main", "--close"], "csv");
    const [header, ...lines] = csv.split("\n");
    expect(header!.split(",").slice(-3)).toEqual(["valuationBasis", "valuationPrice", "valuationAsOf"]);
    expect(lines.find((line) => line.startsWith("XLK"))).toMatch(/,regular-close,198\.78,2026-10-09T20:00:00\.000Z$/);
    expect(csv).toMatch(/# Source: .* · priced at the regular close\n/);
    expect(csv).toContain("# Observation date: 2026-10-09T20:00:00.000Z\n# Oldest observation: 2026-10-09T15:38:00.000Z\n");

    await expect(portfolioCliCommand.execute(["show", "Tech", "--close"], createTestCliContext(market).context)).rejects.toThrow("is a watchlist");
  });

  test("PF --close reports the same values, each row's close time and the basis in its closing line", async () => {
    const ctx = {
      config, signal: new AbortController().signal, marketData: market.dataProvider,
      resolvePortfolio: async () => ({ portfolio: config.portfolios[0], tickers: [xlk, sap] }),
    } as unknown as HeadlessPaneContext;
    setCliColorEnabledOverride(false);
    const args = { rawArgument: "Main", argument: "Main", symbols: [], options: { close: true } };
    const result = await collectionHoldingsHeadless.load(args, ctx);
    expect(result.rows[0]).toMatchObject({ symbol: "XLK", price: 198.78, marketValue: 198_780, valuationAsOf: "2026-10-09T20:00:00.000Z" });
    const text = renderHeadlessPaneText(collectionHoldingsHeadless, result, args, "PF");
    expect(text).toContain("Day's move: +$1,200.00 (+0.58%)");
    expect(text.split("\n").find((line) => line.startsWith("XLK"))).toMatch(day("20:00"));
    expect(text).toMatch(/priced at the regular close$/);
  });
});
