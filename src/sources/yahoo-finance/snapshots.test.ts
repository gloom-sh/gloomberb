import { expect, test } from "bun:test";
import { buildYahooStatements, computeYahooReturn, latestYahooMetric, parseYahooTimeseries } from "./financials";
import { loadYahooQuote, loadYahooTickerFinancials } from "./snapshots";

test("Yahoo annual summary never borrows a wholly omitted latest-year metric", async () => {
  for (const currentValue of [undefined, 0]) {
    const annual = {
      annualNetIncome: 200, annualOperatingIncome: 300,
      annualDilutedEPS: 2, annualDilutedAverageShares: 100,
    };
    const raw = Object.entries(annual).map(([key, value]) => ({
      meta: { type: [key] },
      [key]: [
        { asOfDate: "2024-12-31", currencyCode: "USD", reportedValue: { raw: value } },
        ...(currentValue === undefined ? [] : [{ asOfDate: "2025-12-31", currencyCode: "USD", reportedValue: { raw: currentValue } }]),
      ],
    }));
    raw.push({ meta: { type: ["annualTotalRevenue"] }, annualTotalRevenue: [
      { asOfDate: "2025-12-31", currencyCode: "USD", reportedValue: { raw: 1000 } },
    ] });
    raw.push({ meta: { type: ["quarterlyTotalRevenue"] }, quarterlyTotalRevenue: [
      { asOfDate: "2026-06-30", currencyCode: "USD", reportedValue: { raw: 400 } },
    ] });
    const financials = await loadYahooTickerFinancials("CONTROL", {
      providerId: "yahoo", fetchAssetProfile: async () => undefined,
      fetchChart: async () => ({ meta: { currency: "USD", regularMarketPrice: 10 }, history: [{ date: new Date("2026-09-16"), close: 10 }] }),
      fetchExtendedHoursData: async () => ({}), fetchQuoteSupplement: async () => ({}), fetchTimeseries: async () => raw,
    });
    expect(financials.fundamentals).toMatchObject({ revenue: 1000, financialCurrency: "USD" });
    for (const field of ["netIncome", "eps", "sharesOutstanding", "operatingMargin", "profitMargin"] as const) {
      expect(financials.fundamentals?.[field]).toBe(currentValue);
    }
    expect(financials.annualStatements[0]).toMatchObject({ date: "2024-12-31", netIncome: 200, eps: 2, dilutedShares: 100 });
  }
});

test("Yahoo preserves report currency and calculates operating margin from operating income", async () => {
  const metrics = { annualTotalRevenue: 1000, annualOperatingIncome: 200, annualEBITDA: 300, annualNetIncome: 150 };
  const financials = await loadYahooTickerFinancials("TSM", {
    providerId: "yahoo",
    fetchAssetProfile: async () => undefined,
    fetchChart: async () => ({ meta: { currency: "USD", regularMarketPrice: 200 }, history: [{ date: new Date("2025-12-31"), close: 200 }] }),
    fetchExtendedHoursData: async () => ({}),
    fetchQuoteSupplement: async () => ({}),
    fetchTimeseries: async () => Object.entries(metrics).map(([key, value]) => ({
      meta: { type: [key] },
      [key]: [{ asOfDate: "2025-12-31", currencyCode: "TWD", reportedValue: { raw: value } }],
    })),
  });
  expect(financials.quote?.currency).toBe("USD");
  expect(financials.financialCurrency).toBe("TWD");
  expect(financials.annualStatements[0]?.currency).toBe("TWD");
  expect(financials.fundamentals).toMatchObject({ financialCurrency: "TWD", revenue: 1000, operatingMargin: 0.2 });
});


test("Yahoo never overwrites statement currency while adding another metric", () => {
  expect(buildYahooStatements({
    annualTotalRevenue: [{ asOfDate: "2025-12-31", value: 3000, currency: "TWD" }],
    annualNetIncome: [{ asOfDate: "2025-12-31", value: 50, currency: "USD" }],
  }, "annual")).toEqual([{ date: "2025-12-31", totalRevenue: 3000, currency: "TWD" }]);
});

test("Yahoo snapshot does not label a young fund's since-inception change as full-year performance", async () => {
  const financials = await loadYahooTickerFinancials("NEWF", {
    providerId: "yahoo",
    fetchAssetProfile: async () => undefined,
    fetchChart: async () => ({
      meta: { currency: "USD", instrumentType: "ETF", regularMarketPrice: 105, regularMarketTime: Date.parse("2026-09-10") / 1000 },
      history: [{ date: new Date("2026-08-06"), close: 100 }, { date: new Date("2026-09-10"), close: 105 }],
    }),
    fetchExtendedHoursData: async () => ({}),
    fetchQuoteSupplement: async () => ({}),
    fetchTimeseries: async () => [],
  });
  expect(financials.fundamentals?.return1Y).toBeUndefined();
  expect(financials.fundamentals?.return3Y).toBeUndefined();
  expect(financials.priceHistory.map(point => point.close)).toEqual([100, 105]);
});

test("Yahoo calendar horizons preserve zero and use the covered year boundary across leap years", () => {
  const history = [
    { date: new Date("2023-03-01"), close: 100 },
    { date: new Date("2023-03-02"), close: 110 },
    { date: new Date("2024-03-01"), close: 100 },
  ];
  expect(computeYahooReturn(history, 1)).toBe(0);
  expect(computeYahooReturn(history, 3)).toBeUndefined();
  expect(computeYahooReturn([...history].reverse(), 1)).toBe(0);
});

test("Yahoo latest metrics use the reported calendar period, retaining zero and final equal-period source precedence", async () => {
  const points = [
    { asOfDate: "2025-12-31", currencyCode: "USD", reportedValue: { raw: 20 } },
    { asOfDate: "2023-12-31", currencyCode: "USD", reportedValue: { raw: 100 } },
    { asOfDate: "2025-12-31", currencyCode: "USD", reportedValue: { raw: 0 } },
    { asOfDate: "2024-12-31", currencyCode: "USD", reportedValue: { raw: 200 } },
  ];
  const raw = [{ meta: { type: ["annualTotalRevenue"] }, annualTotalRevenue: points }];
  const financials = await loadYahooTickerFinancials("PERIOD", {
    providerId: "yahoo", fetchAssetProfile: async () => undefined,
    fetchChart: async () => ({ meta: { currency: "USD", regularMarketPrice: 10 }, history: [{ date: new Date("2026-09-11"), close: 10 }] }),
    fetchExtendedHoursData: async () => ({}), fetchQuoteSupplement: async () => ({}), fetchTimeseries: async () => raw,
  });
  expect(financials.fundamentals?.revenue).toBe(0);
  expect(financials.annualStatements.at(-1)).toMatchObject({ date: "2025-12-31", totalRevenue: 0 });
  expect(points.map(point => point.asOfDate)).toEqual(["2025-12-31", "2023-12-31", "2025-12-31", "2024-12-31"]);
  const invalid = parseYahooTimeseries([{ meta: { type: ["annualTotalRevenue"] }, annualTotalRevenue: [
    { asOfDate: "TTM", reportedValue: { raw: 200 } }, { asOfDate: "2026-02-29", reportedValue: { raw: 300 } },
  ] }]);
  expect(latestYahooMetric(invalid, "annualTotalRevenue")).toBeUndefined();
  expect(latestYahooMetric(invalid, "annualNetIncome")).toBeUndefined();
});


test("Yahoo dated missing latest metrics preserve the period without borrowing old values or coercing zero", async () => {
  for (const missing of [null, undefined, NaN, Infinity, "0"]) {
    const point = (asOfDate: string, raw: unknown) => ({ asOfDate, currencyCode: "USD", reportedValue: { raw } });
    const raw = [
      { meta: { type: ["annualTotalRevenue"] }, annualTotalRevenue: [point("2025-12-31", 123), point("2025-12-31", missing), point("2024-12-31", 200)] },
      { meta: { type: ["annualDilutedEPS"] }, annualDilutedEPS: [point("2024-12-31", 2), point("2025-12-31", missing)] },
      { meta: { type: ["quarterlyTotalRevenue"] }, quarterlyTotalRevenue: [point("2026-06-30", 0), point("2026-03-31", 50)] },
      { meta: { type: ["annualNetIncome"] }, annualNetIncome: [point("2026-02-29", 10), point("TTM", 20)] },
    ];
    const financials = await loadYahooTickerFinancials("PERIOD", {
      providerId: "yahoo", fetchAssetProfile: async () => undefined,
      fetchChart: async () => ({ meta: { currency: "USD", regularMarketPrice: 10 }, history: [{ date: new Date("2026-09-11"), close: 10 }] }),
      fetchExtendedHoursData: async () => ({}), fetchQuoteSupplement: async () => ({}), fetchTimeseries: async () => raw,
    });
    expect(financials.fundamentals?.revenue).toBeUndefined();
    expect(financials.fundamentals?.eps).toBeUndefined();
    expect(financials.fundamentals?.netIncome).toBeUndefined();
    expect(financials.annualStatements.map(row => row.date)).toEqual(["2024-12-31", "2025-12-31"]);
    expect(financials.annualStatements.at(-1)).toMatchObject({ date: "2025-12-31", currency: "USD" });
    expect(financials.annualStatements.at(-1)?.totalRevenue).toBeUndefined();
    expect(financials.annualStatements.at(-1)?.eps).toBeUndefined();
    expect(financials.quarterlyStatements.at(-1)?.totalRevenue).toBe(0);
    expect(JSON.parse(JSON.stringify(financials)).annualStatements.at(-1).totalRevenue).toBeUndefined();
  }
});

test("Yahoo quote measures session moves from the right close when the latest daily row is missing", async () => {
  const now = Math.floor(Date.now() / 1000);
  const hour = 3600;
  let extendedBase: number | undefined;
  const quote = await loadYahooQuote("JNJ", {
    providerId: "yahoo",
    // The row for the session that closed 12 hours ago has not been published yet.
    fetchChart: async () => ({
      meta: {
        currency: "USD", regularMarketPrice: 102, regularMarketTime: now - 12 * hour,
        currentTradingPeriod: {
          pre: { start: now - hour, end: now + hour },
          regular: { start: now + hour, end: now + 8 * hour },
          post: { start: now + 8 * hour, end: now + 12 * hour },
        },
      },
      history: [{ date: new Date((now - 72 * hour) * 1000), close: 100 }, { date: new Date((now - 44 * hour) * 1000), close: 104 }],
    }),
    fetchExtendedHoursData: async (_symbol, _meta, regularClose) => {
      extendedBase = regularClose;
      return {};
    },
    // Yahoo's summary still reports the close before the completed session.
    fetchQuoteSupplement: async () => ({ previousClose: 104 }),
  });
  expect(quote.change).toBeCloseTo(-2, 8);
  expect(quote.changePercent).toBeCloseTo(-2 / 104 * 100, 8);
  expect(quote.marketState).toBe("PRE");
  expect(extendedBase).toBe(102);
});

test("Yahoo quote does not measure the move from two sessions back when the prior session has no close", async () => {
  const day = 86_400_000;
  const today = Date.parse("2026-09-23T13:30:00Z");
  const quote = await loadYahooQuote("XLB", {
    providerId: "yahoo",
    fetchChart: async () => ({
      meta: { currency: "USD", regularMarketPrice: 50.21, regularMarketTime: (today + 3_600_000) / 1000 },
      history: [
        { date: new Date(today - 2 * day), close: 49.71 },
        { date: new Date(today), close: 50.21 },
      ],
      missingCloses: [new Date(today - day)],
    }),
    fetchExtendedHoursData: async () => ({}),
    fetchQuoteSupplement: async () => ({ previousClose: 50.53 }),
  });
  expect(quote.change).toBeCloseTo(50.21 - 50.53, 8);
  expect(quote.changePercent).toBeCloseTo((50.21 - 50.53) / 50.53 * 100, 8);
});

test("Yahoo futures quote measures its move from the current contract's settlement after a roll", async () => {
  const time = Date.parse("2026-09-23T13:04:10Z") / 1000;
  const quote = await loadYahooQuote("SB=F", {
    providerId: "yahoo",
    // The continuous chart's earlier rows are the expiring October contract.
    fetchChart: async () => ({
      meta: { currency: "USD", instrumentType: "FUTURE", regularMarketPrice: 18.76, regularMarketTime: time },
      history: [{ date: new Date("2026-09-22T04:00:00Z"), close: 17.59 }, { date: new Date("2026-09-23T04:00:00Z"), close: 18.76 }],
    }),
    fetchExtendedHoursData: async () => ({}),
    fetchQuoteSupplement: async () => ({ previousClose: 18.56 }),
  });
  expect(quote.previousClose).toBe(18.56);
  expect(quote.change).toBeCloseTo(0.2, 8);
});
