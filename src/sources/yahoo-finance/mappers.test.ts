import { describe, expect, test } from "bun:test";
import { extractExtendedHoursPrices, mapYahooAnalystResearchResponse, mapYahooCalendarEarnings, mapYahooEarningsHistory } from "./mappers";
import { loadYahooCorporateActions } from "./quote-summary";
import type { ChartResult } from "./types";

describe("Yahoo mappers", () => {
  test("normalizes London price targets without converting USD earnings estimates", () => {
    const data = mapYahooAnalystResearchResponse({ price: { currency: "GBp" },
      financialData: { targetMeanPrice: 3812.312, currentPrice: 3533.5 },
      upgradeDowngradeHistory: { history: [{ epochGradeDate: 1_700_000_000, firm: "Analyst", currentPriceTarget: 3900, priorPriceTarget: 3600 }] },
      earningsTrend: { trend: [{ period: "0q", endDate: "2026-09-30", earningsEstimate: { avg: 1.39667, earningsCurrency: "USD", numberOfAnalysts: 10 } }] },
    }, "SHEL.L");
    expect(data).toMatchObject({ currency: "GBP", priceTarget: { currency: "GBP", average: 38.12312, current: 35.335 },
      ratings: [{ currentPriceTarget: 39, priorPriceTarget: 36 }], earningsEstimates: [{ average: 1.39667, currency: "USD" }] });
  });

  test("preserves TSM reporting currency and drops Yahoo no-coverage zeros while keeping break-even consensus", () => {
    const data = mapYahooAnalystResearchResponse({ price: { currency: "USD" }, earningsTrend: { trend: [
      { period: "0q", endDate: "2026-09-30", earningsEstimate: { avg: 4.4614, earningsCurrency: "USD" }, revenueEstimate: { avg: 1.454e12, revenueCurrency: "TWD" } },
      { period: "+1q", earningsEstimate: { avg: 0, low: 0, high: 0, numberOfAnalysts: 2, earningsCurrency: "USD" }, revenueEstimate: { avg: 0, low: 0, high: 0, numberOfAnalysts: 0 } },
    ] } }, "TSM");
    expect(data.earningsEstimates.map((row) => [row.average, row.currency])).toEqual([[4.4614, "USD"], [0, "USD"]]);
    expect(data.revenueEstimates).toHaveLength(1);
    expect(data.revenueEstimates[0]).toMatchObject({ average: 1.454e12, currency: "TWD" });
  });

  test("distinguishes announcement dates from Yahoo fiscal period ends", () => {
    expect(mapYahooCalendarEarnings({ calendarEvents: { earnings: { earningsDate: [{ fmt: "2026-09-24" }] } } })[0]?.dateType).toBe("announcement");
    const [history] = mapYahooEarningsHistory({ earningsHistory: { history: [{ quarter: "2026-05-31", currency: "CNY", epsActual: -0.63, epsEstimate: -0.78, surprisePercent: 0.1885 }] } });
    expect(history).toMatchObject({ date: "2026-05-31", dateType: "fiscal-period-end", currency: "CNY", epsActual: -0.63, surprisePercent: 18.85 });
  });

  test("omits grade-only zero placeholders but retains explicitly cut-to-zero analyst targets", () => {
    const data = mapYahooAnalystResearchResponse({ upgradeDowngradeHistory: { history: [
      { epochGradeDate: 1_700_000_000, firm: "Freedom Capital Markets", action: "down", priceTargetAction: "", currentPriceTarget: 0, priorPriceTarget: 0 },
      { epochGradeDate: 1_700_000_000, firm: "Distressed analyst", action: "down", priceTargetAction: "Lowers", currentPriceTarget: 0, priorPriceTarget: 2 },
    ] } }, "BABA");
    expect(data.ratings[0]?.currentPriceTarget).toBeUndefined();
    expect(data.ratings[0]?.priorPriceTarget).toBeUndefined();
    expect(data.ratings[1]).toMatchObject({ currentPriceTarget: 0, priorPriceTarget: 2 });
  });

  test("retains London dividends when the independent earnings endpoint fails", async () => {
    const data = await loadYahooCorporateActions({ ticker: "VOD.L", providerId: "yahoo",
      fetchChart: async () => ({ meta: { currency: "GBp" }, events: { dividends: { one: { date: 1_700_000_000, amount: 2.0301435 } } } }),
      fetchJsonWithCrumb: async () => { throw new Error("Earnings unavailable"); },
    });
    expect(data).toMatchObject({ currency: "GBP", coverage: { dividends: "available", splits: "available", earnings: "unavailable" } });
    expect(data.dividends[0]?.amount).toBeCloseTo(0.020301435, 9);
  });
  test("derives premarket change from the prior regular close", () => {
    const meta: NonNullable<ChartResult["meta"]> = {
      regularMarketPrice: 39.47,
      chartPreviousClose: 29,
      currentTradingPeriod: {
        pre: { start: 100, end: 200 },
        regular: { start: 300, end: 400 },
        post: { start: 500, end: 600 },
      },
    };

    const result = extractExtendedHoursPrices(
      meta,
      [100, 200],
      [39, 39.47],
      "PRE",
      38,
    );

    expect(result.preMarketPrice).toBe(39.47);
    expect(result.preMarketChange).toBeCloseTo(1.47, 8);
    expect(result.preMarketChangePercent).toBeCloseTo(3.8684210526, 8);
  });
});
