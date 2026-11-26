import { MISSING_VALUE } from "../../../utils/format";
import { describe, expect, test } from "bun:test";
import type { AnalystResearchData, CorporateActionsData } from "../../../types/financials";
import { buildEarningsHeader, buildEventRows, buildNextUp, eventSourceNotice, formatEventMetric, nextCatalystOf, sourceErrorText, type EventFinancials } from "./event-model";
import { catalystFixture } from "../catalysts/test-fixture";
import { NOT_MEANINGFUL_TONE } from "../../../utils/growth";
import { fiscalPeriodText } from "../earnings/fiscal-quarter";
import { dividendYearDetail, dividendYears, splitMarks } from "./event-charts";
import { latestTrailingStatement } from "../../../time-series/fundamentals";

test("listing earnings keep their own report and never acquire a predecessor's sales or trailing year", () => {
  const predecessor = { basis: "predecessor" as const, entity: "corteva-consolidated", registrant: "0002128626", label: "Corteva consolidated (accounting predecessor)" };
  const standalone = { ...predecessor, entity: "vylor-standalone", basis: "standalone" as const };
  const rows = ["2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30"].map(date => ({ date, statementScope: predecessor, currency: "USD", totalRevenue: 2458e6, eps: -0.85 }));
  const event = { symbol: "VYLR", dividends: [], splits: [], earnings: [{ date: "2026-11-12", fiscalPeriod: "2026-09", epsActual: 0.4, epsEstimate: 0.3, currency: "USD" }] };
  for (const scope of [predecessor, standalone, undefined]) {
    const book = { statementScope: scope, quarterlyStatements: rows, annualStatements: [rows[0]!], priceHistory: [] };
    const events = buildEventRows(event, null, book, "USD");
    expect(events.find(row => row.status === "Earnings")).toMatchObject({ epsActual: 0.4, epsEstimate: 0.3, qEps: 0.4, epsCurrency: "USD", qRevenue: undefined, fiscalPeriodEnd: undefined });
    expect(events.find(row => row.status === "TTM")).toBeUndefined();
    expect(latestTrailingStatement(book)).toBeNull();
  }
  const owned = { statementScope: standalone, quarterlyStatements: [...rows, { ...rows[3]!, statementScope: standalone, totalRevenue: 300e6 }] };
  expect(buildEventRows(event, null, owned, "USD").find(row => row.status === "Earnings")?.qRevenue).toBe(300e6);
});

test("a statement ending in the following month does not rename the earnings calendar's quarter", () => {
  const rows = buildEventRows({ symbol: "TEST", dividends: [], splits: [], earnings: [
    { date: "2025-11-19", fiscalPeriod: "2025-10", epsActual: 1.5 },
    { date: "2026-11-18", fiscalPeriod: "2026-10", epsEstimate: 1.6 },
  ] }, null, { quarterlyStatements: [{ date: "2025-11-01", eps: 1.5, totalRevenue: 100 }] }, "USD");
  const earnings = rows.filter((row) => row.status === "Earnings").sort((left, right) => left.date.localeCompare(right.date));
  expect(earnings.map((row) => row.period)).toEqual([fiscalPeriodText("2025-10"), fiscalPeriodText("2026-10")]);
  expect(earnings[0]?.fiscalPeriodEnd).toBe("2025-11-01");
  expect(earnings.map((row) => row.period)).toEqual(["Oct 2025", "Oct 2026"]);
  expect(fiscalPeriodText("2026-10", { fiscalYear: 2027, fiscalQuarter: 3 })).toBe("Q3 FY2027");
  expect(fiscalPeriodText(null)).toBe(MISSING_VALUE);
});

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
  expect(row).toMatchObject({ date: "2026-11-03", period: MISSING_VALUE, reportTime: "AMC", detail: "Pending, AMC", qEps: -0.73, epsCurrency: "USD" });
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
  expect(row).toMatchObject({ dateType: "fiscal-period-end", detail: "Period end" });
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
  // An unlabelled old quarter takes it only where the company's own EPS is in it too.
  const old = [...earnings, { date: "2023-11-02", epsActual: 1.46 }];
  const oldCurrency = (financials: EventFinancials | null) => buildEventRows({ symbol: "MSFT", currency: "USD", dividends: [], splits: [], earnings: old },
    null, financials, "USD").find((row) => row.date === "2023-11-02")?.epsCurrency;
  expect(oldCurrency({ quarterlyStatements: [], financialCurrency: "USD", fundamentals: { epsCurrency: "USD" } })).toBe("USD");
  expect(oldCurrency({ quarterlyStatements: [], financialCurrency: "AUD", fundamentals: { epsCurrency: "AUD" } })).toBeUndefined();
  expect(oldCurrency(null)).toBeUndefined();
});

test("partial and stale corporate data are not described as an empty event history", () => {
  const notice = eventSourceNotice({ variant: "corporate-actions", symbol: "RIVN", actionsError: null, estimatesError: null, estimates: null,
    actions: { symbol: "RIVN", dividends: [], splits: [], earnings: [], coverage: { earnings: "unavailable", dividends: "available" }, stale: true },
  });
  expect(notice).toEqual({ text: "Unavailable: earnings   Corporate actions stale", failed: true });
});

test("a failed source reads as one short line in words, never its reason code (AIOK)", () => {
  // Declared, payable ahead of today whenever the test runs.
  const ahead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const actions = { symbol: "AIOK", dividends: [], splits: [], earnings: [], coverage: { earnings: "unavailable" as const, dividends: "available" as const },
    declaredDividends: [{ exDate: ahead(30), amount: 3.5, declarationDate: ahead(-5), recordDate: ahead(5), payDate: ahead(28), special: true as const }] };
  const state = { variant: "corporate-actions" as const, symbol: "AIOK", actionsError: null, estimates: null, actions };
  expect(eventSourceNotice({ ...state, estimatesError: "UPSTREAM_ERROR" })).toEqual({
    text: "Unavailable: earnings, analyst estimates (the source did not answer)", failed: true });
  expect(eventSourceNotice({ ...state, actions: { ...actions, coverage: {} }, estimatesError: "TIMEOUT" })).toEqual({
    text: "Analyst estimates unavailable: the source timed out", failed: true });
  expect(eventSourceNotice({ ...state, actions: null, actionsError: "UPSTREAM_ERROR", estimatesError: null })?.text).toBe(
    "Corporate actions unavailable: the source did not answer");
  // A sentence stands as it is.
  expect(sourceErrorText("Analyst source timed out")).toBe("Analyst source timed out");
  // The declared special dividend is a row of its own while the rest failed.
  const rows = buildEventRows(actions, null, null, "USD");
  expect(rows).toEqual([expect.objectContaining({ id: `div-declared:${ahead(30)}`, date: ahead(30), detail: `Declared special, payable ${ahead(28)}`, value: "$3.50" })]);
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

test("period aliases retain exact filing provenance and raw EPS observations", () => {
  const evidence = { accessionNumber: "0000909832-26-000051", filed: "2026-06-03", startDate: "2026-02-16" };
  const [row] = buildEventRows({ symbol: "COST", providerId: "gloom", dividends: [], splits: [], earnings: [
    { date: "2026-05-31", dateType: "fiscal-period-end", epsActual: 4.93, epsEstimate: 4.9231, difference: 0.0069, surprisePercent: 0.14 },
  ] }, null, { quarterlyStatements: [{ date: "2026-05-10", providerDate: "2026-05-31", dateSource: "sec", dateEvidence: evidence, totalRevenue: 70_527_000_000, currency: "USD" }] }, "USD");
  expect(row).toMatchObject({ date: "2026-05-10", providerPeriodDate: "2026-05-31", fiscalPeriodEnd: "2026-05-10", period: "May 2026", dateEvidence: evidence,
    qRevenue: 70_527_000_000, epsEstimate: 4.9231, epsActual: 4.93, epsDifference: undefined, surprisePercent: undefined, epsBasis: "unknown" });
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
  expect(rows.find((row) => row.date === "2026-08-11")).toMatchObject({ period: "Jun 2026", qEps: -1.32, qRevenue: 2e9, epsBasis: "unknown",
    detail: "EPS basis unconfirmed", value: MISSING_VALUE, fiscalPeriodEnd: "2026-06-30", surprisePercent: undefined });
  expect(rows.find((row) => row.date === "2026-11-09")).toMatchObject({ earningsState: "pending", qEps: -1.52697, epsAnalysts: 18,
    dateStatus: "projected", detail: "projected, 18 analysts" });
  const ttm = rows.find((row) => row.status === "TTM");
  expect(ttm?.annualEps).toBeCloseTo(-3.65, 10);
  expect(ttm).toMatchObject({ epsBasis: "GAAP", detail: "GAAP diluted (statements)" });
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
  expect(rows.find((row) => row.date === "2017-07-14")).toMatchObject({ period: MISSING_VALUE, reportTime: "After Hours" });
  expect(rows.find((row) => row.date === "2017-07-14")?.detail).not.toContain("After Hours");
});

describe("the TTM row's EPS", () => {
  // PLTR: ticker prints the served trailing 1.16, the statement quarters' diluted EPS add to 1.17 and the rows above
  // are two adjusted quarters over two GAAP ones.
  const quarter = (date: string, fiscalPeriod: string, epsActual: number, epsBasis: "gaap" | "adjusted" | null) => (
    { date, dateType: "announcement" as const, currency: "USD", fiscalPeriod, epsActual, epsBasis,
      epsActualSource: "filing" as const, dateStatus: "reported" as const }
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
  expect(trv("press-release")).toMatchObject({ qEps: 9.18, epsBasis: "adjusted", epsProvisional: true, surprisePercent: 29.84, detail: "adj, provisional, +2.11 vs est" });
  const settled = trv(undefined);
  expect(settled).toMatchObject({ qEps: 9.18, epsEstimate: 7.07, epsBasis: "unknown", detail: "EPS basis unconfirmed" });
  expect(settled?.epsDifference).toBeUndefined();
  expect(settled?.epsProvisional).toBeUndefined();
});

test("an unconfirmed adjusted actual also says when there is no consensus", () => {
  const [row] = buildEventRows({ symbol: "TRV", dividends: [], splits: [], earnings: [
    { date: "2026-10-16", epsActual: 9.18, epsBasis: "adjusted", dateStatus: "reported" },
  ] }, null, null, "USD");
  expect(row).toMatchObject({ epsActual: 9.18, epsBasis: "unknown", detail: "EPS basis unconfirmed, no consensus" });
});

test("a beat against a negative estimate: its surprise N/M, in N/M's tone, and the difference says it beat", () => {
  const [row] = buildEventRows({ symbol: "CRWV", dividends: [], splits: [], earnings: [
    { date: "2026-08-11", dateType: "announcement", epsEstimate: -1.47, epsActual: -1.14, difference: 0.33, surprisePercent: -22.45, epsBasis: "gaap", epsActualSource: "press-release" },
  ] }, null, null, "USD");
  // A loss narrower than expected is no percentage of the loss expected: the source's -22.45% is not shown either.
  expect(row).toMatchObject({ value: "N/M", tone: NOT_MEANINGFUL_TONE, detail: "GAAP, provisional, +0.33 vs est", surpriseNotMeaningful: true });
  expect(row!.surprisePercent).toBeUndefined();
  const [miss] = buildEventRows({ symbol: "CRWV", dividends: [], splits: [], earnings: [
    { date: "2026-05-07", dateType: "announcement", epsEstimate: -1.17, epsActual: -1.38, difference: -0.21, epsBasis: "gaap", epsActualSource: "press-release" },
  ] }, null, null, "USD");
  expect(miss).toMatchObject({ value: "N/M", tone: NOT_MEANINGFUL_TONE, detail: "GAAP, provisional, -0.21 vs est" });
  const [zero] = buildEventRows({ symbol: "X", dividends: [], splits: [], earnings: [
    { date: "2026-05-07", dateType: "announcement", epsEstimate: 0, epsActual: 0.02, epsBasis: "gaap", epsActualSource: "press-release" },
  ] }, null, null, "USD");
  expect(zero).toMatchObject({ value: "N/M", tone: NOT_MEANINGFUL_TONE });
  const [positive] = buildEventRows({ symbol: "X", dividends: [], splits: [], earnings: [
    { date: "2026-05-07", dateType: "announcement", epsEstimate: 0.5, epsActual: 0.55, epsBasis: "gaap", epsActualSource: "press-release" },
  ] }, null, null, "USD");
  expect(positive).toMatchObject({ surprisePercent: 10, value: "+10.00%", tone: "positive" });
});

test("an estimate's growth off a year-ago loss or zero is N/M, whatever the source worked out", () => {
  const rows = buildEventRows(null, {
    symbol: "CRWV",
    recommendations: [],
    ratings: [],
    earningsEstimates: [
      // A year-ago loss of 0.40 against an estimated profit of 0.10: the source's +125% is no growth of the loss.
      { date: "2027-03-31", period: "current_quarter", average: 0.1, yearAgo: -0.4, growth: 1.25, analysts: 12 },
      { date: "2027-12-31", period: "next_year", average: 1.2, yearAgo: 0, analysts: 14 },
      { date: "2026-12-31", period: "current_year", average: 0.8, yearAgo: 0.5, growth: 0.6, analysts: 15 },
    ],
    revenueEstimates: [],
  }, null, "USD");
  const quarter = rows.find((row) => row.status === "Q Est");
  expect(quarter).toMatchObject({ value: "N/M", tone: NOT_MEANINGFUL_TONE, estimateGrowthMetric: "eps", estimateGrowthNotMeaningful: true });
  expect(quarter?.estimateGrowth).toBeUndefined();
  const years = rows.filter((row) => row.status === "FY Est");
  expect(years.find((row) => row.annualEps === 1.2)).toMatchObject({ value: "N/M", estimateGrowthNotMeaningful: true });
  expect(years.find((row) => row.annualEps === 0.8)).toMatchObject({ value: "+60.00%", tone: "positive", estimateGrowth: 0.6 });
  expect(years.find((row) => row.annualEps === 0.8)?.estimateGrowthNotMeaningful).toBeUndefined();
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

test("a factor is a spin-off only beside its demerger on record, else a factor; what precedes it is labelled, never multiplied back", () => {
  // GE's 1253:1000 of 2024-04-02 with no demerger on record: a factor, which the dividend and EPS before it name.
  const rows = buildEventRows({ symbol: "GE", currency: "USD",
    earnings: [{ date: "2024-01-23", epsActual: 0.822, epsEstimate: 0.72 }, { date: "2024-04-23", epsActual: 0.82, epsEstimate: 0.67 }],
    dividends: [{ exDate: "2023-12-27", amount: 0.063847 }, { exDate: "2024-04-12", amount: 0.28 }],
    splits: [{ date: "2024-04-02", fromFactor: 1000, toFactor: 1253, description: "1253:1000 split" }],
  }, null, null, "USD");
  const row = rows.find((event) => event.date === "2024-04-02");
  expect(row).toMatchObject({ status: "Factor", value: "1253:1000", adjustmentFactor: 1.253,
    detail: "Split/adjustment", providerDescription: "1253:1000 split" });
  expect(row?.qEps).toBeUndefined();
  expect(rows.find((event) => event.id === "div:2023-12-27")).toMatchObject({ value: "$0.063847", detail: "adjusted by the 1253:1000 factor",
    adjustedFor: "adjusted by the 1253:1000 factor of 2024-04-02" });
  expect(rows.find((event) => event.id === "div:2024-04-12")).toMatchObject({ value: "$0.28", detail: "" });
  expect(rows.filter((event) => event.status === "Earnings").map((event) => event.adjustedFor ?? null))
    .toEqual([null, "EPS adjusted by the 1253:1000 factor of 2024-04-02"]);
  // CTVA's 6665:1000 on the day VYLR's demerger is on record: one Spin-off row, which the Dividends view marks.
  const vylor = { exDate: "2026-10-01", business: "seed", ratio: 1, successor: { symbol: "VYLR", exchange: "NYSE", name: "Vylor Inc." } };
  const ctva = buildEventRows({ symbol: "CTVA", currency: "USD", earnings: [], demergers: [vylor],
    dividends: [{ exDate: "2026-09-01", amount: 0.027007 }], splits: [{ date: "2026-10-01", fromFactor: 1000, toFactor: 6665 }],
  }, null, null, "USD");
  expect(ctva.map((event) => [event.status, event.detail, event.value])).toEqual([
    ["Spin-off", "Seed business into VYLR:NYSE (Vylor Inc.), 1 share per share", "6665:1000"],
    ["Dividend", "adjusted for the VYLR spin-off", "$0.027007"],
  ]);
  // The year it went ex in names it, and that the amounts before it are adjusted.
  const years = dividendYears([{ exDate: "2025-09-02", amount: 0.027007 }, { exDate: "2026-09-01", amount: 0.027007 }], "2026-12-15", splitMarks(ctva));
  expect(years.map(dividendYearDetail)).toEqual(["so far · VYLR spin-off, amounts before it adjusted", ""]);
  // DBS's 1-for-10 bonus issue of 2024 is a factor of whole share counts: a split, in its terms.
  const [bonus] = buildEventRows({ symbol: "D05", earnings: [], dividends: [],
    splits: [{ date: "2024-04-22", fromFactor: 10, toFactor: 11, ratio: 1.1, description: "11:10" }],
  }, null, null, "SGD");
  expect(bonus).toMatchObject({ status: "Split", value: "11:10", detail: "11-for-10, 1 new share for every 10 held" });
});

test("a 2-for-1 the day of a spin-off stays a split beside it, and what the company published keeps no adjusted basis", () => {
  const vylor = { exDate: "2026-10-01", business: "seed", ratio: 1, successor: { symbol: "VYLR", exchange: "NYSE", name: "Vylor Inc." } };
  const form = { url: "https://example.com/dividend-form.pdf", publishedOn: "2026-08-20" };
  const dividends = [{ exDate: "2026-06-01", amount: 0.027007 }, { exDate: "2026-09-01", amount: 0.18, parts: [{ amount: 0.18, special: false, type: "interim", form }] }];
  const rows = buildEventRows({ symbol: "CTVA", currency: "USD", demergers: [vylor], dividends,
    earnings: [{ date: "2026-08-05", epsActual: 2.3, epsEstimate: 2.25, epsActualSource: "press-release" }],
    splits: [{ date: "2026-10-01", fromFactor: 1, toFactor: 2, ratio: 2 }, { date: "2026-10-01", fromFactor: 1000, toFactor: 6665 }],
  }, null, null, "USD");
  expect(rows.filter((row) => row.date === "2026-10-01").map((row) => [row.status, row.detail, row.value])).toEqual([
    ["Split", "2-for-1", "2:1"],
    ["Spin-off", "Seed business into VYLR:NYSE (Vylor Inc.), 1 share per share", "6665:1000"],
  ]);
  // The history's own dividend before both is adjusted for them; the one its forms state, and the release's EPS, are as published.
  expect(rows.find((row) => row.id === "div:2026-06-01")).toMatchObject({ detail: "split-adjusted, adjusted for the VYLR spin-off",
    adjustedFor: "adjusted for the VYLR spin-off of 2026-10-01 (6665:1000)" });
  const published = rows.find((row) => row.id === "div:2026-09-01");
  expect(published).toMatchObject({ value: "$0.18", detail: "", published: true });
  expect(published?.adjustedFor).toBeUndefined();
  expect(rows.find((row) => row.status === "Earnings")?.adjustedFor).toBeUndefined();
  // The Dividends view as the pane reads these same dividends: $0.027007 adjusted beside $0.18 as published are on two
  // bases, so the year is not summed, and the spin-off's mark says only some of the amounts before it are adjusted.
  const [year] = dividendYears(dividends, "2026-12-15", splitMarks(rows));
  expect(year).toMatchObject({ total: null, special: 0, payments: 2, mixedBasis: true });
  expect(dividendYearDetail(year!)).toBe("2 payments on different bases, not summed · 2-for-1 split · VYLR spin-off, some amounts before it adjusted");
  const adjustedOnly = rows.filter((row) => row.id !== "div:2026-09-01");
  expect(splitMarks(adjustedOnly).map((mark) => mark.terms)).toEqual(["2-for-1 split", "VYLR spin-off, amounts before it adjusted"]);
  const publishedOnly = rows.filter((row) => row.id !== "div:2026-06-01");
  expect(splitMarks(publishedOnly).map((mark) => mark.terms)).toEqual(["2-for-1 split", "VYLR spin-off"]);
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
      // Whole share counts are a split, in its terms.
      { id: "split:2025-12-01:4-for-1 split", status: "Split", value: "4:1", detail: "4-for-1" },
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

test("a fund lists its distributions but no earnings or estimates, whatever a feed sends for its symbol", () => {
  const actions = { symbol: "SPY", currency: "USD", splits: [], dividends: [{ exDate: "2026-09-18", amount: 1.889 }],
    earnings: [{ date: "2026-07-29", dateType: "announcement" as const, epsActual: 1.35, epsEstimate: 1.19 }] };
  const estimates = { symbol: "SPY", recommendations: [], ratings: [], revenueEstimates: [],
    earningsEstimates: [{ date: "2027-03-31", period: "next quarter", average: 4, growth: 0.25, currency: "USD" }] };
  const statuses = (financials: EventFinancials) => buildEventRows(actions, estimates, financials, "USD").map((row) => row.status);
  expect(statuses({ quarterlyStatements: [], quote: { currency: "USD", instrumentType: "ETF" } })).toEqual(["Dividend"]);
  expect(statuses({ quarterlyStatements: [], quoteMetadata: { instrumentType: "ETF" } })).toEqual(["Dividend"]);
  expect(statuses({ quarterlyStatements: [], quote: { currency: "USD", instrumentType: "EQUITY" } })).toEqual(expect.arrayContaining(["Earnings", "Q Est"]));
});

/** Review, 24 Nov 2026: Haier's dividends were each dated Ex-date again and tinted as a gain. */
test("dividend rows say only what the row does not, untinted", () => {
  const rows = buildEventRows({ symbol: "TEST", currency: "CNY", earnings: [],
    dividends: [
      { exDate: "2023-06-10", amount: 0.4 },
      { exDate: "2024-06-10", amount: 0.46136, payDate: "2024-06-20" },
      { exDate: "2025-06-10", amount: 0.8, parts: [{ amount: 0.8, special: true, type: "special", form: { url: "", publishedOn: "2025-05-01" } }] },
    ],
    splits: [{ date: "2024-01-15", fromFactor: 10, toFactor: 11 }],
  }, null, null, "CNY");
  expect(rows.map((row) => [row.status, row.detail, row.tone, row.period, row.special ?? false])).toEqual([
    ["Dividend", "special", "text", "", true],
    ["Dividend", "payable 2024-06-20", "text", "", false],
    ["Split", "11-for-10, 1 new share for every 10 held", "muted", "", false],
    // Paid before a split on record: the amount is on today's shares.
    ["Dividend", "split-adjusted", "text", "", false],
  ]);
});

describe("what is next", () => {
  const today = "2098-11-24";
  const estimates: AnalystResearchData = { symbol: "KO", recommendations: [], ratings: [],
    earningsEstimates: [
      { date: "2098-12-31", period: "current_quarter", average: 0.6, currency: "USD", analysts: 12, growth: 0.05 },
      { date: "2099-03-31", period: "next_quarter", average: 0.7, currency: "USD" },
    ],
    revenueEstimates: [
      { date: "2098-12-31", period: "current_quarter", average: 11.2e9, currency: "USD", analysts: 1, growth: -0.02 },
      { date: "2099-03-31", period: "next_quarter", average: 12.5e9, currency: "USD" },
    ] };
  const rows = (earnings: CorporateActionsData["earnings"], extra = {}, consensus: AnalystResearchData | null = estimates) => buildEventRows({
    symbol: "KO", currency: "USD", splits: [], dividends: [{ exDate: "2098-09-15", amount: 0.53 }], earnings, ...extra,
  }, consensus, null, "USD");
  const figures = (built: ReturnType<typeof rows>, options: Partial<Parameters<typeof buildNextUp>[1]> = {}) =>
    buildNextUp(built, { today, fund: false, ...options }).map((figure) => [figure.id, figure.label, figure.value, figure.detail]);

  test("the next report keeps calendar EPS and analyst count separate from quarter revenue and growth", () => {
    const built = rows([
      { date: "2098-10-21", epsActual: 0.82, epsEstimate: 0.78, currency: "USD", fiscalPeriod: "2098-09" },
      { date: "2099-02-10", epsEstimate: 0.61, currency: "USD", dateStatus: "projected", epsAnalysts: 20 },
    ]);
    expect(figures(built)).toEqual([
      // The quarter it covers is the last one estimated to end before it, not the one after.
      ["next-report", "Next report", "10 Feb 2099", "in 78 days · projected · Dec 2098 qtr"],
      ["eps-estimate", "EPS est", "0.61 USD", "20 analysts"],
      ["revenue-estimate", "Revenue est", "11.2B USD", "1 analyst · -2.00% y/y"],
      ["last-ex", "Last ex", "15 Sep 2098", "$0.53"],
    ]);
  });

  test.each([12, undefined])("matching displayed EPS with calendar count %s does not prove shared consensus", (epsAnalysts) => {
    const built = rows([{ date: "2099-02-10", epsEstimate: 0.6001, currency: "USD", epsAnalysts }]);
    expect(figures(built).find(([id]) => id === "eps-estimate"))
      .toEqual(["eps-estimate", "EPS est", "0.60 USD", epsAnalysts ? "12 analysts" : undefined]);
  });

  test.each([false, true])("a dated report without EPS uses quarter EPS and all its details (year-ago loss: %s)", (yearAgoLoss) => {
    const consensus = yearAgoLoss ? { ...estimates, earningsEstimates: [{ ...estimates.earningsEstimates[0]!, yearAgo: -0.2 }] } : estimates;
    const built = rows([{ date: "2099-02-10", currency: "EUR", epsAnalysts: 20 }], {}, consensus);
    expect(figures(built).find(([id]) => id === "eps-estimate"))
      .toEqual(["eps-estimate", "EPS est", "0.60 USD", `12 analysts · ${yearAgoLoss ? "N/M" : "+5.00%"} y/y`]);
  });

  test("Siemens calendar-only EPS keeps its EUR amount and count", () => {
    const built = rows([{ date: "2099-02-10", epsEstimate: 2.75, currency: "EUR", epsAnalysts: 4 }], { symbol: "SIE" }, null);
    expect(figures(built).find(([id]) => id === "eps-estimate")).toEqual(["eps-estimate", "EPS est", "2.75 EUR", "4 analysts"]);
  });

  test("undated, the next report is the earliest quarter analysts estimate, with its consensus", () => {
    expect(figures(rows([{ date: "2098-10-21", epsActual: 0.82, epsEstimate: 0.78, currency: "USD" }])).slice(0, 3)).toEqual([
      ["next-report", "Next report", "Dec 2098 qtr", "not dated yet"],
      ["eps-estimate", "EPS est", "0.60 USD", "12 analysts · +5.00% y/y"],
      ["revenue-estimate", "Revenue est", "11.2B USD", "1 analyst · -2.00% y/y"],
    ]);
  });

  test("the ex-date: a declared one with its amount, else the one the listing's figures state, else the last", () => {
    const declared = rows([], { declaredDividends: [{ exDate: "2098-12-01", amount: 0.55, payDate: "2098-12-15", special: true }] });
    expect(figures(declared, { fund: true })).toEqual([["next-ex", "Next ex", "01 Dec 2098", "$0.55 · special · in 7 days"]]);
    expect(figures(rows([]), { fund: true, statedExDate: "2098-12-01" })).toEqual([["next-ex", "Next ex", "01 Dec 2098", "in 7 days · last paid $0.53"]]);
    // A stated date already past is the last payment's, not the next.
    expect(figures(rows([]), { fund: true, statedExDate: "2098-09-15" })).toEqual([["last-ex", "Last ex", "15 Sep 2098", "$0.53"]]);
  });

  test("a catalyst dated to the day counts the days to it; one dated to its month says the month; a fund has none", () => {
    const at = (date: string) => figures(rows([]), { catalyst: { date, label: "FDA decision" } }).at(-1);
    expect(at("2098-12-04")).toEqual(["next-catalyst", "Next catalyst", "04 Dec 2098", "in 10 days · FDA decision"]);
    expect(at("2099-03")).toEqual(["next-catalyst", "Next catalyst", "Mar 2099", "FDA decision"]);
    expect(figures(rows([]), { fund: true, catalyst: { date: "2098-12-04", label: "FDA decision" } }).map(([id]) => id)).toEqual(["last-ex"]);
  });

  test("the next catalyst is the earliest one not over, at the precision its date has, never one whose date is withheld", () => {
    const event = (id: string, deadlineDate: string, deadline: "day" | "month", extra = {}) => ({ ...catalystFixture, id, title: id, deadlineDate,
      datePrecision: { ...catalystFixture.datePrecision, deadline }, ...extra });
    const events = [
      event("past", "2098-11-20", "day"),
      event("withheld", "2098-11-25", "day", { metadata: { dateWithheld: true } }),
      event("this month", "2098-11", "month"),
      event("later", "2098-12-02", "day"),
    ];
    expect(nextCatalystOf({ events }, "2098-11-24")).toEqual({ date: "2098-11", label: "this month" });
    expect(nextCatalystOf({ events: events.slice(0, 2) }, "2098-11-24")).toBeNull();
    // A date known only to its month comes after that month's days, as the calendar orders its rows.
    expect(nextCatalystOf({ events: [event("december", "2098-12", "month"), event("christmas", "2098-12-25", "day")] }, "2098-11-24"))
      .toEqual({ date: "2098-12-25", label: "christmas" });
  });

  /** A free preview shows the head of the calendar and holds the rest back (`lockedUpcoming`): live, the head was always Pro's. */
  test("a preview's first row is the next catalyst only while its rows come earliest first; otherwise none is named", () => {
    const event = (id: string, deadlineDate: string) => ({ ...catalystFixture, id, title: id, deadlineDate,
      datePrecision: { ...catalystFixture.datePrecision, deadline: "day" as const } });
    const preview = { pro: false, lockedRows: 200, previewLimit: 3, lockedUpcoming: 200 };
    const head = [event("first", "2098-11-29"), event("second", "2098-11-30"), event("third", "2098-12-02")];
    expect(nextCatalystOf({ events: head, access: preview }, "2098-11-24")).toEqual({ date: "2098-11-29", label: "first" });
    // Out of order, a held-back row could be earlier than any shown: no guess.
    const shuffled = [head[1]!, head[0]!, head[2]!];
    expect(nextCatalystOf({ events: shuffled, access: preview }, "2098-11-24")).toBeNull();
    // Nothing held back (Pro, or a preview with every row in it), the earliest shown is the next whatever the order.
    expect(nextCatalystOf({ events: shuffled, access: { pro: true, lockedRows: 0, previewLimit: 3 } }, "2098-11-24")?.label).toBe("first");
    expect(nextCatalystOf({ events: shuffled, access: { pro: false, lockedRows: 0, previewLimit: 3, lockedUpcoming: 0 } }, "2098-11-24")?.label).toBe("first");
    // Every upcoming row held back: none to name.
    expect(nextCatalystOf({ events: [], access: preview }, "2098-11-24")).toBeNull();
  });

  test("EE's figures are the next report with its consensus, no ex-date, and the trailing twelve months the table no longer has", () => {
    const statements = ["2097-12-31", "2098-03-31", "2098-06-30", "2098-09-30"].map((date) => ({ date, eps: 0.7, totalRevenue: 11e9, currency: "USD" }));
    const built = buildEventRows({ symbol: "KO", currency: "USD", splits: [], dividends: [{ exDate: "2098-09-15", amount: 0.53 }], earnings: [
      { date: "2098-10-21", epsActual: 0.82, epsEstimate: 0.78, currency: "USD", fiscalPeriod: "2098-09" },
      { date: "2099-02-10", epsEstimate: 0.61, currency: "USD", dateStatus: "projected" },
    ] }, estimates, { quarterlyStatements: statements }, "USD");
    const header = buildEarningsHeader(built, { today, fund: false });
    expect(header.map((figure) => [figure.id, figure.value, figure.detail])).toEqual([
      ["next-report", "10 Feb 2099", "in 78 days · projected · Dec 2098 qtr"],
      ["eps-estimate", "0.61 USD", undefined],
      ["revenue-estimate", "11.2B USD", "1 analyst · -2.00% y/y"],
      ["ttm-eps", "2.80 USD", "GAAP diluted (statements) · 4 qtrs to 30 Sep 2098"],
      ["ttm-revenue", "44B USD", "4 qtrs to 30 Sep 2098"],
    ]);
    // Shorter forms for a narrow pane, never a longer one.
    for (const figure of header) for (const variant of figure.detailVariants ?? []) expect(variant.length).toBeLessThan(figure.detail!.length);
    expect(buildEarningsHeader(built, { today, fund: true })).toEqual([]);
  });
});
