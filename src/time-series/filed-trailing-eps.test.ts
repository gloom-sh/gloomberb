import { expect, setSystemTime, test } from "bun:test";
import { atLivePriceEarnings, liveTrailingPE } from "../market-data/quotes/live-valuation";
import { projectPeBand } from "../plugins/builtin/pe-band/model";
import { buildEventRows } from "../plugins/builtin/research/event-model";
import { relativeValuationValues } from "../plugins/builtin/research/relative-valuation-model";
import { mapCloudFinancials } from "../sources/gloomberb-cloud/normalizers";
import { mergeFinancials, mergeMissingStatementArrays, mergeRefreshedFinancials } from "../sources/provider-router/financials";
import { extractFundamentalSeries } from "./fundamentals";
import { renderFundamentalsReport } from "../cli/commands/ticker";
import type { FinancialStatement, Fundamentals, Quote, SplitShareBasis, TickerFinancials } from "../types/financials";
import { withShareMultiples } from "../utils/share-multiples";
import { withFiledTrailingEps } from "./filed-trailing-eps";

// The evening of 2026-11-16: four quarters of 1.00, the last filed on 2026-10-29, at a price of 100.
const NOW = Date.parse("2026-11-16T22:00:00.000Z");
const quote: Quote = { symbol: "UNITTEST", name: "Unit Test", price: 100, previousClose: 100, change: 0, changePercent: 0, currency: "USD", lastUpdated: NOW };
const quarter = (date: string, filed: string): FinancialStatement => ({ date, currency: "USD", eps: 1, fieldAvailability: { eps: filed } });
const financials = (fundamentals: Fundamentals, quarterlyStatements: FinancialStatement[] = [
  quarter("2025-12-31", "2026-02-10"), quarter("2026-03-31", "2026-04-30"), quarter("2026-06-30", "2026-07-30"), quarter("2026-09-30", "2026-10-29"),
]): TickerFinancials => ({ quote, fundamentals, financialCurrency: "USD", quarterlyStatements, annualStatements: [], priceHistory: [] });
const headline = (fundamentals: Fundamentals) => {
  const priced = withFiledTrailingEps(financials(fundamentals), NOW).fundamentals!;
  return { eps: priced.eps, trailingPE: priced.trailingPE, source: priced.trailingEpsSource };
};
const FILED = { eps: 4, trailingPE: 25, source: "filed-quarters" } as const;

test("scoped headlines and repricing use the reviewed denominator, not the overlapping year or a cached multiple", () => {
  const after = Date.parse("2028-02-18T17:00Z"), before = Date.parse("2028-02-16T17:00Z");
  const scope = { basis: "standalone" as const, entity: "vylor-standalone", registrant: "0002128626", label: "Vylor standalone (as filed)" };
  const end = "2027-12-31", filed = "2028-02-17";
  const quote = { symbol: "VYLR", price: 65, currency: "USD", change: 0, changePercent: 0, lastUpdated: after, listingExchangeName: "NYSE" };
  const quarters = ["03-31", "06-30", "09-30", "12-31"].map((day, index) => ({ date: `2027-${day}`, availableAt: filed,
    currency: "USD", statementScope: scope, eps: [0.75, 0.75, 1, 0.75][index], totalRevenue: 30e6 }));
  const raw = { annualStatements: [{ ...quarters[3]!, eps: 3, availableAt: "2028-02-15" }], quarterlyStatements: quarters,
    priceHistory: [before, after].map(time => ({ date: new Date(time), close: 65 })), financialCurrency: "USD", statementScope: scope,
    statementReview: { status: "reviewed" as const, reviewedThrough: filed }, fundamentals: { eps: 3.25, epsCurrency: "USD", trailingPeriodEnd: end, trailingPE: 20 } };
  const project = (data: TickerFinancials) => {
    const priced = withShareMultiples(withFiledTrailingEps(data, after));
    const stats = atLivePriceEarnings(priced).fundamentals;
    const series = extractFundamentalSeries(priced, { kind: "security", instrument: { symbol: "VYLR" }, fieldId: "valuation.trailingPE", period: "annual" });
    const band = projectPeBand(priced, priced.priceHistory, { symbol: "VYLR", lookbackYears: 1, now: after });
    return { eps: stats?.eps, pe: stats?.trailingPE, live: liveTrailingPE(priced.quote, priced.fundamentals), band: band.current?.pe ?? undefined,
      chart: series.find(point => point.periodLabel === "Current")?.value, peer: relativeValuationValues(priced).trailingPE,
      event: buildEventRows(null, null, priced, "USD").find(row => row.status === "TTM")?.annualEps };
  };
  setSystemTime(after);
  try {
    const admitted = { ...mapCloudFinancials(raw), quote };
    expect(project(admitted)).toEqual({ eps: 3.25, pe: 20, live: 20, band: 20, chart: 20, peer: 20, event: 3.25 });
    const headline = renderFundamentalsReport({ ...withFiledTrailingEps(admitted, after), symbol: "VYLR" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
    expect(headline).toContain("P/E (TTM) 20.00");
    expect(headline).toContain("EPS (TTM) $3.25");
    const daily = (data: TickerFinancials) => extractFundamentalSeries(data, { kind: "security", instrument: { symbol: "VYLR" }, fieldId: "valuation.trailingPE", period: "daily" }).map(point => point.value);
    expect(daily(admitted)).toEqual([null, 20]);
    expect(project({ ...mapCloudFinancials({ ...raw, statementReview: { ...raw.statementReview, reviewedThrough: "2028-02-25" } }), quote })).toMatchObject({ eps: 3.25, pe: 20 });
    const timed = mapCloudFinancials({ ...raw, quarterlyStatements: quarters.map(row => ({ ...row, availableAt: `${filed}T17:00:00Z` })) });
    for (const [time, pe] of [["16:59", undefined], ["17:01", 20]] as const) {
      expect(project({ ...timed, quote: { ...quote, lastUpdated: Date.parse(`${filed}T${time}Z`) } })).toMatchObject({ pe, live: pe, band: pe, chart: pe });
    }
    expect(project({ ...admitted, quote: { ...quote, price: 78 } })).toMatchObject({ pe: 24, live: 24, band: 24, chart: 24 });
    const blank = { pe: undefined, live: undefined, band: undefined, chart: undefined, peer: null };
    for (const ineligible of [{ ...quote, lastUpdated: before }, { ...quote, lastUpdated: Date.parse("2028-02-17T12:00Z") }, { ...quote, currency: "CAD" },
      { ...quote, marketState: "PRE" as const, regularClose: 64, regularCloseSessionDate: "2028-02-16", changeSessionDate: "2028-02-17", regularChange: 1, regularChangePercent: 1.6 }]) {
      expect(project({ ...admitted, quote: ineligible })).toMatchObject(blank);
    }
    const incomplete = mapCloudFinancials({ ...raw, quarterlyStatements: quarters.map(row => row.date === end ? { ...row, eps: undefined } : row),
      fundamentals: { trailingPeriodEnd: end } });
    const old = { ...incomplete, statementScope: undefined, fundamentals: { eps: 3, trailingPE: 65 / 3 }, quote };
    expect(atLivePriceEarnings({ ...admitted, fundamentals: old.fundamentals }).fundamentals.trailingPE).toBeUndefined();
    const oldAnnual = mapCloudFinancials({ ...raw, quarterlyStatements: [], statementReview: { ...raw.statementReview, reviewedThrough: "2028-02-15" },
      fundamentals: { ...raw.fundamentals, eps: 3, trailingPE: 65 / 3 } });
    expect(project({ ...oldAnnual, quote }).pe).toBeCloseTo(65 / 3);
    const predecessor = { ...scope, basis: "predecessor" as const, entity: "corteva-consolidated" };
    for (const data of [mergeFinancials(incomplete, old)!, mergeFinancials(old, incomplete)!,
      mergeRefreshedFinancials(oldAnnual, incomplete), mergeMissingStatementArrays(incomplete, oldAnnual),
      mapCloudFinancials({ ...raw, statementReview: { ...raw.statementReview, reviewedThrough: "2028-02-15" } }),
      mapCloudFinancials({ ...raw, statementScope: predecessor, quarterlyStatements: quarters.map(row => ({ ...row, statementScope: predecessor })),
        annualStatements: raw.annualStatements.map(row => ({ ...row, statementScope: predecessor })) }), { ...admitted, fundamentals: old.fundamentals }]) {
      expect(project({ ...data, quote })).toMatchObject({ ...blank, eps: undefined, event: undefined });
      expect(daily(withFiledTrailingEps({ ...data, quote }, after)).filter(value => value !== null)).toEqual([]);
    }
    expect(project({ ...mapCloudFinancials({ ...raw, fundamentals: { ...raw.fundamentals, trailingPE: undefined } }), quote })).toMatchObject({ ...blank, eps: 3.25 });
  } finally { setSystemTime(); }
});

test("a split gone ex after the last EPS was filed leaves Gloom Cloud's figure, labelled", () => {
  const split = (exDate: string): SplitShareBasis => ({ exDate, priceFactor: 0.1, method: "provider_cap", reportedShares: 1e8 });
  // The statements are on the old share count: 4.00 would put the P/E at 25 against 250.
  expect(headline({ eps: 0.4, trailingPE: 250, splitShareBasis: split("2026-11-05") })).toEqual({ eps: 0.4, trailingPE: 250, source: "served" });
  // The last 10-Q came after the split, so its figures are on the new count.
  expect(headline({ eps: 3.9, trailingPE: 25.64, splitShareBasis: split("2026-10-01") })).toEqual(FILED);
});

test("a filed figure more than 1.5x Gloom Cloud's either way reads as another share basis", () => {
  for (const served of [2.5, 6.5, -4, 0]) expect(headline({ eps: served, trailingPE: 30 }).source).toBe("served");
  for (const served of [3, 5.5]) expect(headline({ eps: served, trailingPE: 30 })).toEqual(FILED);
});

test("a P/E served with no EPS, a fund's, is labelled Gloom Cloud's where it shows", () => {
  const fund = withFiledTrailingEps(financials({ trailingPE: 22.5 }, []), NOW);
  expect(fund.fundamentals?.trailingEpsSource).toBe("served");
  const valuation = renderFundamentalsReport({ ...fund, symbol: "UNITTEST" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  expect(valuation).toContain("P/E (TTM) 22.50");
  expect(valuation).toContain("P/E (TTM) is Gloom Cloud's trailing figure, not the last four filed quarters'.");
});

// 8058 on JPX, 9 Nov 2026: Gloom Cloud's trailing EPS was the year to March 2026 (209.78), and its quarters carried
// EPS only on the first of the year until the server filled the reported ones.
test("an EPS filed for the latest year a quarter ago names that year, until four newer filed quarters stand in for it", () => {
  const yen = { ...quote, symbol: "8058", price: 5170, currency: "JPY" };
  const year = (date: string, eps: number): FinancialStatement => ({ date, currency: "JPY", eps });
  const row = (date: string, eps?: number): FinancialStatement => ({ date, currency: "JPY", ...(eps !== undefined ? { eps } : {}) });
  const served: Fundamentals = { eps: 209.78, trailingPE: 24.64 };
  const report = (quarterlyStatements: FinancialStatement[]) => {
    const priced = withFiledTrailingEps({ quote: yen, fundamentals: served, financialCurrency: "JPY", quarterlyStatements,
      annualStatements: [year("2025-03-31", 235.8), year("2026-03-31", 209.78)], priceHistory: [] }, NOW);
    return renderFundamentalsReport({ ...priced, symbol: "8058" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  };
  // Without the quarters, the served figure states no period: it is not named a year by matching the year's value.
  const before = report([row("2025-09-30"), row("2025-12-31"), row("2026-03-31"), row("2026-06-30", 81.53)]);
  expect(before).toContain("P/E (TTM) 24.64");
  expect(before).toContain("EPS (TTM) and P/E (TTM) are Gloom Cloud's trailing figures, not the last four filed quarters'.");
  expect(before).not.toContain("FY Mar-26");
  const after = report([row("2025-12-31", 66.87), row("2026-03-31", 52.18), row("2026-06-30", 81.53), row("2026-09-30", 87.68)]);
  expect(after).toContain("P/E (TTM) 17.94");
  expect(after).toContain("EPS (TTM) ¥288.26");
  // Itochu (8001): its quarters ended at March, so the filed figure was the year's, 128 beside a served 139.67.
  const itochu = withFiledTrailingEps({ quote: { ...yen, symbol: "8001", price: 2350 }, fundamentals: { eps: 139.67, trailingPE: 16.83 },
    financialCurrency: "JPY", quarterlyStatements: [row("2025-06-30", 40.1), row("2025-09-30"), row("2025-12-31"), row("2026-03-31")],
    annualStatements: [year("2025-03-31", 123.13), year("2026-03-31", 128)], priceHistory: [] }, NOW);
  const read = renderFundamentalsReport({ ...itochu, symbol: "8001" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
  expect(read).toContain("EPS FY Mar-26 ¥128.00");
});
