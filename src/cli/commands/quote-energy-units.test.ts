import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../api-client";
import type { FuturesContractTermsPayload } from "../../api-client/futures-curve";
import { createDefaultConfig } from "../../types/config";
import type { Quote, TickerFinancials } from "../../types/financials";
import { createTestCliContext, type PrintedCliResult } from "../../test-support/cli-context";
import { marketDataCliCommands } from "./market";
import { buildTickerReport } from "./ticker";
import { serializeCliResult } from "../result";
import { DEFAULT_CLI_OPTIONS } from "../options";

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const config = createDefaultConfig("/tmp/gloom-quote-energy-units-test");
const quoteCommand = marketDataCliCommands.find((command) => command.name === "quote")!;

/** Dutch TTF gas as the server sends it: no exchange terms, so its unit is the catalog's. */
const ttfTerms: FuturesContractTermsPayload = {
  symbol: "TTF=F", root: "TTF", name: "Dutch TTF Gas", contract: "TTFX26", contractSymbol: "TTFX26.NYM", deliveryMonth: "2026-11",
  spec: null, lastTrade: "2026-10-29", firstNotice: null, inDelivery: false, settlement: { price: 90.043, date: "2026-10-22" },
};
const ngTerms: FuturesContractTermsPayload = {
  symbol: "NG=F", root: "NG", name: "Natural Gas", contract: "NGX26", contractSymbol: "NGX26.NYM", deliveryMonth: "2026-11",
  spec: { unit: "USD / MMBtu", size: "10,000 MMBtu", pointValue: 10_000, tick: 0.001, tickValue: 10, settlement: "physical" },
  lastTrade: "2026-10-28", firstNotice: "2026-10-29", inDelivery: false, settlement: { price: 2.796, date: "2026-10-22" },
};
const quote = (symbol: string, currency: string, price: number, change: number): Quote => ({
  symbol, name: symbol === "TTF=F" ? "Dutch TTF Natural Gas Nov 26" : "Natural Gas Nov 26", price, change,
  changePercent: (change / (price - change)) * 100, currency, instrumentType: "FUTURE", lastUpdated: Date.parse("2026-10-22T15:50:00Z"),
});
const ttf = quote("TTF=F", "EUR", 90.3, 2.874);
const ng = quote("NG=F", "USD", 2.761, -0.035);

test("yen futures export dollars per yen, without rescaling the quote or relabeling spot FX", async () => {
  const future = quote("6J=F", "USD", 0.00628, 0);
  const spot = { ...quote("USDJPY=X", "JPY", 159.4, 0), instrumentType: "CURRENCY" };
  const terms = { ...ngTerms, symbol: future.symbol, root: "6J", name: "Japanese Yen", settlement: null,
    spec: { ...ngTerms.spec!, unit: "USD / JPY", tick: 0.0000005, tickValue: 6.25 } };
  spyOn(apiClient, "getCloudFuturesContract").mockResolvedValue(terms);
  const cli = createTestCliContext({ config, dataProvider: { getQuotesBatch: async () => [future, spot].map((item) => ({
    target: { symbol: item.symbol, exchange: "" }, quote: item,
  })) } });
  await quoteCommand.execute([future.symbol, spot.symbol], cli.context);
  const { result, options } = cli.printed[0]!;
  expect(result.data).toMatchObject([{ priceUnit: "USD per JPY", quote: { price: 0.00628 }, futuresContract: { spec: { unit: "USD per JPY", tick: 0.0000005 } } },
    { quote: { price: 159.4 } }]);
  const [header, ...rows] = serializeCliResult(result, { ...DEFAULT_CLI_OPTIONS, format: "csv" }, options).split("\n");
  const unit = header!.split(",").indexOf("currency_or_unit");
  expect(rows.slice(0, 2).map((row) => row.split(",")[unit])).toEqual(["USD per JPY", "JPY per USD"]);
});

afterEach(() => {
  (apiClient.getCloudFuturesContract as unknown as { mockRestore?: () => void }).mockRestore?.();
  process.exitCode = 0;
});

test("quote prices each energy contract per its unit, and TTF adds dollars per MMBtu at the day's EUR/USD as a conversion", async () => {
  spyOn(apiClient, "getCloudFuturesContract").mockImplementation(async (symbol: string) => symbol === "TTF=F" ? ttfTerms : ngTerms);
  const rates: string[] = [];
  const cli = createTestCliContext({ config, dataProvider: {
    getQuotesBatch: async () => [ttf, ng].map((entry) => ({ target: { symbol: entry.symbol!, exchange: "" }, quote: entry })),
    getExchangeRate: async (currency: string) => { rates.push(currency); return 1.1226; },
  } });
  await quoteCommand.execute(["TTF=F", "NG=F"], cli.context);
  const [{ result, options }] = cli.printed as [PrintedCliResult];
  const rows = options!.rows!(result.data) as Array<Record<string, unknown>>;
  expect(rows.map((row) => row.price)).toEqual(["€90.30/MWh", "$2.761/MMBtu"]);
  const details = stripAnsi(options!.details!(result.data));
  // €90.30 x 1.1226 / 3.412 MMBtu per MWh.
  expect(details).toMatch(/In USD\s+≈ \$29\.710\/MMBtu at EUR\/USD 1\.1226/);
  expect(details).toMatch(/Unit\s+EUR \/ MWh/);
  expect(details).toMatch(/Unit\s+USD \/ MMBtu/);
  // Henry Hub is already in dollars per MMBtu: no conversion, nor a rate asked for it.
  expect(details.match(/In USD/g)).toHaveLength(1);
  expect(rates).toEqual(["EUR"]);
  const data = result.data as Array<{ usdPerMmbtu?: unknown }>;
  expect(data[0]!.usdPerMmbtu).toEqual({ value: expect.closeTo(29.7099, 3), currency: "EUR", usdPerUnit: 1.1226 });
  expect(data[1]!.usdPerMmbtu).toBeUndefined();
});

test("ticker reads TTF the same way: its Last per MWh, the dollar equivalent beside the move, and the unit in its Contract block", async () => {
  const financials = { quote: ttf, annualStatements: [], quarterlyStatements: [], priceHistory: [] } as TickerFinancials;
  const text = stripAnsi(await buildTickerReport({
    symbol: "TTF=F", tickerFile: null, financials, config, toBase: async (value) => value, futuresContract: ttfTerms,
    usdPerMmbtu: { value: (90.3 * 1.1226) / 3.412, currency: "EUR", usdPerUnit: 1.1226 },
  }));
  const line = (label: string) => text.split("\n").find((entry) => entry.trim().startsWith(label))?.trim() ?? "";
  expect(line("Last")).toMatch(/^Last\s+€90\.30\/MWh$/);
  expect(line("In USD")).toMatch(/^In USD\s+≈ \$29\.710\/MMBtu at EUR\/USD 1\.1226$/);
  expect(line("Unit")).toMatch(/^Unit\s+EUR \/ MWh$/);
});
