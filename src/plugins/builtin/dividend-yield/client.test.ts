import { afterEach, describe, expect, test } from "bun:test";
import { buildDividendMetrics, fetchDividendData, repriceDividendMetrics, toDividendPayment } from "./client";
import { dividendReferencePrice } from "../../../utils/trailing-dividend";
import type { DividendPayment } from "./types";
import type { DividendSummary } from "../../../api-client/market-discovery";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { createDividendYieldHeadless, projectDividendYieldHeadless } from "./headless";
import { chartResponse, marketTransport, summaryFields } from "./test-fixture";
import { parsePublicTickerKey } from "../../../utils/exchanges";

afterEach(() => setHttpFetchTransport(null));

const now = new Date("2026-09-10T12:00:00Z");
function payment(date: string, amount = 0.5, currency = "USD"): DividendPayment {
  return toDividendPayment(date, amount, currency)!;
}

describe("cash distribution calculations", () => {
  test("native income keeps the listing's ex-date when its session starts on the previous UTC date", async () => {
    const timestamp = Date.parse("2026-01-01T23:00:00Z") / 1000;
    setHttpFetchTransport(marketTransport(async (url) => {
      if (url.includes("/chart/")) return chartResponse({
        meta: { currency: "AUD", exchangeTimezoneName: "Australia/Sydney", regularMarketPrice: 100, dataGranularity: "1mo" },
        time: timestamp, dividends: { one: { date: timestamp, amount: 0.25 } },
      });
      return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "AUD" } }] } });
    }));
    const data = await fetchDividendData("FIXTURE.AX", null);
    expect(data.payments[0]).toMatchObject({ exDate: new Date("2026-01-02"), amount: 0.25, currency: "AUD" });
  });

  test("a complete cash suspension is a full decline from a positive baseline", () => {
    const history = [payment("2020-08-01", 1), payment("2021-08-01", 1), payment("2022-08-01", 1), payment("2023-08-01", 1)];
    const afterSuspension = new Date("2024-09-10T12:00:00Z");
    expect(buildDividendMetrics(history, null, 100, { now: afterSuspension })).toMatchObject({
      trailingRate: 0, growth1Y: -1, growth3Y: -1,
    });
    // With no cash in either annual window, percentage growth is undefined.
    expect(buildDividendMetrics(history, null, 100, { now }).growth1Y).toBeNull();
    expect(buildDividendMetrics(history, null, 100, { now: afterSuspension, historyAvailable: false })).toMatchObject({
      trailingRate: null, growth1Y: null, growth3Y: null,
    });
    // An incomplete initial year must not turn missing observations into a cut.
    expect(buildDividendMetrics([payment("2023-08-01")], null, 100, { now: afterSuspension }).growth1Y).toBeNull();
  });

  test("a payout over zero or negative earnings is not meaningful, whatever the source states", () => {
    const summary = (trailingEps: number | undefined, payoutRatio: number | null = 20): DividendSummary => ({
      trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, forwardAnnualDividendRate: null,
      exDividendDate: null, dividendDate: null, currency: "USD", payoutRatio, ...(trailingEps === undefined ? {} : { trailingEps }),
    });
    const history = [payment("2026-08-01", 1)];
    expect(buildDividendMetrics(history, summary(-1.3), 10, { now })).toMatchObject({ payoutRatio: null, payoutNotMeaningful: true });
    expect(buildDividendMetrics(history, summary(0), 10, { now })).toMatchObject({ payoutRatio: null, payoutNotMeaningful: true });
    // A loss makes it N/M even where the source states none; unknown earnings leave the figure as served.
    expect(buildDividendMetrics(history, summary(-1.3, null), 10, { now }).payoutNotMeaningful).toBe(true);
    expect(buildDividendMetrics(history, summary(2.5, 0.4), 10, { now })).toMatchObject({ payoutRatio: 0.4, payoutNotMeaningful: false });
    expect(buildDividendMetrics(history, summary(undefined, 0.4), 10, { now })).toMatchObject({ payoutRatio: 0.4, payoutNotMeaningful: false });
  });

  test("a regular payer's yield says how many payments it counts when its history has a hole", () => {
    const late = new Date("2026-10-26T12:00:00Z");
    // Monthly ex-dates from November 2024 to October 2026, less the given months of 2026.
    const monthly = (missing: number[] = []) => Array.from({ length: 24 }, (_, index) => ({ year: 2024 + Math.floor((index + 10) / 12), month: (index + 10) % 12 + 1 }))
      .filter(({ year, month }) => !(year === 2026 && missing.includes(month)))
      .map(({ year, month }) => payment(`${year}-${String(month).padStart(2, "0")}-10`, 0.1));
    // ECC: monthly, with no July, August or September 2026 ex-dates in the source, so nine in the year.
    expect(buildDividendMetrics(monthly([7, 8, 9]), null, 10, { now: late }).trailingPayments).toEqual({ counted: 9, expected: 12, cadence: "monthly" });
    expect(buildDividendMetrics(monthly(), null, 10, { now: late }).trailingPayments).toBeNull();
    // A quarterly payer is read against four; an irregular one, a stopped dividend and a history that failed have nothing to say.
    const quarterly = ["2024-11-10", "2025-02-10", "2025-05-10", "2025-08-10", "2025-11-10", "2026-02-10", "2026-05-10", "2026-08-10"].map((date) => payment(date));
    expect(buildDividendMetrics(quarterly, null, 10, { now: late }).trailingPayments).toBeNull();
    expect(buildDividendMetrics(quarterly.filter((entry) => entry.exDate.toISOString() !== "2026-05-10T00:00:00.000Z"), null, 10, { now: late }).trailingPayments)
      .toEqual({ counted: 3, expected: 4, cadence: "quarterly" });
    expect(buildDividendMetrics([payment("2024-03-01"), payment("2026-09-01")], null, 10, { now: late }).trailingPayments).toBeNull();
    expect(buildDividendMetrics(monthly([7, 8, 9]), null, 10, { now: late, historyAvailable: false }).trailingPayments).toBeNull();
  });

  test("sends the selected listing unchanged to the backend", async () => {
    const requested: string[] = [];
    setHttpFetchTransport(async (url) => {
      requested.push(url);
      return Response.json({ status: "unavailable", data: null });
    });
    await expect(fetchDividendData("SAP:XFRA", null, "NASDAQ")).rejects.toThrow("No dividend data found");
    const url = new URL(requested[0]!);
    expect(url.pathname).toBe("/market/dividends");
    expect(url.searchParams.get("symbol")).toBe("SAP:XFRA");
    expect(url.searchParams.get("exchange")).toBe("NASDAQ");
  });

  test("an exchange-qualified listing reads that listing's history, as quote and events read it", async () => {
    const requested: URL[] = [];
    setHttpFetchTransport(async (url) => {
      const request = new URL(url);
      requested.push(request);
      return Response.json({ status: "success", data: { quote: null, summary: null, actions: {
        symbol: request.searchParams.get("symbol"), currency: request.searchParams.get("exchange") === "LSE" ? "GBp" : "USD",
        coverage: { dividends: "available" }, dividends: [{ exDate: "2026-08-06", amount: 39.82 }], splits: [], earnings: [],
      } } });
    });
    const quotes: string[] = [];
    const context = {
      // As `fn` resolves a typed key: `ULVR:LSE` is ULVR on LSE.
      resolveInstrument: async (key: string) => parsePublicTickerKey(key),
      marketData: { getQuote: async (symbol: string, exchange: string) => {
        quotes.push(`${symbol}|${exchange}`);
        throw new Error("Fixture quote unavailable");
      } },
    } as unknown as HeadlessPaneContext;
    const definition = createDividendYieldHeadless();
    const london = await definition.load({ rawArgument: "ULVR:LSE", argument: "ULVR:LSE", symbols: ["ULVR:LSE"], options: {} }, context);
    await definition.load({ rawArgument: "AAPL:NASDAQ", argument: "AAPL:NASDAQ", symbols: ["AAPL:NASDAQ"], options: {} }, context);
    expect(requested.map((url) => [url.searchParams.get("symbol"), url.searchParams.get("exchange")]))
      .toEqual([["ULVR", "LSE"], ["AAPL", "NASDAQ"]]);
    // The reference quote and the bond-fund check both read the listing.
    expect(new Set(quotes)).toEqual(new Set(["ULVR|LSE", "AAPL|NASDAQ"]));
    // The pence history is read in pounds.
    expect(london.sections.find((section) => section.title === "Dividend history")?.rows)
      .toMatchObject([{ exDate: "2026-08-06", amount: 0.3982, currency: "GBP" }]);
  });

  test("growth compares only years that hold every payment the cadence pays", () => {
    const late = new Date("2026-10-26T12:00:00Z");
    // AZN: semi-annual, a larger second interim in February, and no August 2026 interim in the source.
    const azn = ["2022-02-24", "2022-08-11", "2023-02-23", "2023-08-10", "2024-02-22", "2024-08-09", "2025-02-21", "2025-08-08", "2026-02-19"]
      .map((date) => payment(date, date.slice(5, 7) === "02" ? 2 : 1));
    const missingInterim = buildDividendMetrics(azn, null, 100, { now: late });
    expect(missingInterim).toMatchObject({
      growth1Y: null, growth1YPayments: { counted: 1, expected: 2, cadence: "semi-annual" },
      growth3Y: null, growth3YPayments: { counted: 1, expected: 2, cadence: "semi-annual" },
    });
    const result = projectDividendYieldHeadless({ payments: azn, metrics: missingInterim, price: 100, currency: "USD" },
      { rawArgument: "AZN", argument: "AZN", symbols: ["AZN"], options: {} });
    expect(result.sections[0]?.entries?.find((entry) => entry.label === "1Y Cash Growth"))
      .toMatchObject({ value: null, formatted: "n/a: 1 of 2 payments" });

    // With the interim, both years are whole and the growth is measured.
    const whole = buildDividendMetrics([...azn, payment("2026-08-07", 1)], null, 100, { now: late });
    expect(whole.growth1Y).toBeCloseTo(0, 12);
    expect(whole.growth1YPayments).toBeUndefined();
    // A hole a year earlier is named by the year it ends.
    const earlierHole = buildDividendMetrics([...azn.filter((entry) => entry.exDate.toISOString().slice(0, 10) !== "2025-08-08"), payment("2026-08-07", 1)],
      null, 100, { now: late });
    expect(earlierHole).toMatchObject({ growth1Y: null, growth1YPayments: { counted: 1, expected: 2, yearTo: "2025-10-26" } });
  });

  test("uses recent payment cadence and does not imply suspended dividends still pay quarterly", () => {
    const quarterly = Array.from({ length: 8 }, (_, quarter) => payment(
      new Date(Date.UTC(2024, 8 + quarter * 3, 25)).toISOString().slice(0, 10),
    ));
    // TQQQ's long earlier gaps formerly changed its current quarterly cadence to semi-annual.
    const resumed = buildDividendMetrics([payment("2016-09-25"), ...quarterly], null, 100, { now });
    expect(resumed.paymentFrequency).toBe("quarterly");
    const suspended = buildDividendMetrics([
      payment("2023-11-06"), payment("2024-02-06"), payment("2024-05-06"), payment("2024-08-07"),
    ], null, 100, { now });
    expect(suspended.trailingRate).toBe(0);
    expect(suspended.paymentFrequency).toBeNull();
    const annual = buildDividendMetrics([payment("2025-05-01"), payment("2026-05-01")], null, 100, { now });
    expect(annual.paymentFrequency).toBe("annual");
  });

  test("initial loading and headless yields only use external prices with matching explicit currency", async () => {
    const timestamp = Math.floor((Date.now() - 86_400_000) / 1000);
    setHttpFetchTransport(marketTransport(async (url) => {
      if (url.includes("/chart/")) return chartResponse({
        meta: { currency: "EUR", regularMarketPrice: 80, dataGranularity: "1mo" },
        time: timestamp, close: 80, dividends: { [timestamp]: { date: timestamp, amount: 4 } },
      });
      if (url.includes("/quoteSummary/")) return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "EUR" } }] } });
      throw new Error(`Unexpected fixture URL: ${url}`);
    }));

    for (const [quoteCurrency, expectedPrice] of [["USD", 80], [undefined, 80], ["EUR", 100]] as const) {
      const data = await fetchDividendData("ASML.AS", 100, "AMS", quoteCurrency);
      expect(data.price).toBe(expectedPrice);
      expect(data.metrics.trailingYield).toBeCloseTo(4 / expectedPrice, 12);
      const result = await createDividendYieldHeadless().load({
        rawArgument: "ASML.AS", argument: "ASML.AS", symbols: ["ASML.AS"], options: {},
      }, {
        resolveInstrument: async () => ({ symbol: "ASML", exchange: "AMS" }),
        marketData: { getQuote: async () => ({ price: 100, currency: quoteCurrency }) },
      } as unknown as HeadlessPaneContext);
      expect(result.sections[0]?.entries?.find((entry) => entry.label === "Trailing yield")?.value).toBeCloseTo(4 / expectedPrice, 12);
    }
    expect(dividendReferencePrice(200, "GBp", "GBP")).toBe(2);
    expect(dividendReferencePrice(2, "GBP", "GBP")).toBe(2);
    expect(dividendReferencePrice(200, "USD", "GBP")).toBeNull();
  });

  test("leap-day trailing cash and growth retain March 1 payments inside the prior calendar year", () => {
    const metrics = buildDividendMetrics([
      payment("2019-02-01", 1), payment("2020-03-01", 1), payment("2021-03-01", 2),
      payment("2022-03-01", 3), payment("2023-03-01", 4),
    ], null, 100, { now: new Date("2024-02-29T12:00:00Z") });
    expect(metrics.trailingRate).toBe(4);
    expect(metrics.trailingYield).toBe(0.04);
    expect(metrics.growth1Y).toBeCloseTo(4 / 3 - 1, 12);
    expect(metrics.growth3Y).toBeCloseTo(Math.pow(4, 1 / 3) - 1, 12);
  });

  test("uses reported cash history over zero ETF summary fields, with calendar cutoffs and no future cash", () => {
    const payments = Array.from({ length: 12 }, (_, month) => payment(new Date(Date.UTC(2025, 9 + month, 1)).toISOString().slice(0, 10)));
    payments.push(payment("2026-10-01", 10), payment("2025-09-10", 20));
    const fields = summaryFields({ summaryDetail: {
      trailingAnnualDividendRate: { raw: 0 }, trailingAnnualDividendYield: { raw: 0 },
    } });
    const metrics = buildDividendMetrics(payments, fields, 60, { now });
    expect(metrics.trailingRate).toBe(6);
    expect(metrics.trailingYield).toBeCloseTo(0.1, 12);
    expect(repriceDividendMetrics(metrics, 120).trailingYield).toBeCloseTo(0.05, 12);
    expect(repriceDividendMetrics(metrics, NaN).trailingYield).toBeNull();
  });

  test("a sub-unit history is read in the major unit, and its forward rate annualizes the latest distribution", async () => {
    // SBK as Gloom Cloud serves it: cash in ZAc with single-precision noise, the summary in rand.
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const cash = (latest: number) => [
      { exDate: day(latest - 147), amount: 878 }, { exDate: day(latest), amount: 902.00006 },
    ];
    const serve = (dividends: unknown[], summary: Record<string, unknown>, declaredDividends: unknown[] = []) => setHttpFetchTransport(async () => Response.json({
      status: "success", data: {
        actions: { symbol: "SBK", currency: "ZAc", coverage: { dividends: "available" }, dividends, declaredDividends, splits: [], earnings: [] },
        quote: { symbol: "SBK", currency: "ZAR", price: 307.87, lastUpdated: Date.now() },
        summary: { trailingAnnualDividendRate: null, trailingAnnualDividendYield: null, payoutRatio: null, exDividendDate: null,
          dividendDate: null, ...summary },
      },
    }));
    serve(cash(-37), { currency: "ZAR", forwardAnnualDividendRate: 18.04, forwardRateAsOf: day(-37) }, [{ exDate: day(30), amount: 950.00006 }]);
    const data = await fetchDividendData("SBK.JO", null, "JSE");
    expect(data.currency).toBe("ZAR");
    expect(data.payments.map((row) => [row.amount, row.currency])).toEqual([[9.02, "ZAR"], [8.78, "ZAR"]]);
    expect(data.declared).toMatchObject([{ amount: 9.5 }]);
    expect(data.metrics).toMatchObject({ trailingRate: 17.8, forwardRate: 18.04, forwardRateAsOf: day(-37) });
    expect(data.metrics.forwardYield).toBeCloseTo(18.04 / 307.87, 12);
    const entries = projectDividendYieldHeadless(data, { rawArgument: "SBK.JO", argument: "SBK.JO", symbols: ["SBK.JO"], options: {} })
      .sections[0]!.entries!;
    expect(entries.filter((entry) => entry.label.endsWith("rate")).map((entry) => entry.formatted?.replace(/\s/g, " "))).toEqual(["ZAR 17.80", "ZAR 18.04"]);
    // An older server stated the summary in ZAc, beside rates in an unstated unit (17.8 was rand): none is read.
    serve(cash(-37), { currency: "ZAc", trailingAnnualDividendRate: 17.8, forwardAnnualDividendRate: 1804 });
    expect((await fetchDividendData("SBK.JO", null, "JSE")).metrics).toMatchObject({ trailingRate: 17.8, forwardRate: null });
    // A semiannual dividend last paid two years ago has stopped, whatever rate is still stated for it.
    serve(cash(-730), { currency: "ZAR", forwardAnnualDividendRate: 18.04, forwardRateAsOf: day(-730) });
    expect((await fetchDividendData("SBK.JO", null, "JSE")).metrics).toMatchObject({
      forwardRate: null, forwardYield: null, lapse: { lastPaid: day(-730) },
    });
  });

  test("distinguishes no reported cash from unavailable history and does not advertise past payment dates", () => {
    const fields = summaryFields({ summaryDetail: {
      dividendDate: { raw: Date.parse("2026-08-31") / 1000 },
    } });
    expect(buildDividendMetrics([], fields, 100, { now }).trailingYield).toBe(0);
    const unavailable = buildDividendMetrics([], fields, 100, { now, historyAvailable: false });
    expect(unavailable.trailingYield).toBeNull();
    expect(unavailable.nextPayDate).toBeNull();
  });

  test("does not compare a new fund's partial first year with a full recent year", () => {
    const payments = Array.from({ length: 14 }, (_, month) => payment(new Date(Date.UTC(2025, 7 + month, 1)).toISOString().slice(0, 10)));
    const metrics = buildDividendMetrics(payments, null, 60, { now });
    expect(metrics.growth1Y).toBeNull();
    expect(metrics.growth3Y).toBeNull();
    const mature = buildDividendMetrics([
      payment("2022-08-01", 1), payment("2023-08-01", 1), payment("2024-08-01", 1.1),
      payment("2025-08-01", 1.21), payment("2026-08-01", 1.331),
    ], null, 60, { now });
    expect(mature.growth1Y).toBeCloseTo(0.1, 12);
    expect(mature.growth3Y).toBeCloseTo(0.1, 12);
  });
});
