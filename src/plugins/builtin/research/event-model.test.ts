import { describe, expect, test } from "bun:test";
import type { AnalystResearchData } from "../../../types/financials";
import { buildEventRows, eventSourceNotice, formatEventMetric } from "./event-model";

test("ADR reported EPS and company revenue keep their distinct currencies", () => {
  const rows = buildEventRows({ symbol: "TSM", currency: "USD", dividends: [], splits: [],
    earnings: [{ date: "2025-12-31", dateType: "fiscal-period-end", epsActual: 2.5, currency: "USD" }],
  }, null, { financialCurrency: "TWD", quarterlyStatements: [
    { date: "2025-12-31", currency: "TWD", totalRevenue: 1000000000000, eps: 15 },
  ] }, "USD");
  expect(rows[0]).toMatchObject({ qEps: 2.5, qRevenue: 1000000000000, epsCurrency: "USD", revenueCurrency: "TWD" });
  expect(formatEventMetric(rows[0]?.qEps, rows[0]?.epsCurrency, "eps")).toBe("2.50 USD");
  expect(formatEventMetric(rows[0]?.qRevenue, rows[0]?.revenueCurrency, "revenue")).toBe("1T TWD");
});

test("pending RIVN earnings show consensus without borrowing prior-quarter actuals", () => {
  const [row] = buildEventRows({ symbol: "RIVN", currency: "USD", dividends: [], splits: [],
    earnings: [{ date: "2026-11-03", dateType: "announcement", epsEstimate: -0.73, currency: "USD", time: "AMC" }],
  }, null, { quarterlyStatements: [{ date: "2026-06-30", currency: "USD", eps: -0.63, totalRevenue: 1_658_000_000 }] }, "USD");
  expect(row).toMatchObject({ date: "2026-11-03", period: "AMC", detail: "Pending", qEps: -0.73, epsCurrency: "USD" });
  expect(row?.qRevenue).toBeUndefined();
  expect(row?.revenueCurrency).toBeUndefined();
});

test("same-day announcements and fiscal periods retain independent detail identities", () => {
  const actions = { symbol: "TEST", dividends: [], splits: [], earnings: [
    { date: "2026-09-30", dateType: "announcement" as const, epsEstimate: 2.2 },
    { date: "2026-09-30", dateType: "fiscal-period-end" as const, epsActual: 2, epsEstimate: 1.8 },
  ] };
  const rows = buildEventRows(actions, null, null, "USD");
  const reported = rows.find((row) => row.earningsState === "reported")!;
  const pending = rows.find((row) => row.earningsState === "pending")!;
  expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  // Detail lookup uses the selected row's id; it must not resolve to the announcement.
  expect(rows.find((row) => row.id === reported.id)).toMatchObject({ epsActual: 2, epsEstimate: 1.8 });
  expect(rows.find((row) => row.id === pending.id)).toMatchObject({ earningsState: "pending", epsEstimate: 2.2 });
  const reordered = buildEventRows({ ...actions, earnings: [...actions.earnings].reverse() }, null, null, "USD");
  expect(reordered.find((row) => row.earningsState === "reported")?.id).toBe(reported.id);
  expect(reordered.find((row) => row.earningsState === "pending")?.id).toBe(pending.id);
});

test("multiple reported records and exact duplicates retain unique same-provenance identities", () => {
  const first = { date: "2026-09-30", dateType: "announcement" as const, epsActual: 2, epsEstimate: 1.8 };
  const second = { ...first, epsActual: 3, epsEstimate: 2.7 };
  for (const dateType of ["announcement", "fiscal-period-end", undefined] as const) {
    const actions = { symbol: "TEST", dividends: [], splits: [], earnings: [first, second, first].map((earning) => ({ ...earning, dateType })) };
    const rows = buildEventRows(actions, null, null, "USD");
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    const selected = rows.find((row) => row.epsActual === 3)!;
    expect(rows.find((row) => row.id === selected.id)?.epsEstimate).toBe(2.7);
    const reordered = buildEventRows({ ...actions, earnings: [actions.earnings[1]!, actions.earnings[2]!, actions.earnings[0]!] }, null, null, "USD");
    expect(reordered.find((row) => row.id === selected.id)?.epsActual).toBe(3);
    expect(new Set(reordered.map((row) => row.id))).toEqual(new Set(rows.map((row) => row.id)));
    expect(rows.every((row) => row.fiscalPeriodEnd === undefined)).toBe(true);
  }
});

test("ADRs keep independent consensus EPS and revenue currencies and never infer missing ones", () => {
  const rows = buildEventRows(null, { symbol: "TSM", currency: "USD", recommendations: [], ratings: [],
    earningsEstimates: [{ date: "2026-09-30", period: "current_quarter", average: 4.46, currency: "USD" }],
    revenueEstimates: [{ date: "2026-09-30", period: "current_quarter", average: 1.454e12, currency: "TWD" },
      { date: "2026-12-31", period: "next_quarter", average: 1.6e12 }],
  }, null, "USD");
  expect(rows.find((row) => row.date === "2026-09-30")).toMatchObject({ epsCurrency: "USD", revenueCurrency: "TWD" });
  expect(rows.find((row) => row.date === "2026-12-31")?.revenueCurrency).toBeUndefined();
});

test("quarterly consensus for a quarter that already has a reported row is dropped", () => {
  // REF in Sep 2026: Gloom still served the reported June quarter as 0q; SEC re-dated the statement to 06-27.
  const rows = buildEventRows({ symbol: "REF", dividends: [], splits: [], earnings: [
    { date: "2026-11-10", dateType: "announcement", time: "AMC" },
    { date: "2026-06-30", dateType: "fiscal-period-end", currency: "USD", epsActual: 0.2393, epsEstimate: 0.22282 },
  ] }, { symbol: "REF", recommendations: [], ratings: [],
    earningsEstimates: [
      { date: "2026-06-30", period: "current quarter", average: 0.22282, currency: "USD" },
      { date: "2026-12-31", period: "next quarter", average: 0.17, currency: "USD" },
      { date: "2026-12-31", period: "current year", average: 0.53, currency: "USD" },
    ],
    revenueEstimates: [{ date: "2026-06-30", period: "current quarter", average: 154_430_000, currency: "USD" }],
  }, { quarterlyStatements: [{ date: "2026-06-27", providerDate: "2026-06-30", dateSource: "sec", totalRevenue: 155_230_000 }] }, "USD");
  expect(rows.filter((row) => row.status === "Q Est").map((row) => row.period)).toEqual(["next qtr"]);
  expect(rows.some((row) => row.status === "FY Est")).toBe(true);
});

test("split direction and fractional historical dividends remain faithful to the event", () => {
  const rows = buildEventRows({ symbol: "NVDA", currency: "USD", earnings: [],
    dividends: [{ exDate: "2024-03-05", amount: 0.004 }],
    splits: [{ date: "2024-06-10", fromFactor: 1, toFactor: 10 }, { date: "2023-01-01", fromFactor: 20, toFactor: 1 }],
  }, null, null, "USD");
  expect(rows.map((row) => row.value)).toEqual(["10:1", "$0.004", "1:20"]);
});

test("fiscal period ends stay labeled and unknown EPS currency stays unknown", () => {
  const [row] = buildEventRows({ symbol: "COST", currency: "USD", dividends: [], splits: [],
    earnings: [{ date: "2026-05-31", dateType: "fiscal-period-end", epsActual: 4.93, difference: 0.01 }],
  }, null, null, "USD");
  expect(row).toMatchObject({ dateType: "fiscal-period-end", detail: "Period end; +0.01 vs est" });
  expect(row?.epsCurrency).toBeUndefined();
});

test("an upcoming report takes the currency its reported quarters agree on", () => {
  const earnings = [
    { date: "2026-10-28", epsEstimate: 4.72 },
    { date: "2026-06-30", dateType: "fiscal-period-end" as const, epsActual: 4.74, currency: "USD" },
  ];
  const pending = (feed: typeof earnings) => buildEventRows({ symbol: "MSFT", currency: "USD", dividends: [], splits: [], earnings: feed }, null, null, "USD")
    .find((row) => row.earningsState === "pending");
  expect(pending(earnings)?.epsCurrency).toBe("USD");
  expect(pending([...earnings, { date: "2026-03-31", dateType: "fiscal-period-end", epsActual: 4.27, currency: "EUR" }])?.epsCurrency).toBeUndefined();
});

test("partial and stale corporate data are not described as an empty event history", () => {
  const notice = eventSourceNotice({ variant: "corporate-actions", symbol: "RIVN", actionsError: null, estimatesError: null, estimates: null,
    actions: { symbol: "RIVN", dividends: [], splits: [], earnings: [], coverage: { earnings: "unavailable", dividends: "available" }, stale: true },
  });
  expect(notice).toEqual({ text: "Unavailable: earnings   Corporate actions stale", failed: true });
});

test("EE ignores dividends, adjustments and pending announcements when assessing reported earnings coverage", () => {
  const state = { variant: "earnings-estimates" as const, symbol: "TEST", actionsError: null, estimatesError: null, estimates: null,
    actions: { symbol: "TEST", dividends: [{ exDate: "2026-09-30", amount: 0.1 }],
      splits: [{ date: "2026-09-30", fromFactor: 10, toFactor: 1 }],
      earnings: [{ date: "2026-09-30", dateType: "announcement" as const, epsEstimate: 2.2 }],
    },
  };
  expect(eventSourceNotice(state)).toEqual({ text: "No reported earnings for TEST", failed: false });
  expect(eventSourceNotice({ ...state, variant: "corporate-actions" })).toBeNull();
  expect(eventSourceNotice({ ...state, actions: { ...state.actions,
    earnings: [{ ...state.actions.earnings[0]!, epsActual: 0 }],
  } })).toBeNull();
  expect(eventSourceNotice({ ...state, actions: { ...state.actions,
    coverage: { earnings: "unavailable" },
  } })).toEqual({ text: "Unavailable: earnings", failed: true });
});

test("period aliases retain exact filing provenance and raw surprise inputs", () => {
  const evidence = { accessionNumber: "0000909832-26-000051", filed: "2026-06-03", startDate: "2026-02-16" };
  const [row] = buildEventRows({ symbol: "COST", providerId: "gloom", dividends: [], splits: [], earnings: [
    { date: "2026-05-31", dateType: "fiscal-period-end", epsActual: 4.93, epsEstimate: 4.9231, difference: 0.0069, surprisePercent: 0.14 },
  ] }, null, { quarterlyStatements: [{ date: "2026-05-10", providerDate: "2026-05-31", dateSource: "sec", dateEvidence: evidence, totalRevenue: 70_527_000_000, currency: "USD" }] }, "USD");
  expect(row).toMatchObject({ date: "2026-05-10", providerPeriodDate: "2026-05-31", fiscalPeriodEnd: "2026-05-10", period: "May 2026", dateEvidence: evidence,
    qRevenue: 70_527_000_000, epsEstimate: 4.9231, epsActual: 4.93, epsDifference: 0.0069, surprisePercent: 0.14, epsBasis: "provider-unspecified" });
});

test("missing or ambiguous fiscal periods and announcements cannot borrow a previous quarter's revenue", () => {
  const actions = { symbol: "TEST", dividends: [], splits: [], earnings: [
    { date: "2026-06-30", dateType: "fiscal-period-end" as const, epsActual: 2 },
    { date: "2026-08-01", dateType: "announcement" as const, epsActual: 2 },
  ] };
  for (const statements of [
    [{ date: "2026-03-31", totalRevenue: 100 }],
    [{ date: "2026-06-28", providerDate: "2026-06-30", totalRevenue: 100 }, { date: "2026-06-30", totalRevenue: 200 }],
  ]) {
    expect(buildEventRows(actions, null, { quarterlyStatements: statements }, "USD").every((row) => row.qRevenue == null)).toBe(true);
  }
});

test("spinoff adjustment factors are not presented as verified share splits", () => {
  const [row] = buildEventRows({ symbol: "GE", earnings: [], dividends: [],
    splits: [{ date: "2024-04-02", fromFactor: 1000, toFactor: 1253, description: "1253:1000 split" }],
  }, null, null, "USD");
  expect(row).toMatchObject({ status: "Factor", value: "1253:1000", adjustmentFactor: 1.253,
    detail: "Split/adjustment", providerDescription: "1253:1000 split" });
  expect(row?.qEps).toBeUndefined();

});

describe("event rows", () => {
  test("combines EPS and revenue estimates into one estimate row", () => {
    const rows = buildEventRows(null, {
      symbol: "AAPL",
      recommendations: [],
      ratings: [],
      earningsEstimates: [
        { date: "2026-06-30", period: "next_quarter", average: 1.5, analysts: 22 },
      ],
      revenueEstimates: [
        { date: "2026-06-30", period: "next_quarter", average: 100_000_000, analysts: 18, growth: 0.12 },
      ],
    } satisfies AnalystResearchData, null, "USD");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: "2026-06-30",
      status: "Q Est",
      period: "next qtr",
      detail: "22 EPS / 18 rev analysts",
      qEps: 1.5,
      qRevenue: 100_000_000,
      annualEps: undefined,
      annualRevenue: undefined,
      value: "+12.00%",
      tone: "positive",
    });
  });

  test("puts fiscal estimates in annual columns", () => {
    const rows = buildEventRows(null, {
      symbol: "AAPL",
      recommendations: [],
      ratings: [],
      earningsEstimates: [
        { date: "2026-12-31", period: "current_year", average: 7.5, analysts: 24 },
      ],
      revenueEstimates: [
        { date: "2026-12-31", period: "current_year", average: 410_000_000_000, analysts: 21 },
      ],
    } satisfies AnalystResearchData, null, "USD");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "FY Est",
      period: "cur yr",
      qEps: undefined,
      qRevenue: undefined,
      annualEps: 7.5,
      annualRevenue: 410_000_000_000,
    });
  });

  test("keeps revenue-only estimates as estimate rows", () => {
    const rows = buildEventRows(null, {
      symbol: "AAPL",
      recommendations: [],
      ratings: [],
      earningsEstimates: [],
      revenueEstimates: [
        { date: "2026-03-31", period: "current_quarter", average: 95_000_000, analysts: 12 },
      ],
    } satisfies AnalystResearchData, null, "USD");

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "Q Est",
      period: "cur qtr",
      detail: "12 rev analysts",
      qEps: undefined,
      qRevenue: 95_000_000,
    });
  });

  test("adds reported quarterly revenue and TTM without mixing metric columns", () => {
    const actions = {
      symbol: "AAPL",
      dividends: [],
      splits: [],
      earnings: [
        { date: "2026-03-31", dateType: "fiscal-period-end" as const, epsActual: 1.24, surprisePercent: 4.2 },
      ],
    };
    const financials = {
      quarterlyStatements: [
        { date: "2025-06-30", totalRevenue: 80, eps: 1 },
        { date: "2025-09-30", totalRevenue: 90, eps: 1.1 },
        { date: "2025-12-31", totalRevenue: 100, eps: 1.2 },
        { date: "2026-03-31", totalRevenue: 110, eps: 1.3 },
      ],
    };
    const rows = buildEventRows(actions, null, financials, "USD");

    const earnings = rows.find((row) => row.status === "Earnings" && row.date === "2026-03-31");
    const ttm = rows.find((row) => row.status === "TTM");

    expect(earnings).toMatchObject({
      status: "Earnings",
      period: "Mar 2026",
      qEps: 1.24,
      qRevenue: 110,
    });
    expect(earnings?.annualEps).toBeUndefined();
    expect(earnings?.annualRevenue).toBeUndefined();
    expect(ttm).toMatchObject({
      date: "2026-03-31",
      status: "TTM",
      period: "4 qtrs",
      annualEps: 4.6,
      annualRevenue: 380,
    });
    expect(ttm?.qEps).toBeUndefined();
    expect(ttm?.qRevenue).toBeUndefined();
  });

  test("sums the reported quarter EPS shown above the TTM row instead of statement GAAP EPS", () => {
    // UNH: reported (adjusted) 2.92, 2.11, 7.23, 6.38 against GAAP 2.59, 0.02, 6.90, 6.04.
    const reported = [["2025-09-30", 2.92], ["2025-12-31", 2.11], ["2026-03-31", 7.23], ["2026-06-30", 6.38]] as const;
    const actions = {
      symbol: "UNH",
      dividends: [],
      splits: [],
      earnings: [
        { date: "2026-10-13", dateType: "announcement" as const, epsEstimate: 4.15 },
        ...reported.map(([date, epsActual]) => ({ date, dateType: "fiscal-period-end" as const, currency: "USD", epsActual })),
      ],
    };
    const financials = {
      financialCurrency: "USD",
      quarterlyStatements: [["2025-06-30", 4.08], ["2025-09-30", 2.59], ["2025-12-31", 0.02], ["2026-03-31", 6.9], ["2026-06-30", 6.04]]
        .map(([date, eps]) => ({ date: date as string, eps: eps as number, totalRevenue: 100 })),
    };
    const ttm = () => buildEventRows(actions, null, financials, "USD").find((row) => row.status === "TTM");
    expect(ttm()?.annualEps).toBeCloseTo(18.64, 10);
    expect(ttm()).toMatchObject({ date: "2026-06-30", epsCurrency: "USD", annualRevenue: 400, detail: "sum" });

    // A quarter without its reported row cannot be summed from the rows, so the statement TTM
    // stays and is not labelled as their sum (ADBE: Gloom omitted two of the last four quarters).
    actions.earnings.splice(1, 1);
    expect(ttm()?.annualEps).toBeCloseTo(15.55, 10);
    expect(ttm()?.detail).toBe("statement EPS");
  });

  test("omits a TTM row when a flow metric is missing from one of the last four quarters", () => {
    const rows = buildEventRows(null, null, {
      quarterlyStatements: [
        { date: "2025-06-30", totalRevenue: 80, eps: 1 },
        { date: "2025-09-30", totalRevenue: 90 },
        { date: "2025-12-31", totalRevenue: 100, eps: 1.2 },
        { date: "2026-03-31", totalRevenue: 110, eps: 1.3 },
      ],
    }, "USD");

    expect(rows.find((row) => row.status === "TTM")?.annualEps).toBeUndefined();
    expect(rows.find((row) => row.status === "TTM")?.annualRevenue).toBe(380);
  });

  test("keeps dividends and splits in the event table without metric values", () => {
    const data = {
      symbol: "AAPL",
      dividends: [{ exDate: "2026-02-10", amount: 0.26 }],
      splits: [{ date: "2025-12-01", description: "4-for-1 split", fromFactor: 1, toFactor: 4 }],
      earnings: [{ date: "2026-01-30", epsActual: 2.4 }],
    };

    const rows = buildEventRows(data, null, null, "USD");

    expect(rows.map((row) => row.id)).toEqual([
      "div:2026-02-10",
      "earn:2026-01-30",
      "split:2025-12-01:4-for-1 split",
    ]);
    expect(rows).toMatchObject([
      { id: "div:2026-02-10", status: "Dividend", value: "$0.26" },
      { id: "earn:2026-01-30", status: "Earnings" },
      { id: "split:2025-12-01:4-for-1 split", status: "Factor", value: "4:1" },
    ]);
    expect(rows[0]?.qEps).toBeUndefined();
    expect(rows[0]?.annualEps).toBeUndefined();
    expect(rows[2]?.qEps).toBeUndefined();
    expect(rows[2]?.annualEps).toBeUndefined();
  });
});

describe("event source notice", () => {
  const loaded = {
    variant: "corporate-actions" as const,
    symbol: "DBK",
    actions: { symbol: "DBK", dividends: [{ exDate: "2026-05-29", amount: 1 }], splits: [], earnings: [] },
    actionsError: null,
    estimates: {
      symbol: "DBK",
      recommendations: [],
      ratings: [],
      earningsEstimates: [{ date: "2026-12-31", period: "current_year", average: 3.3, analysts: 10 }],
      revenueEstimates: [],
    } satisfies AnalystResearchData,
    estimatesError: null,
  };

  test("stays quiet when both sources delivered", () => {
    expect(eventSourceNotice(loaded)).toBeNull();
  });

  /**
   * A failed corporate-actions request left the table showing only estimate and
   * TTM rows, which reads as a working pane for a company with no events.
   */
  test("names a failed source and marks it as a failure", () => {
    expect(eventSourceNotice({ ...loaded, actions: null, actionsError: "Cloud request failed" })).toEqual({
      text: "Corporate actions unavailable: Cloud request failed",
      failed: true,
    });
  });

  test("reports genuinely empty data without calling it a failure", () => {
    expect(eventSourceNotice({
      ...loaded,
      actions: { symbol: "DBK", dividends: [], splits: [], earnings: [] },
    })).toEqual({
      text: "No dividends, splits, or reported earnings for DBK",
      failed: false,
    });
  });
});
