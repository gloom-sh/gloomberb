import { describe, expect, test } from "bun:test";
import {
  coalesceFinancialPeriodAliases, fillDate, fillDateText, filledPeriodPublications, filledPeriodsNote, halfYearGrowthPeriod, hasOlderStatements, mergeFinancialStatementRows, reportsHalfYearly, stalePeriodNote, statementHistoryNotes,
} from "./financial-statements";
import { computeTTM } from "../plugins/builtin/ticker-detail/financials/aggregation";
import { exchangeResultsNotes, matchExchangeResults } from "./exchange-results";
import type { FinancialStatement } from "../types/financials";

test("period evidence follows the selected fiscal date without inventing field availability", () => {
  const dateEvidence = { accessionNumber: "0000909832-26-000050", filed: "2026-06-04", startDate: "2026-02-16" };
  const fiscal: FinancialStatement = { date: "2026-05-10", currency: "USD", dateSource: "sec", dateEvidence, totalRevenue: 70527, netIncome: 2192, totalAssets: 81639 };
  const provider: FinancialStatement = { ...fiscal, date: "2026-05-31", dateSource: "provider", dateEvidence: undefined };
  for (const [primary, fallback] of [[provider, fiscal], [fiscal, provider]] as const) {
    const [merged] = mergeFinancialStatementRows([primary], [fallback]);
    expect(merged).toMatchObject({ date: fiscal.date, dateSource: "sec", dateEvidence });
    expect(merged?.availableAt).toBeUndefined();
    expect(merged?.fieldAvailability).toBeUndefined();
  }
  const sameDate = mergeFinancialStatementRows([{ ...provider, date: fiscal.date }], [fiscal])[0]!;
  expect(sameDate.dateEvidence).toEqual(dateEvidence);
  const different = mergeFinancialStatementRows([{ ...provider, date: "2026-05-09", totalRevenue: 1 }], [{ ...fiscal, availableAt: "2026-06-04" }])[0]!;
  expect(different.date).toBe("2026-05-09");
  expect(different.dateSource).toBe("provider");
  expect(different.dateEvidence).toBeUndefined();
});

describe("mergeFinancialStatementRows", () => {
  test("merging and JSON roundtrips preserve unknown fields in an authoritative availability map", () => {
    const primary: FinancialStatement = {
      date: "2025-12-31", availableAt: "2026-04-01", totalRevenue: 100, grossProfit: 40,
      fieldAvailability: { grossProfit: "2026-02-01" },
    };
    const fallback: FinancialStatement = { date: primary.date, netIncome: 10, availableAt: "2026-03-01" };
    const merged = JSON.parse(JSON.stringify(mergeFinancialStatementRows([primary], [fallback])[0])) as FinancialStatement;
    expect(merged).toMatchObject({ totalRevenue: 100, grossProfit: 40, netIncome: 10,
      fieldAvailability: { grossProfit: "2026-02-01", netIncome: "2026-03-01" } });
    expect(merged.availableAt).toBeUndefined();
    expect(merged.fieldAvailability?.totalRevenue).toBeUndefined();
    expect(mergeFinancialStatementRows([merged], [fallback])[0]).toEqual(merged);
    // Independent evidence may date a matching retained value, but not a different one.
    const [corroborated] = mergeFinancialStatementRows([merged], [{ date: primary.date, totalRevenue: 100, availableAt: "2026-02-15" }]);
    expect(corroborated?.fieldAvailability?.totalRevenue).toBe("2026-02-15");
    expect(corroborated?.availableAt).toBe("2026-03-01");
    const [emptyMap] = mergeFinancialStatementRows([{ ...primary, fieldAvailability: {} }], [{ date: primary.date }]);
    expect(emptyMap?.fieldAvailability).toEqual({});
    expect(emptyMap?.availableAt).toBeUndefined();
  });

  test("preserves per-field availability across providers", () => {
    const [merged] = mergeFinancialStatementRows(
      [{
        date: "2025-12-31",
        totalRevenue: 120,
        availableAt: "2026-02-10",
        fieldAvailability: { totalRevenue: "2026-02-10" },
      }],
      [{
        date: "2025-12-31",
        grossProfit: 72,
        availableAt: "2026-02-12",
        fieldAvailability: { grossProfit: "2026-02-12" },
      }],
    );

    expect(merged).toMatchObject({
      availableAt: "2026-02-12",
      totalRevenue: 120,
      grossProfit: 72,
      fieldAvailability: {
        totalRevenue: "2026-02-10",
        grossProfit: "2026-02-12",
      },
    });
  });

  test("never attaches fallback provenance to a different primary value", () => {
    const [merged] = mergeFinancialStatementRows(
      [{
        date: "2025-12-31",
        totalRevenue: 120,
        availableAt: "2026-03-15",
      }],
      [{
        date: "2025-12-31",
        totalRevenue: 100,
        fieldAvailability: { totalRevenue: "2026-02-01" },
      }],
    );

    expect(merged).toMatchObject({
      totalRevenue: 120,
      availableAt: "2026-03-15",
      fieldAvailability: { totalRevenue: "2026-03-15" },
    });
  });

  test("copies fallback availability only when the retained value matches", () => {
    const [matching] = mergeFinancialStatementRows(
      [{ date: "2025-12-31", totalRevenue: 100 }],
      [{
        date: "2025-12-31",
        totalRevenue: 100,
        fieldAvailability: { totalRevenue: "2026-02-01" },
      }],
    );
    const [different] = mergeFinancialStatementRows(
      [{ date: "2025-12-31", totalRevenue: 120 }],
      [{
        date: "2025-12-31",
        totalRevenue: 100,
        fieldAvailability: { totalRevenue: "2026-02-01" },
      }],
    );

    expect(matching?.fieldAvailability?.totalRevenue).toBe("2026-02-01");
    expect(different?.fieldAvailability?.totalRevenue).toBeUndefined();
    expect(different?.availableAt).toBeUndefined();
  });

  test("coalesces calendar-normalized and issuer fiscal period ends", () => {
    const merged = mergeFinancialStatementRows(
      [
        { date: "2025-06-30", totalRevenue: 94_036 },
        { date: "2025-09-30", totalRevenue: 102_466 },
      ],
      [
        {
          date: "2025-06-28",
          totalRevenue: 94_036,
          fieldAvailability: { totalRevenue: "2025-08-01" },
        },
        {
          date: "2025-09-27",
          totalRevenue: 102_466,
          fieldAvailability: { totalRevenue: "2025-10-31" },
        },
      ],
    );

    expect(merged).toEqual([
      {
        date: "2025-06-28",
        availableAt: "2025-08-01",
        totalRevenue: 94_036,
        fieldAvailability: { totalRevenue: "2025-08-01" },
      },
      {
        date: "2025-09-27",
        availableAt: "2025-10-31",
        totalRevenue: 102_466,
        fieldAvailability: { totalRevenue: "2025-10-31" },
      },
    ]);
  });

  test("does not coalesce statement rows outside the fiscal-close tolerance", () => {
    const merged = mergeFinancialStatementRows(
      [{ date: "2025-06-30", totalRevenue: 94_036 }],
      [{
        date: "2025-07-15",
        totalRevenue: 94_036,
        fieldAvailability: { totalRevenue: "2025-08-01" },
      }],
    );

    expect(merged.map((row) => row.date)).toEqual(["2025-06-30", "2025-07-15"]);
  });

  test("retains a primary fiscal close when only the fallback is calendar-normalized", () => {
    const merged = mergeFinancialStatementRows(
      [{
        date: "2025-06-28",
        totalRevenue: 94_036,
        fieldAvailability: { totalRevenue: "2025-08-01" },
      }],
      [{ date: "2025-06-30", totalRevenue: 94_036 }],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]?.date).toBe("2025-06-28");
  });
});


test("does not fill a reporting-currency row from differently denominated statements", () => {
  expect(mergeFinancialStatementRows(
    [{ date: "2025-12-31", currency: "TWD", totalRevenue: 3_800_000_000_000 }],
    [{ date: "2025-12-31", currency: "USD", totalRevenue: 120_000_000_000, netIncome: 60_000_000_000 }],
  )).toEqual([{ date: "2025-12-31", currency: "TWD", totalRevenue: 3_800_000_000_000 }]);
});

test("filing-backed fiscal dates coalesce proven month-end aliases, including older cached duplicates", () => {
  const provider = { date: "2026-05-31", currency: "USD", totalRevenue: 70_527_000_000, netIncome: 2_192_000_000, operatingIncome: 2_815_000_000 };
  const fiscal = { date: "2026-05-10", totalRevenue: provider.totalRevenue, netIncome: provider.netIncome, operatingIncome: provider.operatingIncome, availableAt: "2026-06-04" };
  const [merged] = coalesceFinancialPeriodAliases([provider, fiscal]);
  expect(merged).toMatchObject({ date: "2026-05-10", currency: "USD", availableAt: "2026-06-04" });
  expect(coalesceFinancialPeriodAliases([fiscal, provider])).toEqual([merged!]);
  expect(coalesceFinancialPeriodAliases([merged!, provider, fiscal])).toEqual([merged!]);
  const quarters = coalesceFinancialPeriodAliases([
    { date: "2025-08-31", currency: "USD", totalRevenue: 86_156_000_000 },
    { date: "2025-11-23", currency: "USD", totalRevenue: 67_307_000_000 },
    { date: "2026-02-15", currency: "USD", totalRevenue: 69_597_000_000 },
    provider, fiscal,
  ]);
  expect(computeTTM(quarters)?.totalRevenue).toBe(293_587_000_000);
  for (const distinct of [
    { ...fiscal, netIncome: fiscal.netIncome + 1 },
    { ...fiscal, currency: "CAD" },
    { ...fiscal, date: "2026-06-10" },
    { ...fiscal, availableAt: undefined },
  ]) {
    expect(coalesceFinancialPeriodAliases([provider, distinct])).toHaveLength(2);
  }
});

describe("statementHistoryNotes", () => {
  test("names the oldest period a report served, and points to GF only when its history goes further back", () => {
    // A trailing-twelve-months column has no date; the oldest year is the oldest period end.
    expect(statementHistoryNotes("annual", ["TTM", "2025-12-31", "2024-12-31", "2023-12-31"], "KO", true)).toEqual([
      "annual history from 2023; older years not served",
      "earlier years, one metric at a time: gloom fn GF KO --period annual --periods 40",
    ]);
    // GF holds nothing older (IAG on LSE starts in 2022 there too): no pointer to the same years.
    expect(statementHistoryNotes("annual", ["2024-06-30", "2025-06-30"], "SAN:EPA", false))
      .toEqual(["annual history from 2024; older years not available for this listing"]);
    expect(statementHistoryNotes("quarterly", ["2026-06-30", "2025-03-28"], "KO", true)).toEqual([
      "quarterly history from 2025-03-28; older quarters not served",
      "earlier quarters, one metric at a time: gloom fn GF KO --period quarterly --periods 40",
    ]);
    // Unknown (the history was not read in time): nothing is said of older quarters.
    expect(statementHistoryNotes("quarterly", ["2025-03-28"], "KO", null)).toEqual([]);
    // A report with no dated period has nothing to say about its history.
    expect(statementHistoryNotes("annual", [], "KO", true)).toEqual([]);
    expect(statementHistoryNotes("annual", ["TTM"], "KO", true)).toEqual([]);
  });

  test("hasOlderStatements reads the extended history for a period older than the report's oldest", async () => {
    const extended = { annualStatements: [{ date: "2019-12-31" }, { date: "2023-12-31" }], quarterlyStatements: [{ date: "2025-03-31" }] };
    const load = async () => extended;
    expect(await hasOlderStatements(load, "annual", ["TTM", "2024-12-31", "2023-12-31"])).toBe(true);
    expect(await hasOlderStatements(load, "annual", ["2019-12-31", "2023-12-31"])).toBe(false);
    expect(await hasOlderStatements(load, "quarterly", ["2025-03-31"])).toBe(false);
    // Nothing dated to compare against, or a failed read: unknown.
    expect(await hasOlderStatements(load, "annual", ["TTM"])).toBeNull();
    expect(await hasOlderStatements(async () => { throw new Error("down"); }, "annual", ["2023-12-31"])).toBeNull();
  });

  test("hasOlderStatements stops waiting at its deadline, so a slow history leaves the report on time", async () => {
    let answer: (value: { annualStatements: FinancialStatement[]; quarterlyStatements: FinancialStatement[] }) => void = () => {};
    const slow = () => new Promise<{ annualStatements: FinancialStatement[]; quarterlyStatements: FinancialStatement[] }>((resolve) => { answer = resolve; });
    const started = Date.now();
    expect(await hasOlderStatements(slow, "annual", ["2023-12-31"], 20)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    // The answer arriving after it changes nothing.
    answer({ annualStatements: [{ date: "2019-12-31" }], quarterlyStatements: [] });
  });
});

test("reportsHalfYearly: an Australian or New Zealand listing, or periods half a year apart", () => {
  expect(reportsHalfYearly("ASX", [])).toBe(true);
  expect(reportsHalfYearly("nzx", [{ date: "2025-06-30" }])).toBe(true);
  // Qantas served under a venue the app does not know: its periods say it.
  expect(reportsHalfYearly(null, [{ date: "2026-06-30" }, { date: "2025-06-30" }, { date: "2025-12-31" }])).toBe(true);
  expect(reportsHalfYearly("LSE", [{ date: "2025-03-31" }, { date: "2025-06-30" }, { date: "2025-09-30" }])).toBe(false);
  // One quarter missing between two is still a quarterly reporter.
  expect(reportsHalfYearly("LSE", [{ date: "2025-03-31" }, { date: "2025-09-30" }, { date: "2025-12-31" }])).toBe(false);
  expect(reportsHalfYearly("XETRA", [{ date: "2025-06-30" }])).toBe(false);
  // The venue never outweighs the periods: ResMed's quarters on ASX.
  expect(reportsHalfYearly("ASX", [{ date: "2026-03-31" }, { date: "2026-06-30" }, { date: "2026-09-30" }])).toBe(false);
});

test("halfYearGrowthPeriod: names halves only when the periods are halves, never from the venue", () => {
  const years = [{ date: "2024-12-31" }, { date: "2025-12-31" }] as FinancialStatement[];
  // Pop Mart on HKEX: interims a year apart, each closing the half to June of a December year.
  const popMart = { annualStatements: years, quarterlyStatements: [{ date: "2025-06-30" }, { date: "2026-06-30" }] as FinancialStatement[] };
  expect(halfYearGrowthPeriod(popMart)).toBe("H1 2026 vs H1 2025");
  // A March year's half to September is its first; a 52-week half ending early in October closes September.
  const march = { annualStatements: [{ date: "2026-03-31" }] as FinancialStatement[], quarterlyStatements: [{ date: "2025-10-04" }, { date: "2026-03-31" }] as FinancialStatement[] };
  expect(halfYearGrowthPeriod(march)).toBe("H2 FY26 vs H2 FY25");
  // Quarters: the figure is a quarter's, and the label stays the quarter's.
  const quarters = { annualStatements: years, quarterlyStatements: [{ date: "2026-03-31" }, { date: "2026-06-30" }, { date: "2026-09-30" }] as FinancialStatement[] };
  expect(halfYearGrowthPeriod(quarters)).toBeNull();
  // ResMed and James Hardie list on ASX and report quarters: their June year's quarters stay quarters.
  const resMed = { annualStatements: [{ date: "2026-06-30" }] as FinancialStatement[],
    quarterlyStatements: [{ date: "2025-12-31" }, { date: "2026-03-31" }, { date: "2026-06-30" }, { date: "2026-09-30" }] as FinancialStatement[] };
  expect(halfYearGrowthPeriod(resMed)).toBeNull();
  expect(reportsHalfYearly("ASX", [], [])).toBe(true);
});

describe("stalePeriodNote", () => {
  test("says how old a latest period over 15 months old is, from the newest period with the lead figure", () => {
    const now = Date.parse("2026-10-22T02:00:00Z");
    // EVN:ASX's balance sheet stopped at 2024-06-30.
    expect(stalePeriodNote([{ date: "2024-06-30", lead: true }, { date: "2023-06-30", lead: true }], now))
      .toBe("Latest period 2024-06-30 is 27 months old.");
    // Its income statement has a FY2025 column with EPS alone: the latest full period is FY2024's.
    expect(stalePeriodNote([{ date: "TTM", lead: true }, { date: "2025-06-30", lead: false }, { date: "2024-06-30", lead: true }], now))
      .toBe("Latest period 2024-06-30 is 27 months old; 2025-06-30 has only some figures.");
    // 15 months to the day is not over 15 months; a day more is.
    expect(stalePeriodNote([{ date: "2025-07-22", lead: true }], now)).toBeNull();
    expect(stalePeriodNote([{ date: "2025-07-21", lead: true }], now)).toBe("Latest period 2025-07-21 is 15 months old.");
    expect(stalePeriodNote([{ date: "2026-06-30", lead: true }], now)).toBeNull();
    // No dated column, or none with the lead figure: the newest period stands.
    expect(stalePeriodNote([{ date: "TTM", lead: true }], now)).toBeNull();
    expect(stalePeriodNote([{ date: "2024-12-31", lead: false }], now)).toBe("Latest period 2024-12-31 is 21 months old.");
  });
});

describe("filled years", () => {
  const filledFrom = { source: "asx" as const, page: "https://www.asx.com.au/markets/company/EVN", retrievedAt: "2026-10-22T01:00:00.000Z", fields: ["totalRevenue" as const, "netIncome" as const] };
  test("a merged row names only the filled lines it still holds as filled", () => {
    const filled: FinancialStatement = { date: "2025-06-30", currency: "AUD", totalRevenue: 4.351e9, netIncome: 9.26e8, filledFrom };
    // Another source's own revenue for the year wins and is its own; the filled net income stays filled.
    const [merged] = mergeFinancialStatementRows([{ date: "2025-06-30", currency: "AUD", totalRevenue: 4.4e9, eps: 0.46 }], [filled]);
    expect(merged).toMatchObject({ totalRevenue: 4.4e9, netIncome: 9.26e8, eps: 0.46, filledFrom: { ...filledFrom, fields: ["netIncome"] } });
    const [replaced] = mergeFinancialStatementRows([{ date: "2025-06-30", currency: "AUD", totalRevenue: 4.4e9, netIncome: 9.3e8 }], [filled]);
    expect(replaced).not.toHaveProperty("filledFrom");
    expect(filledPeriodsNote([replaced!])).toBeNull();
    expect(filledPeriodsNote([merged!], new Set(["totalAssets"]))).toBeNull();
    expect(filledPeriodsNote([merged!])).toBe("From ASX key statistics (read 2026-10-22): 2025-06-30 net income.");
  });
});

describe("periods read from a results announcement", () => {
  const announcement = {
    source: "hkex" as const,
    kind: "interim_results" as const,
    title: "INTERIM RESULTS ANNOUNCEMENT FOR THE SIX MONTHS ENDED 30 JUNE 2026",
    url: "https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0820/2026082000353.pdf",
    publishedAt: "2026-08-20T08:30:00.000Z",
    fetchedAt: "2026-11-11T01:00:00.000Z",
  };
  const report = { ...announcement, kind: "interim_report" as const, title: "INTERIM REPORT 2026", publishedAt: "2026-09-24T08:39:00.000Z" };
  const half: FinancialStatement = {
    date: "2026-06-30", currency: "CNY", totalRevenue: 17.17e9, netIncome: 5.04e9, operatingCashFlow: 3.64e9, totalAssets: 31e9,
    filledFrom: {
      source: "results", fields: ["totalRevenue", "netIncome", "operatingCashFlow"], documents: [announcement, report],
      lines: { totalRevenue: { document: 0, page: 3 }, netIncome: { document: 0, page: 3 }, operatingCashFlow: { document: 1, page: 41 } },
      periodMonths: 6,
    },
  };
  test("each period is dated by its announcement and says how many months it covers", () => {
    const year: FinancialStatement = {
      date: "2025-12-31", currency: "CNY", totalRevenue: 37.12e9,
      filledFrom: { source: "results", fields: ["totalRevenue"], documents: [{ ...announcement, kind: "annual_results", publishedAt: "2026-03-25T04:22:00.000Z" }], lines: { totalRevenue: { document: 0, page: 2 } } },
    };
    expect(filledPeriodsNote([year, half])).toBe(
      "From the company's results announcements: 6 months to 2026-06-30 revenue, net income, operating cash flow (published 2026-08-20); 2025-12-31 revenue (published 2026-03-25).",
    );
    expect(filledPeriodsNote([half], new Set(["operatingCashFlow"]))).toBe(
      "From the company's results announcements: 6 months to 2026-06-30 operating cash flow (published 2026-08-20).",
    );
  });
  test("a TTM to the half is dated by the half's results, each day is said once, and the results line does not repeat it", () => {
    const annual = { ...announcement, kind: "annual_results" as const, publishedAt: "2026-03-25T04:22:00.000Z" };
    // Pop Mart's TTM to 2026-06-30 lists the year's announcement beside the half's; its figures came out with the half.
    const ttm = { date: "TTM", currency: "CNY", totalRevenue: 40.4e9, aggregation: { periodEnd: "2026-06-30" },
      filledFrom: { ...half.filledFrom!, fields: ["totalRevenue" as const], documents: [annual, announcement, report], periodMonths: undefined } };
    const year: FinancialStatement = { date: "2025-12-31", currency: "CNY", totalRevenue: 37.12e9,
      filledFrom: { source: "results", fields: ["totalRevenue"], documents: [annual], lines: { totalRevenue: { document: 0, page: 2 } } } };
    // 2024 read from the 2025 announcement's comparative column: dated by that announcement as its comparative.
    const comparative: FinancialStatement = { ...year, date: "2024-12-31", filledFrom: { ...year.filledFrom!, documents: [{ ...annual }] } };
    expect(filledPeriodsNote([ttm, year])).toBe(
      "From the company's results announcements: TTM revenue (published 2026-08-20); 2025-12-31 revenue (published 2026-03-25).");
    expect(filledPeriodsNote([year, comparative])).toBe("From the company's results announcements: 2025-12-31 revenue (published 2026-03-25); "
      + "2024-12-31 revenue (comparative in the 2026-03-25 announcement).");
    const dated = filledPeriodPublications([ttm, year]);
    expect(dated).toEqual([{ periodEnd: "2026-06-30", published: "2026-08-20" }, { periodEnd: "2025-12-31", published: "2026-03-25" }]);
    const results = matchExchangeResults("2026-06-30", [
      { date: "2026-08-20T08:30:00Z", headline: "INTERIM RESULTS", types: ["Interim Results"], priceSensitive: null, fileSize: null, documentKey: "1", url: "u" }])!;
    expect(exchangeResultsNotes(results)).toEqual(["Latest half year 2026-06-30, interim results announced 2026-08-20 (HKEXnews)."]);
    expect(exchangeResultsNotes(results, dated)).toEqual([]);
    // A fill dated by another day leaves the line.
    expect(exchangeResultsNotes(results, [{ periodEnd: "2026-06-30", published: "2026-09-24" }])).toHaveLength(1);
  });

  test("a later period's comparative column is dated by that period's first announcement, never by a report published after it", () => {
    // Pop Mart's H1 2025: the 2026 interim report's comparative column (published 2026-09-24).
    const prior: FinancialStatement = { ...half, date: "2025-06-30", filledFrom: { ...half.filledFrom!, documents: [report] } };
    expect(fillDate(half, [half, prior])).toEqual({ label: "published", date: "2026-08-20" });
    // The row a year on was announced 2026-08-20.
    const dated = fillDate(prior, [half, prior])!;
    expect(fillDateText(dated)).toBe("comparative in the 2026-08-20 announcement");
    // Without that row: the first results announcement among its own documents, else no day at all.
    expect(fillDate({ ...prior, filledFrom: { ...prior.filledFrom!, documents: [announcement, report] } })).toEqual({ label: "comparative", date: "2026-08-20" });
    expect(fillDateText(fillDate(prior)!)).toBe("comparative in a later announcement");
    // A report published within the year after its period ended is its own: H1 2025's own interim report, 2025-09-20.
    expect(fillDate({ ...prior, filledFrom: { ...prior.filledFrom!, documents: [{ ...report, publishedAt: "2025-09-20T08:00:00.000Z" }] } }))
      .toEqual({ label: "published", date: "2025-09-20" });
  });

  test("a quarter read from the next quarter's earnings release is that release's comparative, not announced with it", () => {
    // HSBC: each quarter's earnings release also states the quarter before.
    const release = (title: string, publishedAt: string) => ({ ...announcement, kind: "quarterly_results" as const, title, publishedAt });
    const quarter = (date: string, documents: ReturnType<typeof release>[]): FinancialStatement => ({
      date, currency: "USD", eps: 0.27,
      filledFrom: { source: "results", fields: ["eps"], documents, lines: { eps: { document: 0, page: 4 } } },
    });
    const q2 = quarter("2025-06-30", [release("Earnings Release 3Q25", "2025-10-28T04:00:00.000Z")]);
    const q3 = quarter("2025-09-30", [release("Earnings Release 3Q25", "2025-10-28T04:00:00.000Z")]);
    const q4 = quarter("2025-12-31", [release("Earnings Release 1Q26", "2026-05-05T04:00:00.000Z")]);
    // The source's own 1Q26, not filled.
    const q1: FinancialStatement = { date: "2026-03-31", currency: "USD", eps: 0.4 };
    const rows = [q1, q4, q3, q2];
    expect(fillDate(q3, rows)).toEqual({ label: "published", date: "2025-10-28" });
    expect(fillDateText(fillDate(q2, rows)!)).toBe("comparative in the 2025-10-28 announcement");
    expect(fillDateText(fillDate(q4, rows)!)).toBe("comparative in the 2026-05-05 announcement");
    // The interim results give the second quarter before the third ends: its own.
    const q2026 = quarter("2026-06-30", [{ ...release("2026 Interim results", "2026-08-04T04:00:00.000Z"), kind: "interim_results" as const }]);
    expect(fillDate(q2026, [...rows, q2026, { date: "2026-09-30", currency: "USD" }])).toEqual({ label: "published", date: "2026-08-04" });
    // A fourth quarter derived from the year and nine months is the year's, however late the year came out.
    const derived: FinancialStatement = { ...quarter("2025-12-31", [{ ...release("2025 Annual results", "2026-04-15T04:00:00.000Z"), kind: "annual_results" as const }]) };
    derived.filledFrom = { ...derived.filledFrom!, derived: "12 months to 2025-12-31 − 9 months to 2025-09-30" } as FinancialStatement["filledFrom"];
    expect(fillDate(derived, [q1, derived, q3])).toEqual({ label: "published", date: "2026-04-15" });
    expect(filledPeriodsNote(rows)).toBe("From the company's results announcements: 2025-12-31 diluted EPS (comparative in the 2026-05-05 announcement); "
      + "2025-09-30 diluted EPS (published 2025-10-28); 2025-06-30 diluted EPS (comparative in the 2025-10-28 announcement).");
    // Its revenue counts otherwise than the source's quarters around it: left blank, and the note says why.
    const q3_2026 = quarter("2026-09-30", [release("Earnings Release 3Q26", "2026-10-27T04:00:00.000Z")]);
    q3_2026.filledFrom = { ...q3_2026.filledFrom!, omitted: ["totalRevenue"] } as FinancialStatement["filledFrom"];
    expect(filledPeriodsNote([q3_2026, q2026])).toBe("From the company's results announcements: 2026-09-30 diluted EPS (published 2026-10-27); "
      + "2026-06-30 diluted EPS (published 2026-08-04). 2026-09-30 revenue left blank: the company's results announcements count it otherwise "
      + "than the statements source.");
    expect(filledPeriodsNote([q3_2026], new Set(["eps"]))).toBe("From the company's results announcements: 2026-09-30 diluted EPS (published 2026-10-27).");
  });

  test("a merged row keeps the documents' lines it still holds", () => {
    const [merged] = mergeFinancialStatementRows([{ date: "2026-06-30", currency: "CNY", totalRevenue: 17.2e9 }], [half]);
    expect(merged?.filledFrom).toMatchObject({ source: "results", fields: ["netIncome", "operatingCashFlow"], periodMonths: 6 });
  });
});

