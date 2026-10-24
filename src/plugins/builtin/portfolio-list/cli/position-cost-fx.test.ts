import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../../api-client";
import { serializeCliResult } from "../../../../cli/result";
import { DEFAULT_CLI_OPTIONS } from "../../../../cli/options";
import { createDefaultConfig, type AppConfig } from "../../../../types/config";
import type { TickerPosition, TickerRecord } from "../../../../types/ticker";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { createTestTicker } from "../../../../test-support/ticker";
import { portfolioCliCommand } from "./portfolio-command";
import { showCollection } from "./render";
import { buildTickerReport } from "../../../../cli/commands/ticker";

// USD per unit, as the data provider gives a rate: 41.37 TRY per USD today.
const USD_PER = { TRY: 1 / 41.37, GBP: 1.27 } as Record<string, number>;

afterEach(() => { (apiClient.getCloudHistory as { mockRestore?: () => void }).mockRestore?.(); });

/** A Lira book created under base USD (so its own currency is USD) in an app since set to base TRY. */
function liraConfig(): AppConfig {
  const config = createDefaultConfig("/unused-cost-fx");
  config.baseCurrency = "TRY";
  config.portfolios = [{ id: "lira", name: "Lira", currency: "USD" }];
  return config;
}

/** Runs `portfolio <args>` on one ticker, keeping what it saves; the book already holds a lot, so no first position adopts a currency. */
async function positionSet(config: AppConfig, record: TickerRecord, args: string[]) {
  const saved: TickerRecord[] = [];
  const held = createTestTicker("HELD", "Held", { portfolios: [config.portfolios[0]!.id],
    positions: [{ portfolio: config.portfolios[0]!.id, shares: 1, avgCost: 1, currency: "USD", broker: "manual" }] });
  const cli = createTestCliContext({ config,
    store: { loadTicker: async () => record, loadAllTickers: async () => [held], saveTicker: async (next: TickerRecord) => { saved.push(next); } },
    dataProvider: createTestDataProvider({ getExchangeRate: async (code: string) => USD_PER[code] ?? 1 }),
  });
  await portfolioCliCommand.execute(["position", "set", ...args], cli.context);
  const printed = cli.printed[0]!;
  return {
    lot: saved[0]?.metadata.positions[0],
    text: printed.options!.text!(printed.result.data as never),
    data: JSON.parse(serializeCliResult(printed.result, { ...DEFAULT_CLI_OPTIONS, format: "json" })).data,
  };
}

const aapl = createTestTicker("AAPL", "Apple", { portfolios: ["lira"] });

test("position set converts a cost into the currency portfolio show values the book in, which follows a base currency set later", async () => {
  // GLO-1044 review: the book's own currency is USD, but with base TRY it is valued in TRY, so a USD lot is foreign.
  const typed = await positionSet(liraConfig(), aapl, ["Lira", "AAPL", "10", "410", "USD", "--cost-fx", "32,15"]);
  expect(typed.lot).toMatchObject({ currency: "USD", costFxRate: 32.15, costFxCurrency: "TRY" });
  expect(typed.text).toMatch(/Cost FX\s+32\.15 TRY per USD/);
  expect(typed.data).toMatchObject({ costFxRate: 32.15, costFxCurrency: "TRY", costFxDate: null });

  const history = spyOn(apiClient, "getCloudHistory").mockImplementation(async (symbol) => ({ status: "success",
    data: symbol === "TRY=X" ? [{ date: "2024-03-01T00:00:00.000Z", close: 31.3694 }] : [] }) as never);
  const dated = await positionSet(liraConfig(), aapl, ["Lira", "AAPL", "10", "410", "USD", "--date", "2024-03-01"]);
  expect(history).toHaveBeenCalled();
  expect(dated.lot).toMatchObject({ dateAcquired: "2024-03-01", costFxRate: 31.3694, costFxCurrency: "TRY" });
  expect(dated.text).toContain("31.3694 TRY per USD (2024-03-01 close)");
  expect(dated.text).toMatch(/Purchase Date\s+2024-03-01/);

  // Offline or signed out, the read fails saying what it read, never a bare "fetch failed".
  history.mockRejectedValue(new Error("fetch failed"));
  await expect(positionSet(liraConfig(), aapl, ["Lira", "AAPL", "10", "410", "USD", "--date", "2024-03-01"]))
    .rejects.toThrow("Could not read the USD and TRY FX closes of 2024-03-01: fetch failed.");

  // With no rate the cost converts at today's, and says so.
  const today = await positionSet(liraConfig(), aapl, ["Lira", "AAPL", "10", "410", "USD"]);
  expect(today.text).toContain("Cost converted at today's rate into TRY");
  expect(today.data).toMatchObject({ costFxRate: null, costFxCurrency: "TRY" });
});

test("a typed rate that is inverted, per pound for a lot in pence, or a hundred times off today's is refused before anything is saved", async () => {
  const config = liraConfig();
  await expect(positionSet(config, aapl, ["Lira", "AAPL", "10", "410", "USD", "--cost-fx", "0.0319"]))
    .rejects.toThrow("--cost-fx 0.0319 looks inverted: it is the TRY paid for one USD, and today's is 41.37 TRY per USD.");
  await expect(positionSet(config, aapl, ["Lira", "AAPL", "10", "410", "USD", "--cost-fx", "4500"]))
    .rejects.toThrow("--cost-fx 4500 is more than 100 times off today's rate");
  // A rate from years back is far from today's and still taken: the lira lost most of its value since 2017.
  expect((await positionSet(config, aapl, ["Lira", "AAPL", "10", "410", "USD", "--cost-fx", "3.5"])).lot?.costFxRate).toBe(3.5);
  // A lot held in pence converts per penny: 52.54 TRY per GBP is 0.5254 per GBX.
  const vod = createTestTicker("VOD", "Vodafone", { exchange: "LSE", currency: "GBX", portfolios: ["lira"] });
  await expect(positionSet(config, vod, ["Lira", "VOD", "100", "70", "GBX", "--cost-fx", "52"]))
    .rejects.toThrow("--cost-fx 52 looks like TRY per GBP; VOD:LSE is held in GBX (pence), so the rate is TRY per GBX, 1/100 of that: today's is 0.525399 TRY per GBX.");
  expect((await positionSet(config, vod, ["Lira", "VOD", "100", "70", "GBX", "--cost-fx", "0.52"])).lot?.costFxRate).toBe(0.52);
});

test("a lot in the book's currency prints as it did unless --date was given, and US cents are the dollar's", async () => {
  const config = createDefaultConfig("/unused-cost-fx");
  config.portfolios = [{ id: "lira", name: "Lira", currency: "USD" }];
  const dated = createTestTicker("AAPL", "Apple", { portfolios: ["lira"],
    positions: [{ portfolio: "lira", shares: 10, avgCost: 410, currency: "USD", broker: "manual", dateAcquired: "2024-03-01" }] });
  const plain = await positionSet(config, dated, ["Lira", "AAPL", "12", "400"]);
  expect(plain.lot?.dateAcquired).toBe("2024-03-01");
  expect(plain.text).not.toContain("Purchase Date");
  expect(plain.text).not.toContain("today's rate");
  expect(Object.keys(plain.data)).not.toContainEqual(expect.stringMatching(/dateAcquired|costFx/));
  expect((await positionSet(config, dated, ["Lira", "AAPL", "12", "400", "--date", "2024-03-04"])).text).toMatch(/Purchase Date\s+2024-03-04/);
  // A cost in US cents is in the book's dollars: a date only dates it, and a rate is refused.
  const corn = createTestTicker("CORN", "Corn", { portfolios: ["lira"] });
  const cents = await positionSet(config, corn, ["Lira", "CORN", "10", "473.25", "USX", "--date", "2024-03-01"]);
  expect(cents.lot).toMatchObject({ currency: "USX", dateAcquired: "2024-03-01" });
  expect(cents.lot?.costFxRate).toBeUndefined();
  expect(cents.text).not.toContain("today's rate");
  await expect(positionSet(config, corn, ["Lira", "CORN", "10", "473.25", "USX", "--cost-fx", "0.01"]))
    .rejects.toThrow("is held in USX, a unit of USD, the portfolio's currency.");
});

test("portfolio show names only lots entered by hand whose cost converts at today's rate; a broker's lot reads as before", async () => {
  const config = liraConfig();
  const lot = (broker: string): TickerPosition => ({ portfolio: "lira", shares: 10, avgCost: 100, currency: "USD", broker });
  const tickers = [
    createTestTicker("AAPL", "Apple", { portfolios: ["lira"], positions: [lot("manual")] }),
    createTestTicker("MSFT", "Microsoft", { portfolios: ["lira"], positions: [lot("ibkr")] }),
    createTestTicker("NVDA", "NVIDIA", { portfolios: ["lira"], positions: [{ ...lot("manual"), costFxRate: 32, costFxCurrency: "TRY" }] }),
  ];
  const cli = createTestCliContext({ config, store: { loadAllTickers: async () => tickers },
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, price: 110, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() }),
      getExchangeRate: async (code: string) => USD_PER[code] ?? 1,
    }),
  }, { format: "json" });
  await showCollection("Lira", cli.context);
  const { data, metadata } = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  expect(metadata.costAtTodaysRateSymbols).toEqual(["AAPL"]);
  const row = (symbol: string) => data.find((entry: { symbol: string }) => entry.symbol === symbol);
  expect(row("AAPL")).toMatchObject({ costFxRate: null, costFxCurrency: null });
  expect(row("MSFT")).not.toHaveProperty("costFxRate");
  expect(row("NVDA")).toMatchObject({ costFxRate: 32, costFxCurrency: "TRY", costBasis: 32_000 });
});

test("portfolio show converts a dated lot's cost at its purchase date's FX close in the currency the book is valued in now", async () => {
  // Set with --date while the book was valued in USD, so only the date was kept; the base currency is TRY since.
  const config = liraConfig();
  const lot = (extra: Partial<TickerPosition> = {}): TickerPosition => ({ portfolio: "lira", shares: 10, avgCost: 100, currency: "USD", broker: "manual", ...extra });
  const tickers = [
    createTestTicker("AAPL", "Apple", { portfolios: ["lira"], positions: [lot({ dateAcquired: "2024-03-01" })] }),
    // A rate entered into another currency than the book's is no rate for it: the date's close is.
    createTestTicker("AMZN", "Amazon", { portfolios: ["lira"], positions: [lot({ dateAcquired: "2024-03-01", costFxRate: 0.92, costFxCurrency: "EUR" })] }),
    createTestTicker("MSFT", "Microsoft", { portfolios: ["lira"], positions: [lot()] }),
    // No TRY close in the week up to this date.
    createTestTicker("NVDA", "NVIDIA", { portfolios: ["lira"], positions: [lot({ dateAcquired: "2020-01-01" })] }),
  ];
  const reads: string[] = [];
  const history = { getCloudHistory: async (symbol: string, _exchange: string, params: { startDate?: string; endDate?: string }) => {
    reads.push(`${symbol} ${params.endDate}`);
    const inRange = params.startDate! <= "2024-03-01" && "2024-03-01" <= params.endDate!;
    return { status: "success", data: symbol === "TRY=X" && inRange ? [{ date: "2024-03-01T00:00:00.000Z", close: 31.3694 }] : [] } as never;
  } };
  const show = (format?: "json") => createTestCliContext({ config, store: { loadAllTickers: async () => tickers },
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, price: 110, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() }),
      getExchangeRate: async (code: string) => USD_PER[code] ?? 1,
    }),
  }, format ? { format } : undefined);
  const cli = show("json");
  await showCollection("Lira", cli.context, { costFxHistory: history });
  // One read per purchase date, however many lots share it.
  expect(reads.sort()).toEqual(["TRY=X 2020-01-02", "TRY=X 2024-03-02"]);
  const { data, metadata } = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  const row = (symbol: string) => data.find((entry: { symbol: string }) => entry.symbol === symbol);
  expect(row("AAPL")).toMatchObject({ costFxRate: 31.3694, costFxCurrency: "TRY", dateAcquired: "2024-03-01" });
  expect(row("AAPL").costBasis).toBeCloseTo(31_369.4, 6);
  expect(row("AMZN")).toMatchObject({ costFxRate: 31.3694, costFxCurrency: "TRY" });
  // Only an undated lot, or one whose date's close could not be read, converts at today's rate, and the note says which.
  expect(metadata.costAtTodaysRateSymbols.sort()).toEqual(["MSFT", "NVDA"]);
  const logged: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => { logged.push(parts.join(" ")); });
  try { await showCollection("Lira", show().context, { costFxHistory: history }); } finally { log.mockRestore(); }
  const notes = logged.join("\n").replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((line) => line.startsWith("Cost converted"));
  expect(notes).toEqual([
    "Cost converted at today's rate for MSFT:NASDAQ; give portfolio position set a --date or --cost-fx to use the rate when bought.",
    "Cost converted at today's rate for NVDA:NASDAQ: the FX close of the purchase date could not be read.",
  ]);
});

test("the ticker report's cost basis converts at the rate a lot was bought at, as its P&L does", async () => {
  const config = liraConfig();
  const record = createTestTicker("AAPL", "Apple", { portfolios: ["lira"],
    positions: [{ portfolio: "lira", shares: 10, avgCost: 410, currency: "USD", broker: "manual", costFxRate: 31.37, costFxCurrency: "TRY" }] });
  const quote = { symbol: "AAPL", price: 530, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.now() };
  const report = await buildTickerReport({ symbol: "AAPL", tickerFile: record, config,
    financials: { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] },
    toBase: async (value, currency) => currency === "TRY" ? value : value * 50 });
  expect(report).toMatch(/Cost Basis[^\n]*128,617/);
  expect(report).toMatch(/P&L[^\n]*136,383/);
});

test("GBp round trip: a cost typed in pence is saved in pence, so portfolio show divides it by 100", async () => {
  // GLO-1085: GBp was upper-cased to GBP, and 1,000 VOD at 70p cost £70,000 instead of £700.
  const config = createDefaultConfig("/unused-cost-fx");
  config.baseCurrency = "GBP";
  config.portfolios = [{ id: "uk", name: "UK", currency: "GBP" }];
  const vod = createTestTicker("VOD", "Vodafone", { exchange: "LSE", currency: "GBp", portfolios: ["uk"] });
  const typed = await positionSet(config, vod, ["UK", "VOD", "1000", "70", "GBp"]);
  expect(typed.lot).toMatchObject({ currency: "GBp", avgCost: 70 });
  expect(typed.data.currency).toBe("GBp");
  // gbp is pounds, and so is a blank currency: the listing's GBp quote is shown converted, in pounds.
  expect((await positionSet(config, vod, ["UK", "VOD", "1000", "0.70", "gbp"])).lot?.currency).toBe("GBP");
  expect((await positionSet(config, vod, ["UK", "VOD", "1000", "0.70"])).lot?.currency).toBe("GBP");

  const cli = createTestCliContext({ config, store: { loadAllTickers: async () => [{ ...vod, metadata: { ...vod.metadata, positions: [typed.lot!] } }] },
    dataProvider: createTestDataProvider({
      // Quotes arrive in pounds (the Cloud normalizer divides pence out).
      getQuote: async (symbol) => ({ symbol, price: 0.725, currency: "GBP", change: 0, changePercent: 0, lastUpdated: Date.now() }),
      getExchangeRate: async (code: string) => USD_PER[code] ?? 1,
    }),
  }, { format: "json" });
  await showCollection("UK", cli.context);
  const { data } = JSON.parse(serializeCliResult(cli.printed[0]!.result, { ...DEFAULT_CLI_OPTIONS, format: "json" }));
  const row = data.find((entry: { symbol: string }) => entry.symbol === "VOD");
  expect(row.costBasis).toBeCloseTo(700, 6);
  expect(row.marketValue).toBeCloseTo(725, 6);
  expect(row.unrealizedPnl).toBeCloseTo(25, 6);
});

test("position set over several lots keeps their earliest date and cost-weighted rate, or refuses rates one position cannot keep", async () => {
  const lots = (...positions: TickerPosition[]) => createTestTicker("AAPL", "Apple", { portfolios: ["lira"], positions });
  const lot = (shares: number, avgCost: number, extra: Partial<TickerPosition> = {}): TickerPosition =>
    ({ portfolio: "lira", shares, avgCost, currency: "USD", broker: "manual", ...extra });
  const merged = await positionSet(liraConfig(), lots(
    lot(10, 410, { dateAcquired: "2024-03-01", costFxRate: 31, costFxCurrency: "TRY" }),
    lot(20, 395, { dateAcquired: "2023-11-15", costFxRate: 34, costFxCurrency: "TRY" }),
  ), ["Lira", "AAPL", "30", "400", "USD"]);
  expect(merged.lot).toMatchObject({ dateAcquired: "2023-11-15", costFxCurrency: "TRY" });
  expect(merged.lot!.costFxRate! * 12_000).toBeCloseTo(4_100 * 31 + 7_900 * 34, 6);
  expect(merged.text).toMatch(/Purchase Date\s+2023-11-15/);

  const mixed = lots(lot(10, 410, { costFxRate: 31, costFxCurrency: "TRY" }), lot(20, 395));
  const refused = positionSet(liraConfig(), mixed, ["Lira", "AAPL", "30", "400", "USD"]);
  await expect(refused).rejects.toThrow("Of the 2 lots, 1 converts its cost at the FX rate it was bought at and 1 at today's, so one position cannot keep their rates.");
  expect((await positionSet(liraConfig(), mixed, ["Lira", "AAPL", "30", "400", "USD", "--cost-fx", "33"])).lot?.costFxRate).toBe(33);
});
