import { describe, expect, test } from "bun:test";
import type { AnalystResearchData } from "../../../types/financials";
import { buildEventRows, eventSourceNotice, formatEventMetric, type EventFinancials } from "./event-model";

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
  expect(row).toMatchObject({ date: "2026-11-03", period: "-", reportTime: "AMC", detail: "Pending, AMC", qEps: -0.73, epsCurrency: "USD" });
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
  expect(row).toMatchObject({ dateType: "fiscal-period-end", detail: "Period end; basis unknown, +0.01 vs est" });
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
    qRevenue: 70_527_000_000, epsEstimate: 4.9231, epsActual: 4.93, epsDifference: 0.0069, surprisePercent: 0.14, epsBasis: "unknown" });
});

test("a resolved quarter shows ERN's figure, basis and fiscal quarter, and a pending report its date status and analysts", () => {
  // CRWV as Gloom Cloud resolves it: the calendar's figures, labelled against the 10-Q diluted EPS.
  const quarter = (date: string, fiscalPeriod: string, epsEstimate: number, epsActual: number) => ({
    date, dateType: "announcement" as const, currency: "USD", time: "After Hours", fiscalPeriod, epsEstimate, epsActual,
    difference: Math.round((epsActual - epsEstimate) * 100) / 100, epsBasis: "adjusted" as const, dateStatus: "reported" as const,
  });
  const rows = buildEventRows({ symbol: "CRWV", dividends: [], splits: [], earnings: [
    { date: "2026-11-09", dateType: "announcement", currency: "USD", fiscalPeriod: "2026-09", epsEstimate: -1.52697, epsAnalysts: 18,
      epsBasis: null, dateStatus: "projected" },
    quarter("2026-08-11", "2026-06", -1.52, -1.32), quarter("2026-05-07", "2026-03", -1.17, -1.38),
    quarter("2026-02-26", "2025-12", -0.61, -0.84), quarter("2025-11-10", "2025-09", -0.54, -0.31),
  ] }, null, { financialCurrency: "USD", quarterlyStatements: [["2025-09-30", -0.22], ["2025-12-31", -0.89], ["2026-03-31", -1.4], ["2026-06-30", -1.14]]
    .map(([date, eps]) => ({ date: date as string, eps: eps as number, totalRevenue: 2e9 })) }, "USD");
  expect(rows.find((row) => row.date === "2026-08-11")).toMatchObject({ period: "Jun 2026", qEps: -1.32, qRevenue: 2e9, epsBasis: "adjusted",
    detail: "adj, +0.20 vs est", value: "+13.16%", tone: "positive", fiscalPeriodEnd: "2026-06-30" });
  expect(rows.find((row) => row.date === "2026-11-09")).toMatchObject({ earningsState: "pending", qEps: -1.52697, epsAnalysts: 18,
    dateStatus: "projected", detail: "projected, 18 analysts" });
  // With no trailing figure served, the TTM row is the statements' diluted EPS; all four quarters above it
  // are adjusted, so their sum is the one thing it may add beside it.
  const ttm = rows.find((row) => row.status === "TTM");
  expect(ttm?.annualEps).toBeCloseTo(-3.65, 10);
  expect(ttm).toMatchObject({ epsBasis: "GAAP", detail: "GAAP diluted (statements), adj sum -3.85" });
});

test("an earnings row's period is its fiscal quarter, never the time of day; a report not out yet says the time in its detail", () => {
  // A report without a fiscal period keeps the time the source gave as reportTime, not as its period.
  const rows = buildEventRows({ symbol: "WFC", dividends: [], splits: [], earnings: [
    { date: "2027-01-14", dateType: "announcement", time: "Pre Market", fiscalPeriod: "2026-12", epsEstimate: 1.86, epsAnalysts: 17, dateStatus: "confirmed" },
    { date: "2026-10-13", dateType: "announcement", time: "Pre Market", fiscalPeriod: "2026-09", epsActual: 1.66, dateStatus: "reported" },
    { date: "2017-07-14", dateType: "announcement", time: "After Hours", epsActual: 1.07, dateStatus: "reported" },
  ] }, null, null, "USD");
  expect(rows.find((row) => row.date === "2027-01-14"))
    .toMatchObject({ period: "Dec 2026", reportTime: "Pre Market", detail: "confirmed, Pre Market, 17 analysts" });
  expect(rows.find((row) => row.date === "2026-10-13")).toMatchObject({ period: "Sep 2026", reportTime: "Pre Market" });
  expect(rows.find((row) => row.date === "2017-07-14")).toMatchObject({ period: "-", reportTime: "After Hours" });
  expect(rows.find((row) => row.date === "2017-07-14")?.detail).not.toContain("After Hours");
});

describe("the TTM row's EPS", () => {
  // PLTR: ticker prints the served trailing 1.16, the statement quarters' diluted EPS add to 1.17 and the rows above
  // are two adjusted quarters over two GAAP ones.
  const quarter = (date: string, fiscalPeriod: string, epsActual: number, epsBasis: "gaap" | "adjusted" | null) => (
    { date, dateType: "announcement" as const, currency: "USD", fiscalPeriod, epsActual, epsBasis, dateStatus: "reported" as const }
  );
  const earnings = (bases: Array<"gaap" | "adjusted" | null>) => [
    quarter("2026-08-03", "2026-06", 0.31, bases[0]!), quarter("2026-05-04", "2026-03", 0.25, bases[1]!),
    quarter("2026-02-02", "2025-12", 0.24, bases[2]!), quarter("2025-11-03", "2025-09", 0.18, bases[3]!),
  ];
  const financials = {
    financialCurrency: "USD",
    fundamentals: { eps: 1.16 },
    quarterlyStatements: [["2025-09-30", 0.18], ["2025-12-31", 0.24], ["2026-03-31", 0.34], ["2026-06-30", 0.41]]
      .map(([date, eps]) => ({ date: date as string, eps: eps as number, totalRevenue: 1e9, currency: "USD" })),
  };
  const ttm = (bases: Array<"gaap" | "adjusted" | null>, served: EventFinancials = financials) =>
    buildEventRows({ symbol: "PLTR", dividends: [], splits: [], earnings: earnings(bases) }, null, served, "USD")
      .find((row) => row.status === "TTM");

  test("is the served GAAP diluted figure, never a sum of quarters of mixed basis", () => {
    const row = ttm(["adjusted", "adjusted", "gaap", "gaap"]);
    expect(row).toMatchObject({ annualEps: 1.16, epsCurrency: "USD", epsBasis: "GAAP", detail: "GAAP diluted" });
    expect(row?.detail).not.toContain("sum");
    // Neither the mixed sum of the four rows (0.98) nor the statements' (1.17).
    expect(ttm(["adjusted", "adjusted", "gaap", "gaap"], { ...financials, fundamentals: { eps: undefined } })?.annualEps).toBeCloseTo(1.17, 10);
  });

  test("adds the adjusted sum only when all four matched quarters are adjusted", () => {
    const row = ttm(["adjusted", "adjusted", "adjusted", "adjusted"]);
    expect(row).toMatchObject({ annualEps: 1.16, detail: "GAAP diluted, adj sum 0.98" });
    expect(ttm(["adjusted", "adjusted", "adjusted", null])?.detail).toBe("GAAP diluted");
    expect(ttm(["adjusted", "adjusted", "adjusted", "gaap"])?.detail).toBe("GAAP diluted");
  });

  test("states the currency the trailing figure is in", () => {
    expect(ttm(["gaap", "gaap", "gaap", "gaap"], { ...financials, fundamentals: { eps: 1.16, epsCurrency: "EUR" } })?.epsCurrency).toBe("EUR");
  });
});

test("a REIT's pending report names the adjusted basis of its FFO consensus, as ERN does", () => {
  const [row] = buildEventRows({ symbol: "PLD", dividends: [], splits: [], earnings: [
    { date: "2026-10-15", dateType: "announcement", currency: "USD", fiscalPeriod: "2026-09", epsEstimate: 1.58, epsAnalysts: 2,
      epsBasis: "adjusted", dateStatus: "confirmed" },
  ] }, null, null, "USD");
  expect(row).toMatchObject({ earningsState: "pending", qEps: 1.58, epsBasis: "adjusted", detail: "confirmed, 2 analysts, adj" });
});

test("a press release's figure reads provisional until the calendar's replaces it, as ERN and EVTS mark it", () => {
  // The Travelers the morning of its report: its core EPS, read from the release before the calendar has the quarter.
  const trv = (epsActualSource: "press-release" | undefined) => buildEventRows({ symbol: "TRV", dividends: [], splits: [], earnings: [
    { date: "2026-10-16", dateType: "announcement", currency: "USD", fiscalPeriod: "2026-09", epsEstimate: 7.07, epsActual: 9.18,
      difference: 2.11, epsBasis: "adjusted", dateStatus: "reported", ...(epsActualSource ? { epsActualSource } : {}) },
  ] }, null, null, "USD").find((row) => row.date === "2026-10-16");
  expect(trv("press-release")).toMatchObject({ qEps: 9.18, epsBasis: "adjusted", epsProvisional: true, detail: "adj, provisional, +2.11 vs est" });
  const settled = trv(undefined);
  expect(settled).toMatchObject({ qEps: 9.18, epsBasis: "adjusted", detail: "adj, +2.11 vs est" });
  expect(settled?.epsProvisional).toBeUndefined();
});

test("a beat against a negative estimate reads as a beat", () => {
  const [row] = buildEventRows({ symbol: "CRWV", dividends: [], splits: [], earnings: [
    { date: "2026-08-11", dateType: "announcement", epsEstimate: -1.47, epsActual: -1.14, difference: 0.33, surprisePercent: -22.45 },
  ] }, null, null, "USD");
  expect(row).toMatchObject({ surprisePercent: 22.45, value: "+22.45%", tone: "positive", detail: "basis unknown, +0.33 vs est" });
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

  test("does not add reported quarters of unknown basis to the TTM row", () => {
    // UNH: reported (adjusted) 2.92, 2.11, 7.23, 6.38 against GAAP 2.59, 0.02, 6.90, 6.04.
    const reported = [["2025-09-30", 2.92], ["2025-12-31", 2.11], ["2026-03-31", 7.23], ["2026-06-30", 6.38]] as const;
    const actions = {
      symbol: "UNH",
      dividends: [],
      splits: [],
      earnings: reported.map(([date, epsActual]) => ({ date, dateType: "fiscal-period-end" as const, currency: "USD", epsActual })),
    };
    const financials = {
      financialCurrency: "USD",
      quarterlyStatements: [["2025-06-30", 4.08], ["2025-09-30", 2.59], ["2025-12-31", 0.02], ["2026-03-31", 6.9], ["2026-06-30", 6.04]]
        .map(([date, eps]) => ({ date: date as string, eps: eps as number, totalRevenue: 100 })),
    };
    const ttm = buildEventRows(actions, null, financials, "USD").find((row) => row.status === "TTM");
    expect(ttm?.annualEps).toBeCloseTo(15.55, 10);
    expect(ttm).toMatchObject({ date: "2026-06-30", epsCurrency: "USD", annualRevenue: 400, detail: "GAAP diluted (statements)" });
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
    const unlabelled = buildEventRows({ ...data, currency: undefined }, null, null, "");
    expect(unlabelled.find((row) => row.status === "Dividend")?.value).toBe("0.26");
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
