import { afterEach, expect, spyOn, test } from "bun:test";
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
  for (const state of ["weekend", "afterHours", "preMarket"] as const) {
    const quote = sessionQuotes()[state];
    const headline = getRegularSessionDisplay(quote)!;
    const extended = getExtendedSessionDisplay(quote)!;
    const { text, rows, json } = await show(quote);
    const figures = state === "preMarket" ? /\$198\.78 +\+0\.51% +\$199\.50 \+0\.36%/ : /\$198\.78 +\+0\.51% +\$198\.80 \+0\.01%/;
    expect(text).toContain(state === "preMarket" ? "Pre-Market" : "After Hours");
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
