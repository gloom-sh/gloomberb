import { describe, expect, test } from "bun:test";
import type { FinancialStatement, TickerFinancials } from "../types/financials";
import { alignTimeSeries } from "./alignment";
import { extractFredSeries } from "./economic";
import { deriveQuarterlyStatements, extractFundamentalSeries } from "./fundamentals";
import type { ResolvedSeries, SecuritySeriesSource } from "./types";

const DAY = 24 * 60 * 60 * 1_000;

function financials(
  quarterlyStatements: FinancialStatement[],
  annualStatements: FinancialStatement[],
  priceHistory: TickerFinancials["priceHistory"] = [],
): TickerFinancials {
  return { quarterlyStatements, annualStatements, priceHistory };
}

function source(
  fieldId: string,
  period: SecuritySeriesSource["period"] = "quarterly",
): SecuritySeriesSource {
  return {
    kind: "security",
    instrument: { symbol: "TEST" },
    fieldId,
    period,
    timestampMode: "available-at",
  };
}

describe("fundamental series extraction", () => {
  const quarters: FinancialStatement[] = [
    { date: "2024-03-31", availableAt: "2024-05-01", totalRevenue: 10 },
    { date: "2024-06-30", availableAt: "2024-08-01", totalRevenue: 20 },
    { date: "2024-09-30", availableAt: "2024-11-01", totalRevenue: 30 },
  ];
  const annual: FinancialStatement[] = [{
    date: "2024-12-31",
    availableAt: "2025-02-15",
    fieldAvailability: { totalRevenue: "2025-02-15" },
    totalRevenue: 100,
  }];

  test("derives fiscal Q4 from the annual total and carries filing availability", () => {
    const derived = deriveQuarterlyStatements(quarters, annual);
    const q4 = derived.find((statement) => statement.date === "2024-12-31");
    expect(q4?.totalRevenue).toBe(40);
    expect(q4?.availableAt).toBe("2025-02-15");
    expect(q4?.fieldAvailability?.totalRevenue).toBe("2025-02-15");
  });

  test("delays derived Q4 until a later amended input is available", () => {
    const derived = deriveQuarterlyStatements([
      {
        date: "2024-03-31",
        availableAt: "2025-04-01",
        fieldAvailability: { totalRevenue: "2025-04-01" },
        totalRevenue: 11,
      },
      { date: "2024-06-30", availableAt: "2024-08-01", totalRevenue: 20 },
      { date: "2024-09-30", availableAt: "2024-11-01", totalRevenue: 30 },
    ], annual);

    const q4 = derived.find((statement) => statement.date === "2024-12-31");
    expect(q4?.totalRevenue).toBe(39);
    expect(q4?.availableAt).toBe("2025-04-01");
    expect(q4?.fieldAvailability?.totalRevenue).toBe("2025-04-01");
  });

  test("timestamps reported values when they became available, not at period end", () => {
    const points = extractFundamentalSeries(financials(quarters, annual), source("fundamental.totalRevenue"));
    const q4 = points.find((point) => point.periodLabel === "2024 Q4");
    expect(q4?.value).toBe(40);
    expect(q4?.observedAt.toISOString().slice(0, 10)).toBe("2024-12-31");
    expect(q4?.date.toISOString().slice(0, 10)).toBe("2025-02-15");
    expect(q4?.provenance?.quality).toBe("derived");
  });

  test("deduplicates fiscal and calendar rows for the same financial period", () => {
    const points = extractFundamentalSeries(
      financials([
        {
          date: "2025-06-28",
          availableAt: "2025-08-01",
          fieldAvailability: { totalRevenue: "2025-08-01" },
          totalRevenue: 94_036,
        },
        { date: "2025-06-30", totalRevenue: 94_036 },
        {
          date: "2025-09-27",
          availableAt: "2025-10-31",
          fieldAvailability: { totalRevenue: "2025-10-31" },
          totalRevenue: 102_466,
        },
        { date: "2025-09-30", totalRevenue: 102_466 },
      ], []),
      source("fundamental.totalRevenue"),
    );

    expect(points.map((point) => ({
      period: point.periodLabel,
      observedAt: point.observedAt.toISOString().slice(0, 10),
      availableAt: point.availableAt?.toISOString().slice(0, 10),
      value: point.value,
    }))).toEqual([
      {
        period: "2025 Q2",
        observedAt: "2025-06-28",
        availableAt: "2025-08-01",
        value: 94_036,
      },
      {
        period: "2025 Q3",
        observedAt: "2025-09-27",
        availableAt: "2025-10-31",
        value: 102_466,
      },
    ]);
  });

  test("preserves distinct periods that share one publication date", () => {
    const points = extractFundamentalSeries(
      financials([
        {
          date: "2025-03-29",
          availableAt: "2025-08-01",
          fieldAvailability: { totalRevenue: "2025-08-01" },
          totalRevenue: 95_359,
        },
        {
          date: "2025-06-28",
          availableAt: "2025-08-01",
          fieldAvailability: { totalRevenue: "2025-08-01" },
          totalRevenue: 94_036,
        },
      ], []),
      source("fundamental.totalRevenue"),
    );

    expect(points.map((point) => point.periodLabel)).toEqual(["2025 Q1", "2025 Q2"]);
  });

  test("preserves distinct irregular periods within one calendar quarter", () => {
    const points = extractFundamentalSeries(
      financials([
        { date: "2025-04-15", availableAt: "2025-05-01", totalRevenue: 10 },
        { date: "2025-06-30", availableAt: "2025-08-01", totalRevenue: 20 },
      ], []),
      source("fundamental.totalRevenue"),
    );

    expect(points.map((point) => ({
      observedAt: point.observedAt.toISOString().slice(0, 10),
      value: point.value,
    }))).toEqual([
      { observedAt: "2025-04-15", value: 10 },
      { observedAt: "2025-06-30", value: 20 },
    ]);
  });

  test("deduplicates provider period aliases before computing TTM values", () => {
    const points = extractFundamentalSeries(
      financials([
        { date: "2025-03-29", availableAt: "2025-05-02", totalRevenue: 10 },
        { date: "2025-03-31", totalRevenue: 10 },
        { date: "2025-06-28", availableAt: "2025-08-01", totalRevenue: 20 },
        { date: "2025-06-30", totalRevenue: 20 },
        { date: "2025-09-27", availableAt: "2025-10-31", totalRevenue: 30 },
        { date: "2025-09-30", totalRevenue: 30 },
        { date: "2025-12-27", availableAt: "2026-01-30", totalRevenue: 40 },
        { date: "2025-12-31", totalRevenue: 40 },
      ], []),
      source("fundamental.totalRevenue", "ttm"),
    );

    expect(points.map((point) => ({
      period: point.periodLabel,
      value: point.value,
    }))).toEqual([{ period: "TTM 2025 Q4", value: 100 }]);
  });

  test("retains a later disclosed value when a period is actually restated", () => {
    const points = extractFundamentalSeries(
      financials([
        { date: "2025-06-28", availableAt: "2025-08-01", totalRevenue: 94_036 },
        { date: "2025-06-30", availableAt: "2025-08-15", totalRevenue: 95_000 },
      ], []),
      source("fundamental.totalRevenue"),
    );

    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(95_000);
    expect(points[0]?.availableAt?.toISOString().slice(0, 10)).toBe("2025-08-15");
  });

  test("retains a later restatement with the same period-end date", () => {
    const points = extractFundamentalSeries(
      financials([
        { date: "2025-06-30", availableAt: "2025-08-01", totalRevenue: 94_036 },
        { date: "2025-06-30", availableAt: "2025-08-15", totalRevenue: 95_000 },
      ], []),
      source("fundamental.totalRevenue"),
    );

    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(95_000);
    expect(points[0]?.availableAt?.toISOString().slice(0, 10)).toBe("2025-08-15");
  });

  test("selects restatements by the changed field's own disclosure date", () => {
    const points = extractFundamentalSeries(
      financials([
        {
          date: "2025-06-28",
          fieldAvailability: {
            totalRevenue: "2025-08-01",
            netIncome: "2025-09-01",
          },
          totalRevenue: 94_036,
          netIncome: 20_000,
        },
        {
          date: "2025-06-30",
          fieldAvailability: {
            totalRevenue: "2025-08-15",
            netIncome: "2025-07-01",
          },
          totalRevenue: 95_000,
          netIncome: 20_000,
        },
      ], []),
      source("fundamental.totalRevenue"),
    );

    expect(points[0]?.value).toBe(95_000);
    expect(points[0]?.availableAt?.toISOString().slice(0, 10)).toBe("2025-08-15");
  });

  test("retains a restored value at its latest disclosure date", () => {
    const points = extractFundamentalSeries(
      financials([
        { date: "2025-06-28", availableAt: "2025-07-15", totalRevenue: 95_000 },
        { date: "2025-06-29", availableAt: "2025-06-15", totalRevenue: 96_000 },
        { date: "2025-06-30", availableAt: "2025-05-15", totalRevenue: 95_000 },
      ], []),
      source("fundamental.totalRevenue"),
    );

    expect(points[0]?.value).toBe(95_000);
    expect(points[0]?.availableAt?.toISOString().slice(0, 10)).toBe("2025-07-15");
  });

  test("keeps reported provenance when a derived period alias has the same value", () => {
    const points = extractFundamentalSeries(
      financials([
        { date: "2025-03-29", availableAt: "2025-05-02", totalRevenue: 10 },
        { date: "2025-06-28", availableAt: "2025-08-01", totalRevenue: 20 },
        { date: "2025-09-27", availableAt: "2025-10-31", totalRevenue: 30 },
        { date: "2025-12-27", availableAt: "2026-01-30", totalRevenue: 40 },
      ], [{
        date: "2025-12-31",
        availableAt: "2026-02-15",
        totalRevenue: 100,
      }]),
      source("fundamental.totalRevenue"),
    );

    expect(points.at(-1)).toMatchObject({
      value: 40,
      provenance: { quality: "reported" },
    });
  });

  test("builds TTM flow values from four discrete quarters", () => {
    const points = extractFundamentalSeries(
      financials(quarters, annual),
      source("fundamental.totalRevenue", "ttm"),
    );
    expect(points).toHaveLength(1);
    expect(points[0]?.value).toBe(100);
    expect(points[0]?.periodLabel).toBe("TTM 2024 Q4");
    expect(points[0]?.date.toISOString().slice(0, 10)).toBe("2025-02-15");
  });

  test("does not carry a newly derived quarter before its filing date", () => {
    const points = extractFundamentalSeries(financials(quarters, annual), source("fundamental.totalRevenue"));
    const series: ResolvedSeries = {
      id: "revenue",
      label: "Revenue",
      color: "#fff",
      unit: "currency",
      unitGroup: "currency-total",
      nativeFrequency: "quarterly",
      dataShape: "scalar",
      style: "step",
      transform: "raw",
      axis: "right",
      panelId: "main",
      interpolation: "step-after",
      points,
    };
    const rows = alignTimeSeries([series], {
      timeline: [new Date("2025-01-15T00:00:00Z"), new Date("2025-02-15T00:00:00Z")],
    });
    expect(rows[0]?.values.revenue?.value).toBe(30);
    expect(rows[0]?.values.revenue?.point.periodLabel).toBe("2024 Q3");
    expect(rows[1]?.values.revenue?.value).toBe(40);
    expect(rows[1]?.values.revenue?.carried).toBe(false);
  });

  test("uses field availability without letting unrelated later row fields delay revenue", () => {
    const points = extractFundamentalSeries(
      financials([], [{
        date: "2024-12-31",
        availableAt: "2025-04-01",
        fieldAvailability: {
          totalRevenue: "2025-02-01",
          totalDebt: "2025-04-01",
        },
        totalRevenue: 100,
        totalDebt: 25,
      }]),
      source("fundamental.totalRevenue", "annual"),
    );

    expect(points[0]?.date.toISOString().slice(0, 10)).toBe("2025-02-01");
    expect(points[0]?.availableAt?.toISOString().slice(0, 10)).toBe("2025-02-01");
  });

  test("falls back to row availability only for a dependency without field provenance", () => {
    const points = extractFundamentalSeries(
      financials([], [{
        date: "2024-12-31",
        availableAt: "2025-04-01",
        fieldAvailability: { grossProfit: "2025-02-01" },
        grossProfit: 40,
        totalRevenue: 100,
      }]),
      source("fundamental.grossMargin", "annual"),
    );

    expect(points[0]?.value).toBe(40);
    expect(points[0]?.date.toISOString().slice(0, 10)).toBe("2025-04-01");
  });

  test("tracks only the EPS branch actually used by historical PE", () => {
    const points = extractFundamentalSeries(
      financials([], [{
        date: "2024-12-31",
        availableAt: "2025-04-01",
        fieldAvailability: {
          eps: "2025-02-01",
          netIncome: "2025-04-01",
          dilutedShares: "2025-04-01",
        },
        eps: 5,
        netIncome: 50,
        dilutedShares: 10,
      }], [{ date: new Date("2024-12-31T00:00:00Z"), close: 100 }]),
      source("valuation.trailingPE", "annual"),
    );

    expect(points[0]?.value).toBe(20);
    expect(points[0]?.date.toISOString().slice(0, 10)).toBe("2025-02-01");
  });

  test("deduplicates annual provider aliases before calculating valuation points", () => {
    const points = extractFundamentalSeries(
      financials([], [
        { date: "2024-12-28", availableAt: "2025-02-01", eps: 5 },
        { date: "2024-12-31", eps: 5 },
      ], [
        { date: new Date("2024-12-28T00:00:00Z"), close: 100 },
        { date: new Date("2024-12-31T00:00:00Z"), close: 101 },
      ]),
      source("valuation.trailingPE", "annual"),
    );

    expect(points).toHaveLength(1);
    expect(points[0]?.periodLabel).toBe("FY2024");
    expect(points[0]?.value).toBe(20.2);
  });

  test("prices historical multiples when all of their inputs became public", () => {
    const statement: FinancialStatement = {
      date: "2024-12-31",
      availableAt: "2025-02-10",
      fieldAvailability: {
        eps: "2025-02-10",
        totalRevenue: "2025-02-10",
        ebitda: "2025-02-10",
        freeCashFlow: "2025-02-10",
        basicShares: "2025-02-10",
        totalDebt: "2025-02-10",
        cashAndCashEquivalents: "2025-02-10",
      },
      eps: 5,
      totalRevenue: 100,
      ebitda: 25,
      freeCashFlow: 20,
      basicShares: 10,
      totalDebt: 50,
      cashAndCashEquivalents: 20,
    };
    const snapshot = financials([], [statement], [
      { date: new Date("2024-12-31T00:00:00Z"), close: 100 },
      { date: new Date("2025-02-09T00:00:00Z"), close: 200 },
      // This close was not public yet at the midnight filing timestamp.
      { date: new Date("2025-02-10T16:00:00Z"), close: 300 },
    ]);
    const expected = new Map([
      ["valuation.trailingPE", 40],
      ["valuation.priceSales", 20],
      ["valuation.evSales", 20.3],
      ["valuation.evEbitda", 81.2],
      ["valuation.priceFcf", 100],
    ]);

    for (const [fieldId, value] of expected) {
      const [point] = extractFundamentalSeries(snapshot, source(fieldId, "annual"));
      expect(point?.value).toBeCloseTo(value, 10);
      expect(point?.date.toISOString()).toBe("2025-02-10T00:00:00.000Z");
    }
  });

  test("falls back to annual valuation inputs when no usable TTM denominator exists", () => {
    const quarterly = [
      ["2024-03-31", "2024-05-01"],
      ["2024-06-30", "2024-08-01"],
      ["2024-09-30", "2024-11-01"],
      ["2024-12-31", "2025-02-01"],
    ].map(([date, availableAt], index): FinancialStatement => ({
      date: date!,
      availableAt,
      totalRevenue: 100 + index,
      basicShares: 10,
    }));
    const snapshot: TickerFinancials = {
      ...financials(quarterly, [{
        date: "2024-12-31",
        availableAt: "2025-02-10",
        ebitda: 50,
        basicShares: 10,
        totalDebt: 50,
        cashAndCashEquivalents: 20,
      }], [{ date: new Date("2025-02-09T00:00:00Z"), close: 90 }]),
      quote: {
        symbol: "TEST",
        price: 100,
        currency: "USD",
        change: 0,
        changePercent: 0,
        lastUpdated: Date.parse("2025-03-01T16:00:00Z"),
      },
    };

    const points = extractFundamentalSeries(snapshot, source("valuation.evEbitda"));
    expect(points.at(-1)).toMatchObject({
      value: 20.6,
      periodLabel: "Current",
      provenance: { quality: "derived" },
    });
  });

  test("enterprise-value multiples require known debt and cash, while explicit zeros remain valid", () => {
    const statement: FinancialStatement = {
      date: "2024-12-31",
      availableAt: "2025-02-01",
      totalRevenue: 100,
      ebitda: 25,
      basicShares: 10,
      totalDebt: 0,
      cashAndCashEquivalents: 0,
    };
    const snapshot = (row: FinancialStatement): TickerFinancials => ({
      ...financials([], [row], [{ date: new Date("2025-01-31T00:00:00Z"), close: 100 }]),
      quote: { symbol: "TEST", price: 100, currency: "USD", change: 0, changePercent: 0,
        lastUpdated: Date.parse("2025-03-01T16:00:00Z") },
    });
    for (const [field, expected] of [["valuation.evSales", 10], ["valuation.evEbitda", 40]] as const) {
      const known = extractFundamentalSeries(snapshot(statement), source(field, "annual"));
      expect(known.map((point) => point.value)).toEqual([expected, expected]);
      for (const missing of ["totalDebt", "cashAndCashEquivalents"] as const) {
        expect(extractFundamentalSeries(snapshot({ ...statement, [missing]: undefined }), source(field, "annual"))).toEqual([]);
        expect(extractFundamentalSeries(snapshot({ ...statement, [missing]: Number.NaN }), source(field, "annual"))).toEqual([]);
      }
    }
    // Missing EV inputs must not disable a market-cap-based ratio.
    expect(extractFundamentalSeries(snapshot({ ...statement, totalDebt: undefined }), source("valuation.priceSales", "annual"))
      .map((point) => point.value)).toEqual([10, 10]);
  });

  test("tracks the selected share and cash alternatives for enterprise value", () => {
    const points = extractFundamentalSeries(
      financials([], [{
        date: "2024-12-31",
        availableAt: "2025-04-01",
        fieldAvailability: {
          totalRevenue: "2025-02-01",
          basicShares: "2025-02-10",
          totalDebt: "2025-02-20",
          cashCashEquivalentsAndShortTermInvestments: "2025-02-15",
          cashAndCashEquivalents: "2025-04-01",
          ordinarySharesNumber: "2025-04-01",
        },
        totalRevenue: 100,
        basicShares: 10,
        ordinarySharesNumber: 12,
        totalDebt: 50,
        cashCashEquivalentsAndShortTermInvestments: 20,
        cashAndCashEquivalents: 30,
      }], [{ date: new Date("2024-12-31T00:00:00Z"), close: 100 }]),
      source("valuation.evSales", "annual"),
    );

    expect(points[0]?.value).toBe(10.3);
    expect(points[0]?.date.toISOString().slice(0, 10)).toBe("2025-02-20");
  });
});

describe("economic vintage extraction", () => {
  test("uses a vintage availability date while retaining the observation period", () => {
    const [point] = extractFredSeries([{
      date: "2024-01-01",
      value: "123.4",
      realtime_start: "2024-02-10",
    }]);
    expect(point?.observedAt.toISOString().slice(0, 10)).toBe("2024-01-01");
    expect(point?.availableAt?.toISOString().slice(0, 10)).toBe("2024-02-10");
    expect(point?.date.toISOString().slice(0, 10)).toBe("2024-02-10");
    expect(point?.value).toBe(123.4);
  });
});


test("financial chart TTM rejects missing quarters and inconsistent reporting currencies", () => {
  for (const rows of [
    ["2024-09-30", "2025-03-31", "2025-06-30", "2025-09-30"].map((date) => ({ date, totalRevenue: 100 })),
    ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"].map((date, index) => ({ date, totalRevenue: 100, currency: index === 0 ? "USD" : "TWD" })),
  ]) {
    expect(extractFundamentalSeries(financials(rows, []), source("fundamental.totalRevenue", "ttm"))).toEqual([]);
  }
});

test("quarterly share averages derive from the annual average instead of copying it", () => {
  const rows = deriveQuarterlyStatements([
    { date: "2025-03-31", basicShares: 100 },
    { date: "2025-06-30", basicShares: 90 },
    { date: "2025-09-30", basicShares: 80 },
  ], [{ date: "2025-12-31", basicShares: 85 }]);
  expect(rows.at(-1)?.basicShares).toBe(70);
});
