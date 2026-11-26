import { expect, setSystemTime, test } from "bun:test";
import { atLivePriceEarnings, liveTrailingPE } from "../market-data/quotes/live-valuation";
import { projectPeBand } from "../plugins/builtin/pe-band/model";
import { buildEventRows } from "../plugins/builtin/research/event-model";
import { relativeValuationValues } from "../plugins/builtin/research/relative-valuation-model";
import { mapCloudFinancials } from "../sources/gloomberb-cloud/normalizers";
import { scopedFixture, scopedNyseCloseFixture } from "../test-support/scoped-earnings";
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

test("decimal quarter EPS corroborates the admitted annual amount only at the later field date", () => {
  const { raw, quarters, filed, quote, before, after } = scopedFixture();
  const annualStatements = raw.annualStatements.map(row => ({ ...row, eps: 0.70 }));
  const quarterlyStatements = quarters.map((row, index) => ({ ...row, eps: [0.10, 0.20, 0.30, 0.10][index],
    availableAt: "2028-02-15", fieldAvailability: { eps: filed } }));
  const admitted = (eps: number) => mapCloudFinancials({ ...raw, annualStatements, quarterlyStatements,
    fundamentals: { ...raw.fundamentals, eps, trailingPE: 70 / eps } });
  const at = (data: TickerFinancials, lastUpdated: number) => withFiledTrailingEps({ ...data, quote: { ...quote, price: 70, lastUpdated } }, after).fundamentals;
  const matched = admitted(0.70);
  expect(at(matched, before)?.trailingPE).toBeUndefined();
  expect(matched.fundamentals?.scopedEarnings?.epsAvailableAt).toBe(filed);
  expect(at(matched, after)).toMatchObject({ eps: 0.70, trailingPE: 100 });
  const binarySum = quarterlyStatements.reduce((sum, row) => sum + row.eps!, 0);
  const binaryAdmitted = mapCloudFinancials({ ...raw, fundamentals: { ...raw.fundamentals, eps: binarySum, trailingPE: 70 / binarySum },
    annualStatements: annualStatements.map(row => ({ ...row, fieldAvailability: { eps: filed } })),
    quarterlyStatements: quarterlyStatements.map(row => ({ ...row, fieldAvailability: { eps: "2028-02-15" } })) });
  expect(binaryAdmitted.fundamentals?.scopedEarnings).toMatchObject({ eps: binarySum, epsAvailableAt: filed });
  for (const unsupported of [0.70000001, 0.7000000000000002]) {
    const unmatched = at(admitted(unsupported), after);
    expect(unmatched?.eps).toBeUndefined();
    expect(unmatched?.trailingPE).toBeUndefined();
  }
  const offsetting = [0.10, 0.20, -0.30, 0.001];
  const offsetSum = offsetting.reduce((sum, value) => sum + value, 0);
  const offsetQuarters = quarterlyStatements.map((row, index) => ({ ...row, eps: offsetting[index] }));
  expect(at(mapCloudFinancials({ ...raw, annualStatements: [], quarterlyStatements: offsetQuarters,
    fundamentals: { ...raw.fundamentals, eps: 0.001, trailingPE: 70000 } }), after)).toMatchObject({ eps: 0.001, trailingPE: 70000 });
  for (const [annualFiled, quarterFiled] of [["2028-02-15", filed], [filed, "2028-02-15"]] as const) {
    const support = (eps: number) => mapCloudFinancials({ ...raw,
      annualStatements: annualStatements.map(row => ({ ...row, eps: 0.001, fieldAvailability: { eps: annualFiled } })),
      quarterlyStatements: offsetQuarters.map(row => ({ ...row, fieldAvailability: { eps: quarterFiled } })),
      fundamentals: { ...raw.fundamentals, eps, trailingPE: 70 / eps } });
    for (const eps of [0.001, offsetSum]) {
      const data = support(eps);
      expect(data.fundamentals?.scopedEarnings).toMatchObject({ eps, epsAvailableAt: filed });
      expect(at(data, before)?.trailingPE).toBeUndefined();
      expect(at(data, after)).toMatchObject({ eps, trailingPE: 70 / eps });
    }
    expect(support(0.00100000000000005).fundamentals?.scopedEarnings).toBeNull();
  }
});

test("a scoped filing steps at effective closes, not the midnight label of a later NYSE close", () => {
  const { data, onFilingDay } = scopedNyseCloseFixture();
  const series = (period: "daily" | "annual") => extractFundamentalSeries(data, { kind: "security", instrument: { symbol: "VYLR" }, fieldId: "valuation.trailingPE", period });
  const band = () => projectPeBand({ ...data, quote: { ...data.quote, listingExchangeName: undefined } }, [{ date: new Date("2028-02-14"), close: 999 }],
    { symbol: "VYLR", exchange: "NYSE", lookbackYears: 1, daily: data.priceHistory });
  try {
    setSystemTime(onFilingDay(17));
    expect(band().rows).toMatchObject([{ knownAt: onFilingDay(17), price: null, pe: null }]);
    expect(band().points).toEqual([]);
    setSystemTime(onFilingDay(20));
    expect(series("daily").map(point => point.value)).toEqual([null, 20]);
    const beforeClose = band();
    expect(beforeClose.rows).toMatchObject([{ knownAt: onFilingDay(17), priceAt: onFilingDay(18), price: 65, pe: 20 }]);
    expect(beforeClose.points).toMatchObject([{ date: onFilingDay(18), close: 65, pe: 20 }]);
    setSystemTime(onFilingDay(21));
    expect(series("daily").map(point => [point.date, point.value])).toEqual([
      [onFilingDay(16), null], [onFilingDay(18), 20], [onFilingDay(21), 24],
    ]);
    expect(series("annual")).toMatchObject([{ value: 20, date: onFilingDay(18), availableAt: onFilingDay(18) }]);
    const atClose = band();
    expect(atClose.current?.pe).toBeNull();
    expect(atClose.rows).toMatchObject([{ priceAt: onFilingDay(18), price: 65, pe: 20 }]);
    expect(atClose.weeks).toMatchObject([{ date: onFilingDay(21), close: 78, pe: 24 }]);
    expect(atClose.points).toMatchObject([{ date: onFilingDay(18), close: 65, pe: 20 }, { date: onFilingDay(21), close: 78, pe: 24 }]);
    const unknownSession = { ...data, quote: { ...data.quote, listingExchangeName: undefined }, priceHistory: [{ date: new Date("2028-02-18"), close: 78 }] };
    setSystemTime(new Date("2028-02-18T01:00:00Z"));
    expect(projectPeBand(unknownSession, [], { symbol: "VYLR", lookbackYears: 1 }).points).toEqual([]);
  } finally { setSystemTime(); }
});

test("a scoped period point waits for the first priced close even with a stale current quote", () => {
  const { raw, quote, end, after } = scopedFixture();
  setSystemTime(after);
  try {
    const data = { ...mapCloudFinancials(raw), quote: { ...quote, stale: true }, priceHistory: [
      { date: new Date("2028-02-18T16:00:00Z"), close: 0 }, { date: new Date(after), close: 65 },
    ] };
    const series = (period: "daily" | "annual") => extractFundamentalSeries(data, { kind: "security", instrument: { symbol: "VYLR" }, fieldId: "valuation.trailingPE", period });
    expect(series("daily").map(point => point.value)).toEqual([null, 20]);
    expect(series("annual").filter(point => point.periodLabel !== "Current")).toMatchObject([
      { value: 20, date: new Date(after), availableAt: new Date(after), observedAt: new Date(end) },
    ]);
    expect(projectPeBand(data, [], { symbol: "VYLR", lookbackYears: 1 }).rows).toMatchObject([{ priceAt: new Date(after), price: 65, pe: 20 }]);
  } finally { setSystemTime(); }
});

test("scoped headlines and repricing use the reviewed denominator, not the overlapping year or a cached multiple", () => {
  const { raw, quarters, scope, end, filed, quote, before, after } = scopedFixture();
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
    const report = (data: TickerFinancials) => renderFundamentalsReport({ ...data, symbol: "VYLR" }, "valuation").replace(/\u001b\[[0-9;]*m/g, "").replace(/ {2,}/g, " ");
    const headline = report(withFiledTrailingEps(admitted, after));
    expect(headline).toContain("P/E (TTM) 20.00");
    expect(headline).toContain("EPS (TTM) $3.25");
    const daily = (data: TickerFinancials) => extractFundamentalSeries(data, { kind: "security", instrument: { symbol: "VYLR" }, fieldId: "valuation.trailingPE", period: "daily" }).map(point => point.value);
    expect(daily(admitted)).toEqual([null, 20]);
    const periods = (data: TickerFinancials) => extractFundamentalSeries(data, { kind: "security", instrument: { symbol: "VYLR" }, fieldId: "valuation.trailingPE", period: "annual" })
      .filter(point => point.periodLabel !== "Current" && point.value !== null);
    const stale = { ...admitted, quote: { ...quote, stale: true } };
    expect(project(stale)).toMatchObject({ eps: 3.25, pe: undefined, live: undefined, band: undefined, chart: undefined, peer: null });
    expect(withFiledTrailingEps(stale, after).fundamentals?.trailingPE).toBeUndefined();
    expect(report(stale)).not.toMatch(/P\/E \(TTM\) \d/);
    expect(daily(stale)).toEqual([null, 20]);
    expect(projectPeBand(stale, stale.priceHistory, { symbol: "VYLR", lookbackYears: 1, now: after }).weeks.map(week => week.pe)).toContain(20);
    expect(periods(stale)).toMatchObject([{ periodLabel: `Year ended ${end}`, value: 20, observedAt: new Date(end), availableAt: new Date(after) }]);
    const earlierClose = { date: new Date("2028-02-14T21:00Z"), close: 65 };
    const history = [earlierClose, ...admitted.priceHistory];
    expect(periods({ ...admitted, priceHistory: history }).map(point => point.value)).toEqual([20]);
    expect(periods({ ...admitted, priceHistory: history.slice(0, -1) })).toEqual([]);
    const ordinary = { ...mapCloudFinancials({ ...raw, statementScope: undefined, quarterlyStatements: [], annualStatements: raw.annualStatements.map(row => ({ ...row, statementScope: undefined })) }), quote, priceHistory: history };
    expect(periods(ordinary).map(point => point.value)).toEqual([65 / 3]);
    const delayed = { ...raw,
      quarterlyStatements: quarters.map(row => ({ ...row, availableAt: "2028-02-15", fieldAvailability: { eps: filed } })) };
    const fieldDated = { ...mapCloudFinancials(delayed), quote };
    expect(project({ ...fieldDated, quote: { ...quote, lastUpdated: before } }).pe).toBeUndefined();
    expect(project(fieldDated).pe).toBe(20);
    expect(daily(fieldDated)).toEqual([null, 20]);
    expect(periods(fieldDated).map(point => point.value)).toEqual([20]);
    const bothMatch = { ...mapCloudFinancials({ ...delayed, annualStatements: delayed.annualStatements.map(row => ({ ...row, eps: 3.25 })) }), quote };
    expect(project({ ...bothMatch, quote: { ...quote, lastUpdated: before } }).pe).toBeUndefined();
    expect(project(bothMatch).pe).toBe(20);
    for (const quarterlyStatements of [quarters.slice(1), quarters.map(row => ({ ...row, eps: 1 })),
      quarters.map((row, index) => index === 0 ? { ...row, date: "2026-12-31" } : row)]) {
      expect(project({ ...mapCloudFinancials({ ...delayed, quarterlyStatements }), quote }).eps).toBeUndefined();
    }
    const legacy = { ...fieldDated, fundamentals: JSON.parse(JSON.stringify({ ...fieldDated.fundamentals, scopedEarnings: { eps: 3.25, currency: "USD", periodEnd: end, priced: true, availableAt: "2028-02-15" } })) };
    expect(atLivePriceEarnings(legacy).fundamentals.trailingPE).toBeUndefined();
    expect(project({ ...legacy, quote: { ...quote, lastUpdated: before } }).pe).toBeUndefined();
    expect(project(legacy).pe).toBe(20);
    const noFieldDate = mapCloudFinancials({ ...delayed, quarterlyStatements: delayed.quarterlyStatements.map(row => row.date === end ? { ...row, fieldAvailability: {} } : row) });
    expect(project({ ...noFieldDate, quote }).pe).toBeUndefined();
    const annualOnly = mapCloudFinancials({ ...raw, quarterlyStatements: quarters.map(row => ({ ...row, availableAt: "2028-02-14", fieldAvailability: {} })),
      annualStatements: raw.annualStatements.map(row => ({ ...row, fieldAvailability: { eps: filed } })), fundamentals: { ...raw.fundamentals, eps: 3, trailingPE: 65 / 3 } });
    expect(project({ ...annualOnly, quote: { ...quote, lastUpdated: before } }).pe).toBeUndefined();
    expect(project({ ...annualOnly, quote }).pe).toBeCloseTo(65 / 3);
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
    expect(periods({ ...incomplete, quote, priceHistory: history })).toEqual([]);
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
    const unpriced = { ...mapCloudFinancials({ ...raw, fundamentals: { ...raw.fundamentals, trailingPE: undefined } }), quote, priceHistory: history };
    expect(project(unpriced)).toMatchObject({ ...blank, eps: 3.25 });
    expect(periods(unpriced)).toEqual([]);
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
