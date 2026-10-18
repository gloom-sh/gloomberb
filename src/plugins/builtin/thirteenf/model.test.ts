import { describe, expect, test } from "bun:test";
import {
  browserSortFor,
  buildFilingPositionRows,
  buildFundHoldingRows,
  buildTimelineRows,
  filingGapFor,
  estimateFilingQuarterReturn,
  filingSplitCandidates,
  formatSplitRatio,
  inferBrowserTabFromQuery,
  latestLikely13FQuarter,
  newestDueQuarter,
  thirteenFDueDate,
  buildPeriodReports,
  oneFundPerCik,
  quartersBehindLatest,
  sortFilingPositionRows,
} from "./model";
import type { FundDetailData, ThirteenFFormSummary, ThirteenFHoldingRecord } from "./types";

function form(overrides: Partial<ThirteenFFormSummary>): ThirteenFFormSummary {
  return {
    url: "",
    accessionNumber: "acc",
    submissionType: "13F-HR",
    periodOfReport: "2026-03-31",
    filedAsOfDate: "2026-05-15",
    cik: "0001067983",
    companyName: "Fund",
    tableValueTotal: 100,
    tableEntryTotal: 2,
    isAmendment: false,
    ...overrides,
  };
}

function holding(overrides: Partial<ThirteenFHoldingRecord>): ThirteenFHoldingRecord {
  return {
    accessionNumber: "acc",
    cik: "0001067983",
    issuer: "Issuer",
    titleOfClass: "COM",
    cusip: "000000000",
    ticker: "AAA",
    value: 10,
    shares: 10,
    shareType: "SH",
    investmentDiscretion: "SOLE",
    votingAuthoritySole: 0,
    votingAuthorityShared: 0,
    votingAuthorityNone: 0,
    putCall: "",
    ...overrides,
  };
}

describe("13F model", () => {
  test("a stored return sort falls back to reported value outside the performance ranking", () => {
    const stored = { columnId: "estQuarterReturn" as const, direction: "desc" as const };
    expect(browserSortFor(stored, "performance")).toBe(stored);
    expect(browserSortFor(stored, "byTicker")).toEqual({ columnId: "value", direction: "desc" });
    expect(browserSortFor({ columnId: "fund", direction: "asc" }, "funds")).toEqual({ columnId: "fund", direction: "asc" });
  });

  test("infers browser mode from command query", () => {
    expect(inferBrowserTabFromQuery("")).toBe("performance");
    expect(inferBrowserTabFromQuery("AAPL")).toBe("byTicker");
    expect(inferBrowserTabFromQuery("berkshire")).toBe("funds");
    expect(inferBrowserTabFromQuery("baker")).toBe("funds");
  });

  test("uses the latest plausibly filed 13F quarter", () => {
    expect(latestLikely13FQuarter(new Date("2026-05-24T00:00:00Z"))).toBe("2026Q1");
    expect(latestLikely13FQuarter(new Date("2026-04-20T00:00:00Z"))).toBe("2025Q4");
    expect(latestLikely13FQuarter(new Date("2026-01-15T00:00:00Z"))).toBe("2025Q3");
    expect(latestLikely13FQuarter(new Date("2026-02-20T00:00:00Z"))).toBe("2025Q4");
  });

  test("counts quarters behind the latest quarter filers have had time to report", () => {
    const now = new Date("2026-10-11T00:00:00Z");
    // Q2 2026 is the latest reported quarter in October; Scion last reported Q3 2025.
    expect(quartersBehindLatest("2025-09-30", now)).toBe(3);
    expect(quartersBehindLatest("2026-03-31", now)).toBe(1);
    expect(quartersBehindLatest("2026-06-30", now)).toBe(0);
    // A filing for a quarter inside the reporting buffer is not ahead of anything.
    expect(quartersBehindLatest("2026-09-30", now)).toBe(0);
    expect(quartersBehindLatest("2025-12-31", new Date("2026-02-20T00:00:00Z"))).toBe(0);
    expect(quartersBehindLatest(undefined, now)).toBeNull();
  });

  test("a 13F is due 45 days after its quarter, past weekends and Presidents' Day, and missed once that day ends in New York", () => {
    expect(thirteenFDueDate("2026-06-30")).toBe("2026-08-14");
    // 14 Nov 2026 is a Saturday; 14 Feb 2026 a Saturday before Presidents' Day.
    expect(thirteenFDueDate("2026-09-30")).toBe("2026-11-16");
    expect(thirteenFDueDate("2025-12-31")).toBe("2026-02-17");
    // Still 14 Aug in New York, so Q2 is not missed yet; four hours later it is.
    expect(newestDueQuarter(new Date("2026-08-15T03:00:00Z"))).toEqual({ period: "2026-03-31", due: "2026-05-15" });
    expect(newestDueQuarter(new Date("2026-08-15T05:00:00Z"))).toEqual({ period: "2026-06-30", due: "2026-08-14" });
  });

  test("the latest EDGAR filing for the missed quarter decides what a fund behind it filed", () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const filing = (form: string, period: string, filed: string) => ({ form, period, filed, accession: `${form}-${filed}`, url: "" });
    const status = { cik: "0001336528", name: "Pershing", source: "", filings: [
      filing("13F-NT", "2026-06-30", "2026-08-14"),
      filing("13F-HR", "2026-06-30", "2026-08-01"),
      filing("13F-HR", "2026-03-31", "2026-05-15"),
    ] };
    expect(filingGapFor("2026-06-30", status, now)).toBeNull();
    expect(filingGapFor("2026-03-31", status, now)).toMatchObject({ period: "2026-06-30", due: "2026-08-14", checked: true, filing: { form: "13F-NT" } });
    expect(filingGapFor("2026-03-31", { ...status, filings: status.filings.slice(2) }, now)).toMatchObject({ filing: null, checked: true });
    expect(filingGapFor("2026-03-31", null, now)).toMatchObject({ filing: null, checked: false });
  });

  test("lists a manager once under the name of its latest filing", () => {
    const funds = [
      { cik: "0001336528", name: "Pershing Square Capital Management, L.P." },
      { cik: "0002026053", name: "PERSHING SQUARE HOLDCO, L.P." },
      { cik: "0002026053", name: "PERSHING SQUARE INC." },
    ];
    expect(oneFundPerCik(funds).map((fund) => fund.name))
      .toEqual(["Pershing Square Capital Management, L.P.", "PERSHING SQUARE HOLDCO, L.P."]);
    const reports = new Map([["0002026053", buildPeriodReports([
      form({ cik: "0002026053", companyName: "PERSHING SQUARE HOLDCO, L.P.", periodOfReport: "2025-12-31" }),
      form({ cik: "0002026053", accessionNumber: "q2", companyName: "PERSHING SQUARE INC.", periodOfReport: "2026-06-30" }),
    ])[0]!]]);
    expect(oneFundPerCik(funds, reports).map((fund) => fund.name))
      .toEqual(["Pershing Square Capital Management, L.P.", "PERSHING SQUARE INC."]);
  });

  test("reconciles additions and smaller full restatements without losing filing history", () => {
    const original = form({ accessionNumber: "original", tableEntryTotal: 110, tableValueTotal: 258701144516 });
    const addition = form({ accessionNumber: "addition", filedAsOfDate: "2026-05-20", isAmendment: true,
      amendmentType: "NEW HOLDINGS", tableEntryTotal: 4, tableValueTotal: 1106550356 });
    const reports = buildPeriodReports([addition, original, addition]);
    expect(reports[0]).toMatchObject({ complete: true, tableEntryTotal: 114, tableValueTotal: 259807694872 });
    expect(reports[0]?.filings.map((entry) => entry.accessionNumber)).toEqual(["original", "addition"]);
    const restatement = form({ accessionNumber: "restated", filedAsOfDate: "2026-06-01", isAmendment: true,
      amendmentType: "RESTATEMENT", tableEntryTotal: 1, tableValueTotal: 20 });
    const extra = { ...addition, accessionNumber: "extra", filedAsOfDate: "2026-06-02" };
    const revised = buildPeriodReports([extra, original, restatement, addition])[0];
    expect(revised?.filings.map((entry) => entry.accessionNumber)).toEqual(["restated", "extra"]);
    expect(revised).toMatchObject({ complete: true, tableEntryTotal: 5, tableValueTotal: 1106550376 });
    expect(buildTimelineRows([original, addition, restatement, extra]).map((row) => row.id))
      .toEqual(["extra", "restated", "addition", "original"]);
    expect(buildTimelineRows([original, addition]).every((row) => row.valueChangePercent === null)).toBe(true);
  });

  test("does not infer a full report from a standalone or untyped amendment", () => {
    const original = form({ accessionNumber: "original" });
    for (const amendmentType of [undefined, "NEW HOLDINGS"]) {
      const amendment = form({ accessionNumber: "amendment", isAmendment: true, amendmentType,
        filedAsOfDate: "2026-05-20" });
      expect(buildPeriodReports([amendment])[0]).toMatchObject({ complete: false, tableValueTotal: null });
      if (!amendmentType) expect(buildPeriodReports([original, amendment])[0]?.complete).toBe(false);
    }
  });

  test("aggregates current and prior holdings into change rows", () => {
    const data: FundDetailData = {
      cik: "0001067983",
      name: "Fund",
      forms: [],
      latestForm: form({ tableValueTotal: 300 }),
      previousForm: form({ accessionNumber: "prev", periodOfReport: "2025-12-31" }),
      latestHoldings: [
        holding({ ticker: "AAA", cusip: "111111111", value: 100, shares: 10 }),
        holding({ ticker: "AAA", cusip: "111111111", value: 80, shares: 5 }),
        holding({ ticker: "BBB", cusip: "222222222", value: 75, shares: 20 }),
      ],
      previousHoldings: [
        holding({ ticker: "AAA", cusip: "111111111", value: 120, shares: 12 }),
        holding({ ticker: "CCC", cusip: "333333333", value: 40, shares: 8 }),
      ],
    };
    const rows = buildFundHoldingRows(data);
    const aaa = rows.find((row) => row.ticker === "AAA");
    const bbb = rows.find((row) => row.ticker === "BBB");
    const ccc = rows.find((row) => row.ticker === "CCC");
    expect(aaa?.value).toBe(180);
    expect(aaa?.sharesChange).toBe(3);
    expect(aaa?.estimatedPnl).toBe(24);
    expect(aaa?.action).toBe("add");
    expect(bbb?.action).toBe("new");
    expect(ccc?.action).toBe("exit");
  });

  test("builds filing position rows without latest/prior comparison fields", () => {
    const rows = buildFilingPositionRows([
      holding({
        ticker: "AAA",
        cusip: "111111111",
        titleOfClass: "COM",
        value: 25,
        shares: 5,
        investmentDiscretion: "SOLE",
      }),
      holding({
        ticker: "BBB",
        cusip: "222222222",
        putCall: "PUT",
        value: 75,
        shares: 10,
        investmentDiscretion: "SHARED",
      }),
    ], 100);
    expect(rows[0]).toMatchObject({
      ticker: "AAA",
      cusip: "111111111",
      weight: 0.25,
      investmentDiscretion: "SOLE",
    });
    expect(sortFilingPositionRows(rows, { columnId: "value", direction: "desc" }).map((row) => row.ticker)).toEqual(["BBB", "AAA"]);
  });

  test("uses CUSIP and security type across ticker and class-label changes, and excludes option P&L", () => {
    const current = [
      holding({ ticker: "NEW", titleOfClass: "ORDINARY", value: 120, shares: 10 }),
      holding({ ticker: "NEW", putCall: "PUT", value: 120, shares: 10 }),
      holding({ ticker: "NEW", shareType: "PRN", value: 500, shares: 500 }),
    ];
    const rows = buildFundHoldingRows({
      cik: "0001067983", name: "Fund", forms: [],
      latestForm: form({}), previousForm: form({ periodOfReport: "2025-12-31" }),
      latestHoldings: current,
      previousHoldings: [
        holding({ ticker: "OLD", titleOfClass: "COM", value: 100, shares: 10 }),
        holding({ ticker: "OLD", putCall: "PUT", value: 100, shares: 10 }),
      ],
    });
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.shareType === "SH" && !row.putCall))
      .toMatchObject({ ticker: "NEW", action: "held", sharesChange: 0, estimatedPnl: 20 });
    expect(rows.find((row) => row.putCall === "PUT"))
      .toMatchObject({ estimatedPnl: null, shares: 10, action: "held" });
    expect(rows.find((row) => row.shareType === "PRN")?.shares).toBe(500);
  });

  test("a fund's quarter estimate prices a split its corporate actions show on split-adjusted shares, a trade as it is, and leaves out one it cannot check", () => {
    const fund = (previous: ThirteenFHoldingRecord[], current: ThirteenFHoldingRecord[]): FundDetailData => ({
      cik: "0001067983", name: "Fund", forms: [],
      latestForm: form({}), previousForm: form({ periodOfReport: "2025-12-31" }),
      latestHoldings: current, previousHoldings: previous,
    });
    // Each candidate line's split factor, by its ticker, as its corporate actions would give it.
    const quarter = (data: FundDetailData, factors: Record<string, number | null> = {}) => {
      const candidates = filingSplitCandidates(data);
      return estimateFilingQuarterReturn(data, new Map(candidates.map((line) => [line.id, factors[line.ticker] ?? null])));
    };
    // BBB is held through at 10 then 11 a share: +10%. Read naively, a 10:1 split of AAA at 100 a share
    // then 12 (120 before the split) is -88%; split-adjusted it is +20%, so the fund is +15% on equal stakes.
    const steady = { previous: holding({ cusip: "B", ticker: "BBB", value: 1000, shares: 100 }), current: holding({ cusip: "B", ticker: "BBB", value: 1100, shares: 100 }) };
    const forward = fund([holding({ cusip: "A", value: 1000, shares: 10 }), steady.previous], [holding({ cusip: "A", value: 1200, shares: 100 }), steady.current]);
    expect(filingSplitCandidates(forward)).toEqual([expect.objectContaining({ ticker: "AAA" })]);
    expect(quarter(forward, { AAA: 10 })).toEqual({ percent: expect.closeTo(15), splits: [{ ticker: "AAA", issuer: "Issuer", ratio: 10 }], skipped: [] });
    // Sold down to 73 of the 100 split shares, the 73 held through gain 2 each on a start of 10: (146 + 100) / (730 + 1000).
    const traded = fund([holding({ cusip: "A", value: 1000, shares: 10 }), steady.previous], [holding({ cusip: "A", value: 876, shares: 73 }), steady.current]);
    expect(quarter(traded, { AAA: 10 })).toMatchObject({ percent: expect.closeTo((246 / 1730) * 100), splits: [expect.objectContaining({ ratio: 10 })] });
    // A 1:10 reverse split of AAA at 1 a share then 9 (0.90 before it): -10%, not +800%.
    const reverse = fund([holding({ cusip: "A", value: 1000, shares: 1000 }), steady.previous], [holding({ cusip: "A", value: 900, shares: 100 }), steady.current]);
    const reversed = quarter(reverse, { AAA: 0.1 });
    expect(reversed.percent).toBeCloseTo(0);
    expect(reversed.splits.map((line) => formatSplitRatio(line.ratio))).toEqual(["1:10"]);
    expect([1.5, 1.25, 50].map(formatSplitRatio)).toEqual(["3:2", "5:4", "50:1"]);
    // Half the shares sold into a 32% rally (Berkshire's Nucor in 2026Q2) moves the same way; with no split it is a trim.
    const trim = fund([holding({ cusip: "A", value: 660_686_383, shares: 3_907_075 })], [holding({ cusip: "A", value: 413_814_258, shares: 1_857_752 })]);
    expect(quarter(trim, { AAA: 1 })).toEqual({ percent: expect.closeTo((222.75 / 169.1 - 1) * 100, 1), splits: [], skipped: [] });
    // Unchecked, a candidate is left out rather than read as a crash or a split it may not be.
    expect(quarter(forward)).toEqual({ percent: expect.closeTo(10), splits: [], skipped: [{ ticker: "AAA", issuer: "Issuer" }] });
    // A crash without a share change, or an add with the price flat, is no candidate.
    for (const current of [holding({ cusip: "A", value: 100, shares: 10 }), holding({ cusip: "A", value: 10000, shares: 100 })]) {
      expect(filingSplitCandidates(fund([holding({ cusip: "A", value: 1000, shares: 10 })], [current]))).toEqual([]);
    }
  });

  test("a line's Est P&L is priced by its split factor: split-adjusted, as a trade, or none, and the fund's estimate is the sum of the same lines", () => {
    const fund = (previous: ThirteenFHoldingRecord[], current: ThirteenFHoldingRecord[]): FundDetailData => ({
      cik: "0001067983", name: "Fund", forms: [],
      latestForm: form({}), previousForm: form({ periodOfReport: "2025-12-31" }),
      latestHoldings: current, previousHoldings: previous,
    });
    const line = (data: FundDetailData, splits?: Map<string, number | null>) => {
      const row = buildFundHoldingRows(data, splits).find((entry) => entry.ticker === "AAA")!;
      return { estimatedPnl: row.estimatedPnl, splitRatio: row.splitRatio, splitUnread: row.splitUnread, id: row.id };
    };
    // 10:1 at 100 a share then 12 (120 before the split), the 100 split shares held through: +2 on each of them.
    // Priced as value over shares it is -88 on each of the 10 old ones, the crash the filings alone show.
    const forward = fund([holding({ cusip: "A", value: 1000, shares: 10 })], [holding({ cusip: "A", value: 1200, shares: 100 })]);
    const { id } = line(forward);
    expect(line(forward, new Map([[id, 10]]))).toEqual({ id, estimatedPnl: 200, splitRatio: 10, splitUnread: undefined });
    // A 1:10 reverse split at 1 a share then 9 (10 before it): -1 on each of the 100 shares held, not +800.
    const reverse = fund([holding({ cusip: "A", value: 1000, shares: 1000 })], [holding({ cusip: "A", value: 900, shares: 100 })]);
    expect(line(reverse, new Map([[id, 0.1]]))).toMatchObject({ estimatedPnl: expect.closeTo(-100), splitRatio: 0.1 });
    // No split between the filings (a trim or a rebalance that moved like one): priced as the filings read.
    const trim = fund([holding({ cusip: "A", value: 660_686_383, shares: 3_907_075 })], [holding({ cusip: "A", value: 413_814_258, shares: 1_857_752 })]);
    expect(line(trim, new Map([[id, 1]]))).toMatchObject({ estimatedPnl: expect.closeTo((413_814_258 / 1_857_752 - 660_686_383 / 3_907_075) * 1_857_752), splitRatio: undefined, splitUnread: undefined });
    // A factor that is null, absent or unlooked-for is left without a figure, and says so; never the crash.
    for (const splits of [new Map([[id, null]]), new Map(), undefined]) {
      expect(line(forward, splits)).toEqual({ id, estimatedPnl: null, splitRatio: undefined, splitUnread: true });
    }
    // The fund's return is the Est P&L of these lines over their start: one rule, so the two cannot disagree.
    const steady = { previous: holding({ cusip: "B", ticker: "BBB", value: 1000, shares: 100 }), current: holding({ cusip: "B", ticker: "BBB", value: 1100, shares: 100 }) };
    const both = fund([holding({ cusip: "A", value: 1000, shares: 10 }), steady.previous], [holding({ cusip: "A", value: 1200, shares: 100 }), steady.current]);
    const splits = new Map([[id, 10]]);
    const pnl = buildFundHoldingRows(both, splits).reduce((sum, row) => sum + (row.estimatedPnl ?? 0), 0);
    expect(estimateFilingQuarterReturn(both, splits).percent).toBeCloseTo((pnl / (1000 + 1000)) * 100);
    // A line that does not move like a split is never unread, whatever the factors are.
    expect(buildFundHoldingRows(fund([steady.previous], [steady.current]), new Map()).every((row) => !row.splitUnread && row.estimatedPnl === 100)).toBe(true);
  });

  test("does not call a first filing or a missing-quarter comparison new buying", () => {
    for (const previousForm of [null, form({ periodOfReport: "2025-09-30" })]) {
      const rows = buildFundHoldingRows({
        cik: "0001067983", name: "Fund", forms: [], latestForm: form({}), previousForm,
        latestHoldings: [holding({ value: 120, shares: 10 })],
        previousHoldings: previousForm ? [holding({ value: 100, shares: 9 })] : [],
      });
      expect(rows[0]).toMatchObject({
        value: 120, shares: 10, previousValue: null, sharesChange: null,
        sharesChangePercent: null, valueChange: null, estimatedPnl: null, action: "unknown",
      });
    }
  });

  test("missing amounts stay unknown through aggregation and incomplete reports do not fabricate exits", () => {
    const latest = form({});
    const previous = form({ accessionNumber: "previous", periodOfReport: "2025-12-31" });
    const data: FundDetailData = { cik: latest.cik, name: "Fund", forms: [latest, previous],
      latestForm: latest, previousForm: previous,
      latestHoldings: [holding({ value: 20, shares: 2 }), holding({ value: null, shares: null })],
      previousHoldings: [holding({ value: 50, shares: 5 }), holding({ cusip: "123456789" })] };
    const rows = buildFundHoldingRows(data);
    expect(rows[0]).toMatchObject({ value: null, shares: null, sharesChange: null,
      valueChange: null, weight: null, estimatedPnl: null, action: "unknown" });
    const report = buildPeriodReports([latest])[0]!;
    report.complete = false;
    expect(buildFundHoldingRows({ ...data, latestReport: report })).toHaveLength(1);
    expect(buildFilingPositionRows([holding({ value: 20 })], null)[0]?.weight).toBeNull();
  });

  test("filing value changes do not bridge a missing quarter", () => {
    const rows = buildTimelineRows([
      form({ accessionNumber: "current", periodOfReport: "2026-03-31" }),
      form({ accessionNumber: "old", periodOfReport: "2025-09-30" }),
    ]);
    expect(rows[0]?.valueChangePercent).toBeNull();
  });

  test("timeline rows include period-over-period value changes", () => {
    const rows = buildTimelineRows([
      form({ accessionNumber: "latest", periodOfReport: "2026-03-31", tableValueTotal: 120, amendmentType: "RESTATEMENT" }),
      form({ accessionNumber: "previous", periodOfReport: "2025-12-31", tableValueTotal: 100 }),
    ]);
    expect(rows[0]?.valueChangePercent).toBeCloseTo(0.2);
    expect(rows[0]).toMatchObject({
      cik: "0001067983",
      companyName: "Fund",
      amendmentType: "RESTATEMENT",
    });
  });
});
