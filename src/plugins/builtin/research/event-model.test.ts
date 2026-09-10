import { expect, test } from "bun:test";
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

test("ADRs keep independent consensus EPS and revenue currencies and never infer missing ones", () => {
  const rows = buildEventRows(null, { symbol: "TSM", currency: "USD", recommendations: [], ratings: [],
    earningsEstimates: [{ date: "2026-09-30", period: "current_quarter", average: 4.46, currency: "USD" }],
    revenueEstimates: [{ date: "2026-09-30", period: "current_quarter", average: 1.454e12, currency: "TWD" },
      { date: "2026-12-31", period: "next_quarter", average: 1.6e12 }],
  }, null, "USD");
  expect(rows.find((row) => row.date === "2026-09-30")).toMatchObject({ epsCurrency: "USD", revenueCurrency: "TWD" });
  expect(rows.find((row) => row.date === "2026-12-31")?.revenueCurrency).toBeUndefined();
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
  expect(row).toMatchObject({ dateType: "fiscal-period-end", detail: "Period end; diff 0.01" });
  expect(row?.epsCurrency).toBeUndefined();
});

test("partial and stale corporate data are not described as an empty event history", () => {
  const notice = eventSourceNotice({ variant: "corporate-actions", symbol: "RIVN", actionsError: null, estimatesError: null, estimates: null,
    actions: { symbol: "RIVN", dividends: [], splits: [], earnings: [], coverage: { earnings: "unavailable", dividends: "available" }, stale: true },
  });
  expect(notice).toEqual({ text: "Unavailable: earnings   Corporate actions stale", failed: true });
});

test("period aliases retain exact filing provenance and raw surprise inputs", () => {
  const evidence = { accessionNumber: "0000909832-26-000051", filed: "2026-06-03", startDate: "2026-02-16" };
  const [row] = buildEventRows({ symbol: "COST", providerId: "yahoo", dividends: [], splits: [], earnings: [
    { date: "2026-05-31", dateType: "fiscal-period-end", epsActual: 4.93, epsEstimate: 4.9231, difference: 0.0069, surprisePercent: 0.14 },
  ] }, null, { quarterlyStatements: [{ date: "2026-05-10", providerDate: "2026-05-31", dateSource: "sec", dateEvidence: evidence, totalRevenue: 70_527_000_000, currency: "USD" }] }, "USD");
  expect(row).toMatchObject({ date: "2026-05-10", providerPeriodDate: "2026-05-31", fiscalPeriodEnd: "2026-05-10", period: "Q26-05-10", dateEvidence: evidence,
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
