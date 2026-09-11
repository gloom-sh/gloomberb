import { afterEach, describe, expect, test } from "bun:test";
import { buildDividendMetrics, dividendReferencePrice, extractDividendFields, fetchDividendData, repriceDividendMetrics, toDividendPayment } from "./client";
import type { DividendPayment } from "./types";
import type { HeadlessPaneContext } from "../../../types/plugin";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { createDividendYieldHeadless } from "./headless";

afterEach(() => setHttpFetchTransport(null));

const now = new Date("2026-09-10T12:00:00Z");
function payment(date: string, amount = 0.5, currency = "USD"): DividendPayment {
  return toDividendPayment(date, amount, currency)!;
}

describe("extractDividendFields", () => {
  test("reads dividend modules from quoteSummary.result[0], not the response root", () => {
    const fields = extractDividendFields({
      summaryDetail: {
        trailingAnnualDividendRate: { raw: 99 },
        trailingAnnualDividendYield: { raw: 0.99 },
        currency: "EUR",
      },
      quoteSummary: {
        result: [{
          summaryDetail: {
            trailingAnnualDividendRate: { raw: 1.02 },
            trailingAnnualDividendYield: { raw: 0.0045 },
            forwardAnnualDividendRate: { raw: 1.04 },
            dividendRate: { raw: 9.99 },
            payoutRatio: { raw: 0.99 },
            exDividendDate: { raw: 1719792000 },
            dividendDate: { raw: 1720396800 },
            currency: "USD",
          },
          financialData: {
            payoutRatio: { raw: 0.14 },
          },
        }],
      },
    });

    expect(fields).toEqual({
      trailingAnnualDividendRate: 1.02,
      trailingAnnualDividendYield: 0.0045,
      forwardAnnualDividendRate: 1.04,
      payoutRatio: 0.14,
      exDividendDate: 1719792000,
      dividendDate: 1720396800,
      currency: "USD",
    });
  });

  test("falls back to Yahoo's current summaryDetail field names", () => {
    const fields = extractDividendFields({
      quoteSummary: {
        result: [{
          summaryDetail: {
            dividendRate: { raw: 1.08 },
            payoutRatio: { raw: 0.1204 },
            currency: "USD",
          },
        }],
      },
    });

    expect(fields.forwardAnnualDividendRate).toBe(1.08);
    expect(fields.payoutRatio).toBe(0.1204);
  });
});

describe("cash distribution calculations", () => {
  test("native income keeps the listing's ex-date when its session starts on the previous UTC date", async () => {
    const timestamp = Date.parse("2026-01-01T23:00:00Z") / 1000;
    setHttpFetchTransport(async (url) => {
      if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
      if (url.includes("getcrumb")) return new Response("fixture-crumb");
      if (url.includes("/chart/")) return Response.json({ chart: { result: [{
        meta: { currency: "AUD", exchangeTimezoneName: "Australia/Sydney", regularMarketPrice: 100, dataGranularity: "1mo" },
        timestamp: [timestamp], indicators: { quote: [{ close: [100] }] },
        events: { dividends: { one: { date: timestamp, amount: 0.25 } } },
      }] } });
      return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "AUD" } }] } });
    });
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

  test.each([
    ["SHY:XNAS", "", "SHY", "USD", 0.244],
    ["LQD:ARCX", "NASDAQ", "LQD", "USD", 0.444],
    ["VOD:XLON", "NASDAQ", "VOD.L", "GBp", 2.03],
    ["SHOP:XTSE", "NASDAQ", "SHOP.TO", "CAD", 0.1],
    ["SAP:XFRA", "", "SAP.F", "EUR", 2.35],
    ["BRK.B:XNYS", "", "BRK-B", "USD", 0.1],
    ["SHY", "", "SHY", "USD", 0.244],
    ["VOD.L", "", "VOD.L", "GBp", 2.03],
  ] as const)("loads the selected dividend listing %s with separate exchange %s", async (symbol, exchange, expected, currency, amount) => {
    const requested: string[] = [];
    const timestamp = Math.floor((Date.now() - 86_400_000) / 1000);
    setHttpFetchTransport(async (url) => {
      if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
      if (url.includes("getcrumb")) return new Response("fixture-crumb");
      const sourceSymbol = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
      requested.push(sourceSymbol);
      if (sourceSymbol !== expected) return Response.json({ chart: { result: [] }, quoteSummary: { result: [] } });
      if (url.includes("/chart/")) return Response.json({ chart: { result: [{
        meta: { symbol: expected, currency, regularMarketPrice: 100, dataGranularity: "1mo" }, timestamp: [timestamp],
        indicators: { quote: [{ close: [100] }] }, events: { dividends: { [timestamp]: { date: timestamp, amount } } },
      }] } });
      return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency } }] } });
    });

    const data = await fetchDividendData(symbol, null, exchange);
    expect(requested).toEqual([expected, expected]);
    expect(data.historyAvailable).toBe(true);
    expect(data.payments).toHaveLength(1);
    expect(data.payments[0]?.amount).toBeCloseTo(amount / (currency === "GBp" ? 100 : 1), 12);
    expect(data.currency).toBe(currency === "GBp" ? "GBP" : currency);
  });

  test("an unavailable explicitly selected foreign listing does not fall back to another venue", async () => {
    const requested: string[] = [];
    setHttpFetchTransport(async (url) => {
      if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
      if (url.includes("getcrumb")) return new Response("fixture-crumb");
      requested.push(decodeURIComponent(new URL(url).pathname.split("/").at(-1)!));
      return Response.json({ chart: { result: [] }, quoteSummary: { result: [] } });
    });
    await expect(fetchDividendData("SAP:XFRA", null)).rejects.toThrow("No dividend data found");
    expect(requested).toEqual(["SAP.F", "SAP.F"]);
  });

  test.each(["SHY:UNKNOWN", "VOD.L:XNAS"])("rejects unmapped or contradictory listing %s without a US fallback", async (symbol) => {
    const requested: string[] = [];
    setHttpFetchTransport(async (url) => { requested.push(url); throw new Error("Unexpected source request"); });
    await expect(fetchDividendData(symbol, null)).rejects.toThrow("selected listing");
    expect(requested).toEqual([]);
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
    setHttpFetchTransport(async (url) => {
      if (url.includes("fc.yahoo.com")) return new Response("", { headers: { "set-cookie": "test=fixture" } });
      if (url.includes("getcrumb")) return new Response("fixture-crumb");
      if (url.includes("/chart/")) return Response.json({ chart: { result: [{
        meta: { currency: "EUR", regularMarketPrice: 80, dataGranularity: "1mo" }, timestamp: [timestamp],
        indicators: { quote: [{ close: [80] }] }, events: { dividends: { [timestamp]: { date: timestamp, amount: 4 } } },
      }] } });
      if (url.includes("/quoteSummary/")) return Response.json({ quoteSummary: { result: [{ summaryDetail: { currency: "EUR" } }] } });
      throw new Error(`Unexpected fixture URL: ${url}`);
    });

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
    const fields = extractDividendFields({ quoteSummary: { result: [{ summaryDetail: {
      trailingAnnualDividendRate: { raw: 0 }, trailingAnnualDividendYield: { raw: 0 },
    } }] } });
    const metrics = buildDividendMetrics(payments, fields, 60, { now });
    expect(metrics.trailingRate).toBe(6);
    expect(metrics.trailingYield).toBeCloseTo(0.1, 12);
    expect(repriceDividendMetrics(metrics, 120).trailingYield).toBeCloseTo(0.05, 12);
    expect(repriceDividendMetrics(metrics, NaN).trailingYield).toBeNull();
  });

  test("normalizes pence cash into pounds and suppresses unverifiable summary rate units", () => {
    const payments = [payment("2026-06-04", 2.0301435, "GBp"), payment("2025-11-20", 1.9512, "GBp")];
    const fields = extractDividendFields({ quoteSummary: { result: [{ summaryDetail: {
      currency: "GBp", trailingAnnualDividendRate: { raw: 0.046 }, forwardAnnualDividendRate: { raw: 0.04 },
    } }] } });
    const metrics = buildDividendMetrics(payments, fields, 1.28725, { now, summaryRatesComparable: false });
    expect(payments[0]).toMatchObject({ currency: "GBP", amount: 0.020301435 });
    expect(metrics.trailingRate).toBeCloseTo(0.039813435, 12);
    expect(metrics.trailingYield).toBeCloseTo(0.0309290619, 9);
    expect(metrics.forwardRate).toBeNull();
    expect(metrics.forwardYield).toBeNull();
  });

  test("distinguishes no reported cash from unavailable history and does not advertise past payment dates", () => {
    const fields = extractDividendFields({ quoteSummary: { result: [{ summaryDetail: {
      dividendDate: { raw: Date.parse("2026-08-31") / 1000 },
    } }] } });
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
