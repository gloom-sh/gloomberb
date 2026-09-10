import { describe, expect, test } from "bun:test";
import {
  buildFilingPositionRows,
  buildFundHoldingRows,
  buildTimelineRows,
  inferBrowserTabFromQuery,
  latestLikely13FQuarter,
  selectLatestFormsByPeriod,
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

  test("selects the latest filing for each period", () => {
    const selected = selectLatestFormsByPeriod([
      form({ accessionNumber: "old", periodOfReport: "2025-12-31", filedAsOfDate: "2026-02-14" }),
      form({ accessionNumber: "amended", periodOfReport: "2025-12-31", filedAsOfDate: "2026-02-20", isAmendment: true }),
      form({ accessionNumber: "new", periodOfReport: "2026-03-31", filedAsOfDate: "2026-05-15" }),
    ]);
    expect(selected.map((entry) => entry.accessionNumber)).toEqual(["new", "amended"]);
  });

  test("does not replace a full period filing with a supplemental amendment", () => {
    const selected = selectLatestFormsByPeriod([
      form({ accessionNumber: "full", periodOfReport: "2025-03-31", filedAsOfDate: "2025-05-15", tableEntryTotal: 110 }),
      form({
        accessionNumber: "supplemental",
        submissionType: "13F-HR/A",
        periodOfReport: "2025-03-31",
        filedAsOfDate: "2025-06-03",
        tableEntryTotal: 4,
        isAmendment: true,
        amendmentType: "NEW HOLDINGS",
      }),
    ]);
    expect(selected.map((entry) => entry.accessionNumber)).toEqual(["full"]);
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

  test("timeline rows include period-over-period value changes", () => {
    const rows = buildTimelineRows([
      form({ periodOfReport: "2026-03-31", tableValueTotal: 120, amendmentType: "RESTATEMENT" }),
      form({ periodOfReport: "2025-12-31", tableValueTotal: 100 }),
    ]);
    expect(rows[0]?.valueChangePercent).toBeCloseTo(0.2);
    expect(rows[0]).toMatchObject({
      cik: "0001067983",
      companyName: "Fund",
      amendmentType: "RESTATEMENT",
    });
  });
});
