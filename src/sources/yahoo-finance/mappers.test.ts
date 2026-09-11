import { describe, expect, test } from "bun:test";
import { extractExtendedHoursPrices, mapYahooAnalystResearchResponse, mapYahooCalendarEarnings, mapYahooDividends, mapYahooEarningsHistory, mapYahooSplits, yahooRawDate } from "./mappers";
import { loadYahooCorporateActions } from "./quote-summary";
import type { ChartResult } from "./types";

describe("Yahoo mappers", () => {
  test("uses historical exchange-local dates for dividend and split timestamps", () => {
    // Synthetic source-boundary fixtures; these do not assert an issuer's actual actions.
    const cases = [
      ["Australia/Sydney", "2026-01-01T23:00:00Z", "2026-01-02"],
      ["Australia/Sydney", "2026-07-01T00:00:00Z", "2026-07-01"],
      ["Pacific/Auckland", "2026-01-01T21:00:00Z", "2026-01-02"],
      ["Europe/London", "2026-07-01T07:00:00Z", "2026-07-01"],
      ["America/New_York", "2026-01-02T14:30:00Z", "2026-01-02"],
      ["America/New_York", "2026-07-01T13:30:00Z", "2026-07-01"],
      // The DST change means the same UTC clock time falls on different local dates.
      ["Australia/Sydney", "2026-04-04T13:30:00Z", "2026-04-05"],
      ["Australia/Sydney", "2026-04-05T13:30:00Z", "2026-04-05"],
    ];
    for (const [exchangeTimezoneName, instant, expected] of cases) {
      const date = Date.parse(instant!) / 1000;
      const events = {
        dividends: { one: { date, amount: 0.25 } },
        splits: { one: { date, numerator: 1, denominator: 10, splitRatio: "1:10" } },
      };
      const meta = { exchangeTimezoneName };
      expect(mapYahooDividends(events, meta)).toEqual([{ exDate: expected, amount: 0.25 }]);
      expect(mapYahooSplits(events, meta)).toEqual([{ date: expected, description: "1:10 split", ratio: 0.1, fromFactor: 10, toFactor: 1 }]);
    }
  });

  test("preserves UTC fallback and independent date-only fields without inferring a timezone", () => {
    const date = Date.parse("2026-01-01T23:00:00Z") / 1000;
    const events = { dividends: { valid: { date, amount: 1 }, invalid: { date: Infinity, amount: 1 } }, splits: { valid: { date }, invalid: { date: 1e20 } } };
    for (const meta of [undefined, {}, { exchangeTimezoneName: "Unknown/Exchange" }]) {
      expect(mapYahooDividends(events, meta)).toEqual([{ exDate: "2026-01-01", amount: 1 }]);
      expect(mapYahooSplits(events, meta).map((row) => row.date)).toEqual(["2026-01-01"]);
    }
    expect(yahooRawDate("2026-01-02")).toBe("2026-01-02");
    expect(yahooRawDate({ fmt: "2026-01-02", raw: date })).toBe("2026-01-02");
  });

  test("carries chart timezone through corporate-action loading", async () => {
    const date = Date.parse("2026-01-01T23:00:00Z") / 1000;
    const data = await loadYahooCorporateActions({ ticker: "FIXTURE.AX", providerId: "yahoo",
      fetchChart: async () => ({ meta: { currency: "AUD", exchangeTimezoneName: "Australia/Sydney" }, events: {
        dividends: { one: { date, amount: 0.25 } }, splits: { one: { date, numerator: 1, denominator: 10 } },
      } }),
      fetchJsonWithCrumb: async () => { throw new Error("Independent earnings unavailable"); },
    });
    expect(data.dividends).toEqual([{ exDate: "2026-01-02", amount: 0.25 }]);
    expect(data.splits[0]).toMatchObject({ date: "2026-01-02", ratio: 0.1, fromFactor: 10, toFactor: 1 });
    expect(data.currency).toBe("AUD");
  });

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
