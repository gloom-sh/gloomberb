import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../../api-client";
import { DEFAULT_CLI_OPTIONS } from "../../../../cli/options";
import { serializeCliResult } from "../../../../cli/result";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { createTestDataProvider, createTestQuote } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import { createDefaultConfig } from "../../../../types/config";
import type { Quote } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import { setCliColorEnabledOverride } from "../../../../utils/cli-output";
import { perpBoard, venueRow } from "../../perps/test-fixture";
import { showCollection } from "./render";

afterEach(() => setCliColorEnabledOverride(null));

const config = { ...createDefaultConfig("/unused-watchlist-show"), watchlists: [{ id: "mix", name: "Mix" }] };
const watched = (symbol: string, exchange: string, assetCategory: string, extra: Partial<TickerRecord["metadata"]> = {}) =>
  createTestTicker(symbol, symbol, { exchange, assetCategory, watchlists: ["mix"], ...extra });

const stock = watched("XOM", "NYSE", "STK");
// Saved from search as Gloom Cloud serves them: the option under its OCC code with that code for its name.
const option = watched("AAPL261218C00300000", "OPR", "OPTION");
// A crypto-venue Brent price: its quote carries a market cap of 0.
const brentPrice = watched("BZ-USD", "CCC", "CRYPTOCURRENCY", { name: "Brent Oil (Derivatives) USD" });
const perpetual = watched("BZUSDT", "BINANCE", "PERP", { name: "BZ perpetual", currency: "USDT" });
const halted = watched("SIVB", "NASDAQ", "STK");

const quotes: Record<string, Quote> = {
  XOM: createTestQuote({ symbol: "XOM", price: 120, change: 1.2, changePercent: 1, marketCap: 500e9 }),
  AAPL261218C00300000: createTestQuote({ symbol: "AAPL261218C00300000", price: 41.27, change: -4.9, changePercent: -10.6, name: "AAPL261218C00300000", instrumentType: "OPTION" }),
  "BZ-USD": createTestQuote({ symbol: "BZ-USD", price: 101.85, change: 0.37, changePercent: 0.36, marketCap: 0, instrumentType: "CRYPTOCURRENCY" }),
  BZUSDT: createTestQuote({ symbol: "BZUSDT", price: 101.48, currency: "USDT", change: -1, changePercent: -0.98, instrumentType: "PERP", listingExchangeName: "BINANCE" }),
  // Its last trade was on the 9th; the source last refreshed the quote a day later.
  SIVB: createTestQuote({ symbol: "SIVB", price: 106.04, stale: true, listingExchangeName: "NASDAQ",
    lastTradeTime: Date.parse("2023-03-09T20:00:00Z"), lastUpdated: Date.parse("2023-03-10T14:00:00Z") }),
};

/** `watchlist show Mix` over these rows: its text, and its JSON rows. */
async function show(tickers: TickerRecord[]) {
  const market = { config, store: { loadAllTickers: async () => tickers },
    dataProvider: createTestDataProvider({ getQuote: async (symbol) => quotes[symbol]! }) };
  setCliColorEnabledOverride(false);
  const output: string[] = [];
  const logger = spyOn(console, "log").mockImplementation((...args) => { output.push(args.join(" ")); });
  try { await showCollection("Mix", createTestCliContext(market).context); } finally { logger.mockRestore(); }
  const cli = createTestCliContext(market, { format: "json" });
  await showCollection("Mix", cli.context);
  const json = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  const text = output.join("\n");
  return { text, line: (symbol: string) => text.split("\n").find((row) => row.startsWith(symbol)) ?? "", rows: json.data as Record<string, unknown>[] };
}

test("a stale row says STALE and the day it last traded, the line under the footer names it, and a list of fresh rows has no Last Trade column", async () => {
  const { text, line, rows } = await show([stock, halted]);
  expect(text).toContain("Last Trade");
  expect(line("SIVB")).toContain("STALE 2023-03-09");
  expect(text).toContain("(last trade 2023-03-09).");
  expect(rows.find((row) => row.symbol === "SIVB")).toMatchObject({ stale: true, lastTradeDate: "2023-03-09" });
  expect(rows.find((row) => row.symbol === "XOM")).toMatchObject({ stale: false });
  expect((await show([stock])).text).not.toContain("Last Trade");
});

test("a market cap of zero prints a dash, as a missing one does, never 0 USD", async () => {
  const { line, rows } = await show([stock, brentPrice]);
  expect(line("XOM")).toContain("500B USD");
  expect(line("BZ-USD")).not.toContain("USD  ");
  expect(line("BZ-USD")).toMatch(/ — *$/);
  expect(rows.find((row) => row.symbol === "BZ-USD")).toMatchObject({ marketCap: null });
});

test("an option contract is named by its terms where its saved name is only its code", async () => {
  const { rows } = await show([option]);
  expect(rows[0]).toMatchObject({ symbol: "AAPL261218C00300000", name: "AAPL Dec 18 '26 $300 Call" });
});

test("a list holding a perpetual market gains a Fund 8H column; any other list keeps its columns", async () => {
  const markets = spyOn(apiClient, "getCloudPerpsMarket").mockImplementation(async (marketId) =>
    ({ ...perpBoard({ rows: marketId === "binance:BZUSDT" ? [venueRow("binance", { symbol: "BZUSDT", baseAsset: "BZ", fundingRate8h: 0.000125 })] : [], access: "preview" }),
      evidence: [], methodologyUrl: "" }));
  try {
    const mixed = await show([stock, perpetual]);
    expect(mixed.text).toMatch(/Chg +Fund 8H +Mkt Cap/);
    expect(mixed.line("BZUSDT")).toContain("+0.0125%");
    // A stock has no perpetual of its own to read.
    expect(mixed.line("XOM")).toMatch(/ — +500B USD$/);
    expect(Object.fromEntries(mixed.rows.map((row) => [row.symbol, row.fundingRate8h]))).toEqual({ XOM: null, BZUSDT: 0.000125 });
    expect(markets.mock.calls.map(([marketId]) => marketId)).toEqual(["binance:BZUSDT", "binance:BZUSDT"]);

    markets.mockClear();
    const plain = await show([stock, option]);
    expect(plain.text).not.toContain("Fund 8H");
    expect(plain.rows.every((row) => !("fundingRate8h" in row))).toBe(true);
    expect(markets).not.toHaveBeenCalled();
  } finally { markets.mockRestore(); }
});

test("a perpetual whose market cannot be read shows a dash under Fund 8H and still lists", async () => {
  const markets = spyOn(apiClient, "getCloudPerpsMarket").mockRejectedValue(new Error("Gloom Cloud is unreachable"));
  try {
    const { text, line, rows } = await show([perpetual]);
    expect(text).toContain("Fund 8H");
    expect(line("BZUSDT")).toMatch(/\$?101\.48 +-0\.98% +— +—$/);
    expect(rows[0]).toMatchObject({ fundingRate8h: null });
  } finally { markets.mockRestore(); }
});
