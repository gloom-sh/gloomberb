import { expect, test } from "bun:test";
import pltrShares from "./sec-edgar-shares.fixture.json";
import { parseCompanyFactsFinancialStatements } from "./sec-edgar";

const fact = (overrides: Record<string, unknown> = {}) => ({
  start: "2023-01-01", end: "2023-12-31", val: 100,
  form: "10-K", filed: "2024-02-01", accn: "0000789019-24-000001", ...overrides,
});

test("SEC native projection retains filed weighted-average shares and separates quarter from YTD", () => {
  // Untouched SEC companyfacts observations captured 2026-09-16.
  const result = parseCompanyFactsFinancialStatements(pltrShares);
  expect(result.annualStatements.map(({ date, basicShares, dilutedShares }) => ({ date, basicShares, dilutedShares }))).toEqual([
    { date: "2023-12-31", basicShares: 2_147_446_000, dilutedShares: 2_297_927_000 },
    { date: "2024-12-31", basicShares: 2_250_163_000, dilutedShares: 2_450_818_000 },
    { date: "2025-12-31", basicShares: 2_369_612_000, dilutedShares: 2_565_197_000 },
  ]);
  expect(result.quarterlyStatements).toHaveLength(1);
  expect(result.quarterlyStatements[0]).toMatchObject({ date: "2026-06-30", basicShares: 2_399_820_000, dilutedShares: 2_568_694_000 });
  expect(result.annualStatements[1]?.fieldAvailability).toEqual({ basicShares: "2025-02-18", dilutedShares: "2025-02-18" });
});

  test("keeps real zero share counts, rejects unavailable/wrong-unit facts and selects dated revisions", () => {
    const result = parseCompanyFactsFinancialStatements({ cik: 789019, facts: { "us-gaap": {
      WeightedAverageNumberOfSharesOutstandingBasic: { units: { shares: [
        fact({ val: 0 }),
        fact({ val: 40, end: "2022-12-31", start: "2022-01-01" }),
        fact({ val: 44, end: "2022-12-31", start: "2022-01-01", filed: "2025-02-01" }),
        fact({ val: Number.NaN, end: "2021-12-31", start: "2021-01-01" }),
        fact({ val: Number.POSITIVE_INFINITY, end: "2020-12-31", start: "2020-01-01" }),
        fact({ val: null, end: "2019-12-31", start: "2019-01-01" }),
      ] } },
      WeightedAverageNumberOfDilutedSharesOutstanding: { units: { USD: [fact({ val: 99 })] } },
    } } })
    expect(result.annualStatements).toHaveLength(2)
    expect(result.annualStatements[0]).toMatchObject({ date: "2022-12-31", basicShares: 44, fieldAvailability: { basicShares: "2025-02-01" } })
    expect(result.annualStatements[1]?.basicShares).toBe(0)
    expect(result.annualStatements[1]?.dilutedShares).toBeUndefined()
  })

  test("adds raw share counts only on a verified current split basis without scaling old denominators", () => {
    const priorAccn = "0000320193-19-000119", splitAccn = "0000320193-20-000096"
    const before = fact({ start: "2017-10-01", end: "2018-09-29", val: 8, filed: "2019-10-31", accn: priorAccn })
    const after = { ...before, val: 2, filed: "2020-10-30", accn: splitAccn }
    const older = { ...before, start: "2016-09-25", end: "2017-09-30", val: 4 }
    const disconnected = { ...older, start: "2015-09-27", end: "2016-09-24", filed: "2016-10-31", accn: "0000320193-16-000001" }
    const eps = [before, after, older, disconnected]
    const result = parseCompanyFactsFinancialStatements({ cik: 320193, facts: { "us-gaap": {
      EarningsPerShareDiluted: { units: { "USD/shares": eps } },
      NetIncomeLoss: { units: { USD: eps.map((row) => ({ ...row, val: 40 })) } },
      StockholdersEquityNoteStockSplitConversionRatio1: { units: { pure: [{ end: "2020-08-28", val: 4, accn: splitAccn, filed: "2020-10-30", form: "10-K" }] } },
      WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: eps.map((row) => ({ ...row, val: row.accn === splitAccn ? 20 : 5 })) } },
      WeightedAverageNumberOfSharesOutstandingBasic: { units: { shares: eps.map((row) => ({ ...row, val: row.accn === splitAccn ? 16 : 4 })) } },
    } } })
    // The split's 10-K re-expresses the year's EPS; the figure keeps its original filing.
    expect(result.annualStatements.find((row) => row.date === after.end)).toMatchObject({ eps: 2, basicShares: 16, dilutedShares: 20,
      epsBasis: { factor: 4, originalFiled: "2019-10-31" } })
    const scaledEps = result.annualStatements.find((row) => row.date === older.end)!
    expect(scaledEps.eps).toBe(1)
    expect(scaledEps.basicShares).toBeUndefined()
    expect(scaledEps.dilutedShares).toBeUndefined()
    expect(scaledEps.fieldAvailability?.dilutedShares).toBeUndefined()
    const unresolved = result.annualStatements.find((row) => row.date === disconnected.end)!
    expect(unresolved.epsBasis?.status).toBe("unresolved")
    expect(unresolved.basicShares).toBeUndefined()
    expect(unresolved.dilutedShares).toBeUndefined()
  })

