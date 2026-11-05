import { expect, test } from "bun:test";
import type { ManualChartResolution } from "../../../time-series/resolution";
import type { CloudPricePointPayload } from "../../../api-client/types";
import type { CostFxHistoryClient } from "../../../portfolio/cost-fx";
import type { PortfolioFuturesTerms } from "../../../portfolio/futures-positions";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createTestTicker } from "../../../test-support/ticker";
import type { PricePoint } from "../../../types/financials";
import { loadPeriodPnl, periodBasisText, periodUnpricedText } from "./period-pnl";

const day = (date: string, close: number): PricePoint => ({ date: new Date(`${date}T00:00:00Z`), close });

// Daily closes, a future's its settlements. Hourly bars, if asked for, would read other prices: a Globex hour is no settlement.
const DAILY: Record<string, PricePoint[]> = {
  "GC=F": [day("2020-03-16", 1485.9), day("2020-03-17", 1524.9), day("2020-03-18", 1477.3), day("2026-10-29", 4031.4), day("2026-10-30", 3898.9)],
  "SI=F": [day("2026-10-29", 48), day("2026-10-30", 47)],
  VOD: [day("2020-03-17", 110), day("2026-10-29", 70), day("2026-10-30", 72)],
  "2382": [day("2020-03-17", 104.9), day("2026-10-29", 64.05), day("2026-10-30", 63.3)],
};

function provider(asked: string[]) {
  return createTestDataProvider({
    getDetailedPriceHistoryWithMetadata: async (symbol, _exchange, start, end, interval) => {
      asked.push(`${symbol} ${interval}`);
      if (interval !== "1d") return { points: [{ date: new Date("2026-10-30T13:00:00Z"), close: 1 }], resolution: interval as ManualChartResolution };
      return { points: (DAILY[symbol] ?? []).filter((point) => point.date >= start && point.date <= end), resolution: "1d" };
    },
  });
}

/** Dollar pairs' daily closes by day, served for any window asked. */
function fxHistory(closes: Record<string, Record<string, number>>) {
  const client: CostFxHistoryClient = {
    getCloudHistory: async (symbol, _exchange, params) => {
      const data: CloudPricePointPayload[] = Object.entries(closes[symbol] ?? {})
        .filter(([date]) => (!params.startDate || date >= params.startDate) && (!params.endDate || date <= params.endDate))
        .map(([date, close]) => ({ date: `${date}T00:00:00.000Z`, close }));
      return { status: "success", data } as Awaited<ReturnType<CostFxHistoryClient["getCloudHistory"]>>;
    },
  };
  return { client };
}

const held = (symbol: string, exchange: string, currency: string, shares: number, assetCategory?: string) => createTestTicker(symbol, symbol, {
  exchange, currency, ...(assetCategory ? { assetCategory } : {}), portfolios: ["book"],
  positions: [{ portfolio: "book", shares, broker: "manual", dateAcquired: "2026-10-01" }],
});

const BOOK = [
  held("GC=F", "CMX", "USD", 2, "FUT"),
  held("SI=F", "CMX", "USD", 1, "FUT"),
  held("VOD", "LSE", "GBp", 100),
  held("2382", "HKEX", "HKD", 1000),
];
const TERMS = new Map<string, PortfolioFuturesTerms>([["GC=F", { size: { multiplier: 100, size: "100 oz" }, settlement: null }]]);
const now = Date.parse("2026-11-05T13:00:00Z");

test("a one-day window and one over five years both run between daily closes: a future's settlements times its size, pence in pounds, FX at the window's own dates", async () => {
  const asked: string[] = [];
  const fx = fxHistory({
    "GBPUSD=X": { "2020-03-17": 1.2, "2026-10-29": 1.3, "2026-10-30": 1.32 },
    "HKD=X": { "2020-03-17": 7.76, "2026-10-29": 7.8, "2026-10-30": 7.75 },
  });
  const load = (from: string, to: string) => loadPeriodPnl({
    tickers: BOOK, portfolioId: "book", currency: "USD", window: { from, to }, provider: provider(asked), fxHistory: fx.client, futures: TERMS, now,
  });
  const day1 = await load("2026-10-30", "2026-10-30");
  const row = (result: typeof day1, symbol: string) => result.rows.find((entry) => entry.symbol === symbol)!;
  // A day's window is never read in hourly bars: Thursday's settlement to Friday's, two contracts of 100 oz.
  expect(asked.every((request) => request.endsWith(" 1d"))).toBe(true);
  expect([row(day1, "GC=F").start, row(day1, "GC=F").end]).toEqual([{ day: "2026-10-29", price: 4031.4 }, { day: "2026-10-30", price: 3898.9 }]);
  expect(row(day1, "GC=F").pnl).toBeCloseTo(2 * 100 * (3898.9 - 4031.4), 6);
  // 100 shares quoted in pence move 2p each: £2, at the end's GBP rate; the currency's move on the start value is FX.
  expect(row(day1, "VOD").pnl).toBeCloseTo(2 * 1.32, 9);
  expect(row(day1, "VOD").rates).toEqual({ currency: "GBP", start: 1.3, end: 1.32 });
  expect(row(day1, "VOD").fx).toBeCloseTo(70 * (1.32 - 1.3), 9);
  expect(row(day1, "2382").rates).toEqual({ currency: "HKD", start: expect.closeTo(1 / 7.8, 12), end: expect.closeTo(1 / 7.75, 12) });
  // A future with no contract size is never counted at one unit: it is named, with why.
  expect(periodUnpricedText(day1)).toBe("No P&L for SI=F (contract size unknown). The total leaves it out.");
  expect(periodBasisText(day1, { futuresHeld: true, now })).toBe("P&L from the close of Thu 29 Oct to the close of Fri 30 Oct, futures at their settlements, on the holdings held now");

  asked.length = 0;
  const years = await load("2020-03-18", "2026-10-30");
  // Over five years still daily closes, never weekly ones: the window starts at the close the day before it.
  expect(asked.every((request) => request.endsWith(" 1d"))).toBe(true);
  expect(row(years, "GC=F").start).toEqual({ day: "2020-03-17", price: 1524.9 });
  expect(row(years, "GC=F").pnl).toBeCloseTo(2 * 100 * (3898.9 - 1524.9), 6);
  expect(row(years, "VOD").rates).toEqual({ currency: "GBP", start: 1.2, end: 1.32 });
  // Every holding was bought inside these years: named, not passed off as held throughout.
  expect(years.boughtInWindow.sort()).toEqual(["2382", "GC=F", "SI=F", "VOD"]);
});
