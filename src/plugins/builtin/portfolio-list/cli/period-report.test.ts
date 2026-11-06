import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import type { ManualChartResolution } from "../../../../time-series/resolution";
import type { CloudPricePointPayload } from "../../../../api-client/types";
import { DEFAULT_CLI_OPTIONS } from "../../../../cli/options";
import { serializeCliResult } from "../../../../cli/result";
import type { CostFxHistoryClient } from "../../../../portfolio/cost-fx";
import { createTestCliContext } from "../../../../test-support/cli-context";
import { createTestDataProvider } from "../../../../test-support/data-provider";
import { createTestTicker } from "../../../../test-support/ticker";
import { createDefaultConfig } from "../../../../types/config";
import type { PricePoint } from "../../../../types/financials";
import { setCliColorEnabledOverride } from "../../../../utils/cli-output";
import { showCollection } from "./render";

afterEach(() => { setSystemTime(); setCliColorEnabledOverride(null); });

const day = (date: string, close: number): PricePoint => ({ date: new Date(`${date}T00:00:00Z`), close });
const DAILY: Record<string, PricePoint[]> = {
  AAPL: [day("2026-07-31", 300), day("2026-10-23", 347.73), day("2026-10-30", 344.63)],
  GDX: [day("2026-07-31", 70), day("2026-10-23", 80.2), day("2026-10-30", 77.09)],
  "2382": [day("2026-07-31", 60), day("2026-10-23", 63.15), day("2026-10-30", 63.3)],
};
const held = (symbol: string, exchange: string, currency: string, shares: number, dateAcquired = "2026-10-01") => createTestTicker(symbol, symbol, {
  exchange, currency, portfolios: ["model"], positions: [{ portfolio: "model", shares, broker: "manual", dateAcquired }],
});
const fx: CostFxHistoryClient = {
  getCloudHistory: async (symbol, _exchange, params) => {
    const closes: Record<string, number> = symbol === "HKD=X" ? { "2026-07-31": 7.85, "2026-10-23": 7.8, "2026-10-30": 7.75 } : {};
    const data: CloudPricePointPayload[] = Object.entries(closes).filter(([date]) => date >= params.startDate! && date <= params.endDate!)
      .map(([date, close]) => ({ date: `${date}T00:00:00.000Z`, close }));
    return { status: "success", data } as Awaited<ReturnType<CostFxHistoryClient["getCloudHistory"]>>;
  },
};

async function show(format: "text" | "json" | "csv", options: Partial<Parameters<typeof showCollection>[2]> = {}) {
  setSystemTime(new Date("2026-11-05T13:00:00Z"));
  setCliColorEnabledOverride(false);
  const config = createDefaultConfig("/unused-period-report");
  config.portfolios = [{ id: "model", name: "model", currency: "USD" }];
  // GDX was sold short; 2382 was bought on the 28th, inside the window.
  const tickers = [held("AAPL", "NASDAQ", "USD", 50), held("GDX", "ARCA", "USD", -200), held("2382", "HKEX", "HKD", 1000, "2026-10-28")];
  const cli = createTestCliContext({ config, store: { loadAllTickers: async () => tickers },
    dataProvider: createTestDataProvider({
      getQuote: async (symbol) => ({ symbol, price: DAILY[symbol]!.at(-1)!.close, currency: symbol === "2382" ? "HKD" : "USD", change: 0, changePercent: 0, lastUpdated: Date.now() }),
      getDetailedPriceHistoryWithMetadata: async (symbol, _exchange, start, end, interval) => ({
        points: (DAILY[symbol] ?? []).filter((point) => point.date >= start && point.date <= end), resolution: interval as ManualChartResolution,
      }),
    }),
  }, format === "text" ? {} : { format });
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((...parts: unknown[]) => { lines.push(parts.join(" ")); });
  try {
    await showCollection("model", cli.context, { period: { from: "2026-10-26", to: "2026-10-30" }, costFxHistory: fx, ...options });
  } finally {
    log.mockRestore();
  }
  const printed = cli.printed[0];
  return {
    text: lines.join("\n"),
    out: printed ? serializeCliResult(printed.result, { ...DEFAULT_CLI_OPTIONS, format: format === "text" ? "json" : format }, printed.options) : "",
  };
}

test("portfolio show --from prints each position's P&L, the FX line and a total that adds them up, in text, JSON and CSV alike", async () => {
  const { text } = await show("text");
  expect(text).toContain("P&L from the close of Fri 23 Oct to the close of Fri 30 Oct, on the holdings held now");
  // The short gains as the price falls; the HKD holding's price move is at the end's rate and the currency's own move is FX.
  expect(text).toMatch(/GDX:ARCA\s+-200\s+\$80\.20\s+\$77\.09\s+-3\.88%\s+\+\$622\.00/);
  // 1,000 x HK$0.15 at 7.75 is $19.35; HK$63,150 from 7.80 to 7.75 is the FX line's $52.23; the total adds the four.
  expect(text).toMatch(/2382:HKEX\s+1,000\s+HK\$63\.15\s+HK\$63\.30\s+\+0\.24%\s+\+\$19\.35/);
  expect(text).toMatch(/FX \(HKD\)\s+\+\$52\.23\s+\+0\.13%/);
  expect(text).toMatch(/TOTAL\s+\+\$538\.59\s+\+1\.30%/);
  expect(text).toContain("Bought inside the window: 2382:HKEX. Its P&L runs from the start close, as if held all along.");
  expect(text).toContain("FX: USD/HKD 7.8 on Fri 23 Oct, 7.75 on Fri 30 Oct.");

  const json = JSON.parse((await show("json")).out);
  // The rows and the FX line add up to the total.
  const pnls = json.data.map((entry: { pnl: number }) => entry.pnl) as number[];
  expect(pnls.reduce((sum, value) => sum + value, 0) + json.metadata.fx).toBeCloseTo(json.metadata.total, 9);
  const row = (symbol: string) => json.data.find((entry: { symbol: string }) => entry.symbol === symbol);
  expect(row("GDX")).toMatchObject({ shares: -200, startPrice: 80.2, endPrice: 77.09, pnl: expect.closeTo(622, 6) });
  expect(row("2382")).toMatchObject({ fxCurrency: "HKD", fxStart: expect.closeTo(1 / 7.8, 12), fxEnd: expect.closeTo(1 / 7.75, 12) });
  expect(json.metadata).toMatchObject({ from: "2026-10-26", to: "2026-10-30", startDay: "2026-10-23", endDay: "2026-10-30", complete: true, boughtInWindowSymbols: ["2382"] });

  // CSV carries the same rows, then the FX line and the total as rows of their own.
  const csv = (await show("csv")).out.trim().split("\n");
  expect(csv[0]).toContain("symbol");
  expect(csv.map((line) => line.split(",")[0])).toEqual(expect.arrayContaining(["AAPL", "GDX", "2382", "FX", "TOTAL"]));
});

test("portfolio show --from --real deflates the total by the CPI from the month before the start to the month before the end", async () => {
  const levels: Record<string, number> = { "2026-06": 329, "2026-07": 330, "2026-08": 331, "2026-09": 332.65 };
  const cpi = {
    getCloudFredSeries: async (id: string, params: { startDate: string }) => ({
      observations: id === "CPIAUCNS" ? Object.entries(levels).filter(([month]) => `${month}-01` >= params.startDate).map(([month, value]) => ({ date: `${month}-01`, value })) : [],
    }) as never,
  };
  const period = { from: "2026-08-03", to: "2026-10-30" };
  const json = JSON.parse((await show("json", { period, real: true, cpi })).out);
  // JSON keeps the two published levels it was read from.
  expect(json.metadata.real).toMatchObject({
    cpi: "US CPI", fromMonth: "2026-07", toMonth: "2026-09", latestPublished: false, inflationPercent: expect.closeTo((332.65 / 330 - 1) * 100, 9),
    readings: [{ series: "CPIAUCNS", month: "2026-07", value: 330 }, { series: "CPIAUCNS", month: "2026-09", value: 332.65 }],
  });
  const real = ((1 + json.metadata.real.nominalPercent / 100) / (332.65 / 330) - 1) * 100;
  expect(json.metadata.real.realPercent).toBeCloseTo(real, 9);
  const { text } = await show("text", { period, real: true, cpi });
  expect(text).toContain(`Real: +${real.toFixed(2)}% after US CPI +0.80%, Jul 2026 to Sep 2026; the BLS index.`);
});
