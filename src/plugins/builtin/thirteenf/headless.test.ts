import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { createTestDataProvider } from "../../../test-support/data-provider";
import { createDefaultConfig } from "../../../types/config";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createThirteenFHeadless } from "./headless";
import type { FundDetailData } from "./types";

const detail: FundDetailData = {
  cik: "0001067983",
  name: "Berkshire Hathaway",
  forms: [
    {
      url: "https://www.sec.gov/latest",
      accessionNumber: "latest",
      submissionType: "13F-HR",
      periodOfReport: "2026-06-30",
      filedAsOfDate: "2026-08-14",
      cik: "0001067983",
      companyName: "Berkshire Hathaway",
      tableValueTotal: 300,
      tableEntryTotal: 2,
      isAmendment: false,
    },
    {
      url: "https://www.sec.gov/previous",
      accessionNumber: "previous",
      submissionType: "13F-HR",
      periodOfReport: "2026-03-31",
      filedAsOfDate: "2026-05-15",
      cik: "0001067983",
      companyName: "Berkshire Hathaway",
      tableValueTotal: 200,
      tableEntryTotal: 1,
      isAmendment: false,
    },
  ],
  latestForm: null,
  previousForm: null,
  latestHoldings: [],
  previousHoldings: [],
};
detail.latestForm = detail.forms[0]!;
detail.previousForm = detail.forms[1]!;
detail.latestHoldings = [
  {
    accessionNumber: "latest",
    cik: detail.cik,
    issuer: "Apple Inc",
    titleOfClass: "COM",
    cusip: "037833100",
    ticker: "AAPL",
    value: 300,
    shares: 3,
    shareType: "SH",
    investmentDiscretion: "DFND",
    votingAuthoritySole: 3,
    votingAuthorityShared: 0,
    votingAuthorityNone: 0,
    putCall: "",
  },
];
detail.previousHoldings = [{ ...detail.latestHoldings[0]!, accessionNumber: "previous", value: 200, shares: 2 }];

function context(): HeadlessPaneContext {
  return {
    marketData: createTestDataProvider(),
    apiClient: {} as HeadlessPaneContext["apiClient"],
    config: createDefaultConfig("/tmp/gloomberb-headless-thirteenf"),
    signal: new AbortController().signal,
  };
}

function args(view: string, limit = 50): HeadlessPaneLoadArgs {
  return {
    rawArgument: "1067983",
    argument: "1067983",
    symbols: [],
    options: { view, limit },
  };
}

describe("13F headless model", () => {
  test("retains prior-quarter positions omitted from the current disclosed report", async () => {
    const headless = createThirteenFHeadless({
      loadBrowser: async () => ({ rows: [] }),
      loadDetail: async () => ({ ...detail, previousHoldings: [
        ...detail.previousHoldings,
        { ...detail.previousHoldings[0]!, cusip: "21036P108", ticker: "STZ", shares: 632890, value: 94933500 },
      ] }),
    });
    const result = await headless.load(args("holdings"), context());
    expect(result.rows.find((row) => row.ticker === "STZ")).toMatchObject({
      action: "exit", previousShares: 632890, sharesChange: -632890,
      shares: null, value: null, estimatedPnl: null,
    });
  });

  test("requires an unambiguous manager even when the requested output has only one row", async () => {
    const lookups: number[] = [];
    let loaded = false;
    const headless = createThirteenFHeadless({
      loadBrowser: async (_tab, _query, limit) => {
        lookups.push(limit);
        return { rows: [
          { id: "asset", cik: "0000949012", name: "Berkshire Asset Management", source: "funds" },
          { id: "hathaway", cik: detail.cik, name: detail.name, source: "funds" },
        ] };
      },
      loadDetail: async () => { loaded = true; return detail; },
    });
    await expect(headless.load({ ...args("holdings", 1), argument: "Berkshire" }, context()))
      .rejects.toThrow(/Ambiguous 13F fund.*0001067983/);
    expect(loaded).toBe(false);
    expect(lookups).toEqual([25]);
    const exact = await headless.load({ ...args("holdings", 1), argument: "Berkshire Hathaway" }, context());
    expect(exact.metadata?.cik).toBe(detail.cik);
  });

  test("projects browser rows and switches to fund holdings", async () => {
    const headless = createThirteenFHeadless({
      loadBrowser: async () => ({
        rows: [
          { id: "one", cik: detail.cik, name: detail.name, estQuarterReturn: 8.2, source: "performance" },
          { id: "two", cik: "0000000002", name: "Second Fund", estQuarterReturn: 4.1, source: "performance" },
        ],
        quarter: "2026Q2",
      }),
      loadDetail: async () => detail,
    });

    const browser = await headless.load(args("performance", 1), context());
    expect(browser.rows).toEqual([expect.objectContaining({
      cik: detail.cik,
      name: detail.name,
      estQuarterReturn: 8.2,
    })]);

    const holdings = await headless.load(args("holdings", 5), context());
    expect(holdings.rows).toEqual([expect.objectContaining({
      ticker: "AAPL",
      value: 300,
      sharesChange: 1,
      action: "add",
      actionLabel: "Add",
    })]);
    expect(holdings.metadata).toMatchObject({ view: "holdings", fund: detail.name });
  });

  describe("ticker argument", () => {
    const holder = (index: number) => ({ id: `f${index}`, cik: `${index}`, fund: `Fund ${index}`, ticker: "KO", cusip: "191216100", issuer: "Coca-Cola",
      type: "SH", value: 100, shares: 1, weight: null, previousWeight: null, weightChange: null, action: "held" });
    const page = (offset: number, count: number, hasMore: boolean) => ({ ticker: "KO", quarter: "2026Q2", period: "2026-06-30", previousPeriod: "2026-03-31",
      rows: Array.from({ length: count }, (_, index) => holder(offset + index)), warnings: [], asOf: "", holderCount: 60, newCount: 0, exitCount: 0,
      totalValue: null, valueScope: "page", hasMore, nextOffset: offset + count });
    let spy: ReturnType<typeof spyOn> | null = null;
    afterEach(() => { spy?.mockRestore(); spy = null; });

    test("pages holders up to the limit and reports more", async () => {
      const offsets: number[] = [];
      spy = spyOn(apiClient, "getCloudSec13F").mockImplementation((async (_view: string, params: { offset: number }) => {
        offsets.push(params.offset);
        return page(params.offset, 25, params.offset < 50);
      }) as never);
      const headless = createThirteenFHeadless({ loadBrowser: async () => ({ rows: [] }), loadDetail: async () => detail });
      const result = await headless.load({ ...args("auto", 40), argument: "KO", rawArgument: "KO" }, context());
      expect(offsets).toEqual([0, 25]);
      expect(result.rows).toHaveLength(40);
      expect(result.metadata).toMatchObject({ view: "ticker-holdings", truncated: true });
    });

    test("falls back to the holders listing for a ticker without a mapped CUSIP", async () => {
      spy = spyOn(apiClient, "getCloudSec13F").mockImplementation((async () => { throw new Error("No 13F CUSIP found for ZZZZ"); }) as never);
      const tabs: string[] = [];
      const headless = createThirteenFHeadless({ loadBrowser: async (tab) => { tabs.push(tab); return { rows: [], warning: "No 13F holders for ZZZZ" }; }, loadDetail: async () => detail });
      const result = await headless.load({ ...args("auto"), argument: "ZZZZ", rawArgument: "ZZZZ" }, context());
      expect(tabs).toEqual(["byTicker"]);
      expect(result.metadata).toMatchObject({ view: "byTicker" });
      await expect(headless.load({ ...args("ticker-holdings"), argument: "ZZZZ", rawArgument: "ZZZZ" }, context())).rejects.toThrow(/No 13F CUSIP/);
    });
  });
});
