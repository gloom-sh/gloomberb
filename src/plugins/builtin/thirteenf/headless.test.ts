import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import type { HeadlessPaneLoadArgs } from "../../../types/plugin";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { mapForm } from "./api";
import { createThirteenFHeadless } from "./headless";
import { AS_FILED_VALUE, OPTION_ROWS_NOTE, THIRTEENF_LIMITS } from "./report-notes";
import type { FundDetailData } from "./types";
import { createTestHeadlessContext } from "../../../test-support/headless";

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
    const result = await headless.load(args("holdings"), createTestHeadlessContext());
    expect(result.rows.find((row) => row.ticker === "STZ")).toMatchObject({
      action: "exit", previousShares: 632890, sharesChange: -632890,
      shares: null, value: null, estimatedPnl: null,
    });
  });

  test("dates holdings by their filing, flags a fund that stopped filing and marks option rows in text only", async () => {
    const latest = { ...detail.forms[0]!, periodOfReport: "2020-09-30", filedAsOfDate: "2020-11-03" };
    const previous = { ...detail.forms[1]!, periodOfReport: "2020-06-30", filedAsOfDate: "2020-08-14" };
    const put = { ...detail.latestHoldings[0]!, cusip: "69608A108", ticker: "PLTR", putCall: "Put", value: 900, shares: 5 };
    const headless = createThirteenFHeadless({
      loadBrowser: async () => ({ rows: [] }),
      loadDetail: async () => ({ ...detail, forms: [latest, previous], latestForm: latest, previousForm: previous,
        latestHoldings: [...detail.latestHoldings, put] }),
    });
    const result = await headless.load(args("holdings"), createTestHeadlessContext());
    expect(result.metadata?.notices).toEqual([
      "CIK 0001067983 | Period 30 Sep · filed 3 Nov 2020 (34 days after quarter end) | QoQ vs 30 Jun",
      AS_FILED_VALUE,
      expect.stringMatching(/^Latest filing is \d+ quarters old; nothing filed for a later quarter$/),
    ]);
    expect(result.notes).toEqual([THIRTEENF_LIMITS, OPTION_ROWS_NOTE]);
    expect(result.freshness).toMatchObject({ asOf: "2020-11-03", basis: "13F filing for the quarter ended 30 Sep 2020" });
    expect(result.rows.find((row) => row.ticker === "PLTR")?.type).toBe("PUT");
    const text = renderHeadlessPaneText(headless, result, args("holdings"), "13F");
    expect(text).toMatch(/PLTR\s+PUT\*\s/);
    expect(text).toMatch(/AAPL\s+COM\s/);
    expect(text).toContain("not a live feed (13F filing for the quarter ended 30 Sep 2020)");
  });

  test("says which quarters Gloom Cloud restated from thousands", async () => {
    const latest = mapForm({
      cik: detail.cik, accession_number: "0001536411-26-000006", period_of_report: "2026-06-30",
      filed_as_of_date: "2026-08-14", submission_type: "13F-HR", table_value_total: 5_210_860_000,
      value_note: "values restated from thousands",
    })!;
    const headless = createThirteenFHeadless({
      loadBrowser: async () => ({ rows: [] }),
      loadDetail: async () => ({ ...detail, forms: [latest, detail.forms[1]!], latestForm: latest }),
    });
    const note = "Values restated from thousands: 30 Jun 2026";
    expect((await headless.load(args("holdings"), createTestHeadlessContext())).metadata?.notices).toContain(note);
    expect((await headless.load(args("filings"), createTestHeadlessContext())).metadata?.notices).toContain(note);
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
    await expect(headless.load({ ...args("holdings", 1), argument: "Berkshire" }, createTestHeadlessContext()))
      .rejects.toThrow(/Ambiguous 13F fund.*0001067983/);
    expect(loaded).toBe(false);
    expect(lookups).toEqual([25]);
    const exact = await headless.load({ ...args("holdings", 1), argument: "Berkshire Hathaway" }, createTestHeadlessContext());
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

    const browser = await headless.load(args("performance", 1), createTestHeadlessContext());
    expect(browser.rows).toEqual([expect.objectContaining({
      cik: detail.cik,
      name: detail.name,
      estQuarterReturn: 8.2,
    })]);

    const holdings = await headless.load(args("holdings", 5), createTestHeadlessContext());
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
      const loadArgs = { ...args("auto", 40), argument: "KO", rawArgument: "KO" };
      const result = await headless.load(loadArgs, createTestHeadlessContext());
      expect(offsets).toEqual([0, 25]);
      expect(result.rows).toHaveLength(40);
      // The second page loaded 50 funds; the next page starts after the 40 shown, not after the 50 loaded.
      expect(result.metadata).toMatchObject({ view: "ticker-holdings", truncated: true, nextOffset: 40, shown: 40, total: 60 });
      expect(result.metadata?.notices).toEqual([
        "Period 2026-06-30 vs 2026-03-31 | 60 holders (0 new), 0 exited | Value (USD) as reported at period end, not today's price",
        "Showing 40 of 60 funds; the 40 shown hold $4.0k | more: --offset 40 or --limit 200",
      ]);
      expect(typeof headless.describe === "function" ? headless.describe(loadArgs, result) : null).toBe("13F Holders | KO");
    });

    test("crowding with a ticker shows that ticker's rank, or says it is not ranked", async () => {
      const security = (ticker: string, newCount: number) => ({ id: ticker, ticker, cusip: ticker, issuer: ticker, type: "SH", holderCount: newCount,
        newCount, exitCount: 0, comparedFunds: newCount, totalValue: 100, weightChange: null });
      spy = spyOn(apiClient, "getCloudSec13F").mockImplementation((async () => ({ quarter: "2026Q2", period: "2026-06-30", previousPeriod: "2026-03-31",
        warnings: [], asOf: "", requestedFunds: 25, sourceFunds: 25, loadedFunds: 25,
        rows: [security("AAA", 1), security("BBB", 3), security("CCC", 2), security("DDD", 2)] })) as never);
      const headless = createThirteenFHeadless({ loadBrowser: async () => ({ rows: [] }), loadDetail: async () => detail });
      const crowding = (ticker: string) => headless.load({ ...args("crowding"), argument: ticker || null, rawArgument: ticker }, createTestHeadlessContext());

      const ranking = await crowding("");
      expect(ranking.rows.map((row) => row.ticker)).toEqual(["BBB", "CCC", "DDD", "AAA"]);
      expect(ranking.metadata?.notices).toEqual(["2026-06-30: 25/25 ranked funds"]);

      const found = await crowding("$ddd");
      // Tied on new holders with CCC, so it shares second place.
      expect(found.rows).toEqual([expect.objectContaining({ ticker: "DDD", rank: 2 })]);
      expect(found.metadata).toMatchObject({ ticker: "DDD", found: true, rankedSecurities: 4 });
      expect(found.metadata?.notices).toContain("DDD ranks 2 of 4 securities by new holders | full ranking: fn 13F --view crowding");

      const missing = await crowding("CAR");
      expect(missing.rows).toEqual([]);
      expect(missing.metadata?.notices).toContain("CAR is not in this ranking | full ranking: fn 13F --view crowding | its 13F holders: fn 13F CAR");
    });

    test("a ticker in any case lists its holders; without holders it falls back to its holders' books, then to funds of that name", async () => {
      const asked: string[] = [];
      spy = spyOn(apiClient, "getCloudSec13F").mockImplementation((async (_view: string, params: { tickers: string }) => {
        asked.push(params.tickers);
        if (params.tickers === "KO" || params.tickers === "BRK.B" || params.tickers === "BRK-B") return page(0, 2, false);
        throw new Error(`No 13F CUSIP found for ${params.tickers}`);
      }) as never);
      const tabs: string[] = [];
      const tiger = { id: "tiger", cik: "0001167483", name: "Tiger Global Management LLC", periodOfReport: "2026-06-30", source: "funds" as const };
      const headless = createThirteenFHeadless({
        loadBrowser: async (tab, query) => {
          tabs.push(`${tab}:${query}`);
          return tab === "funds" && query.toLowerCase() === "tiger" ? { rows: [tiger] } : { rows: [], ...(tab === "byTicker" ? { warning: `No CUSIP found for ${query.toUpperCase()}` } : {}) };
        },
        loadDetail: async () => detail,
      });
      const load = (word: string, view = "auto") => headless.load({ ...args(view), argument: word, rawArgument: word }, createTestHeadlessContext());

      for (const word of ["ko", "$ko", "brk.b", "BRK-B"]) expect((await load(word)).metadata).toMatchObject({ view: "ticker-holdings" });
      expect(asked).toEqual(["KO", "KO", "BRK.B", "BRK-B"]);
      expect(tabs).toEqual([]);

      // A lowercase fund name that is no ticker still finds the fund, without a word about tickers.
      const lower = await load("tiger");
      expect(tabs).toEqual(["byTicker:tiger", "funds:tiger"]);
      expect(lower.rows).toEqual([expect.objectContaining({ cik: tiger.cik })]);
      expect(lower.errors).toBeUndefined();
      expect(lower.metadata?.notices).toEqual([]);
      expect((await load("TIGER")).metadata?.notices).toEqual(["No 13F holders found for the ticker TIGER; funds named like it"]);

      // Nothing anywhere: how to search instead, not "No data.".
      const none = await load("ZZZZ");
      expect(none.metadata).toMatchObject({ view: "funds" });
      expect(none.errors).toBeUndefined();
      expect(renderHeadlessPaneText(headless, none, args("auto"), "13F")).toContain(
        'No 13F filer or ticker matches "ZZZZ". Search by fund name or CIK, as in fn 13F "Berkshire Hathaway".',
      );
      await expect(load("ZZZZ", "ticker-holdings")).rejects.toThrow(/No 13F CUSIP/);
    });
  });
});

describe("13F empty searches, limits and missing filings", () => {
  afterEach(() => setSystemTime());

  test("a name with no 13F filer says to search by fund name or CIK", async () => {
    const headless = createThirteenFHeadless({ loadBrowser: async () => ({ rows: [] }), loadDetail: async () => detail });
    const loadArgs = { ...args("auto"), argument: "Warren Buffett", rawArgument: "Warren Buffett" };
    const text = renderHeadlessPaneText(headless, await headless.load(loadArgs, createTestHeadlessContext()), loadArgs, "13F");
    expect(text).toContain('No 13F filer matches "Warren Buffett". Search by fund name or CIK, as in fn 13F "Berkshire Hathaway".');
    expect(text).not.toContain("No data.");
    await expect(headless.load({ ...loadArgs, options: { view: "holdings", limit: 50 } }, createTestHeadlessContext()))
      .rejects.toThrow('No 13F fund found for "Warren Buffett". Search by fund name or CIK, as in fn 13F "Berkshire Hathaway".');
  });

  test("the performance ranking reads a --limit over 100 as 100, says so, and never offers more than it serves", async () => {
    const limits: number[] = [];
    const headless = createThirteenFHeadless({
      loadBrowser: async (_tab, _query, limit) => {
        limits.push(limit);
        return { rows: Array.from({ length: limit }, (_, index) => ({ id: `${index}`, cik: `${index}`, name: `Fund ${index}`, source: "performance" as const })), hasMore: true };
      },
      loadDetail: async () => detail,
    });
    const over = await headless.load({ ...args("performance", 101), argument: null, rawArgument: "" }, createTestHeadlessContext());
    expect(limits).toEqual([100]);
    expect(over.rows).toHaveLength(100);
    expect(over.metadata?.notices).toEqual(["Showing the first 100 | the performance ranking stops at 100 (--limit 101 read as 100)"]);
    const under = await headless.load({ ...args("performance", 50), argument: null, rawArgument: "" }, createTestHeadlessContext());
    expect(under.metadata?.notices).toEqual(["Showing the first 50 | more: --limit 100"]);
  });

  test("a fund behind the newest due quarter names its 13F-NT and the manager that reported, or says no 13F was filed", async () => {
    setSystemTime(new Date("2026-10-18T12:00:00Z"));
    const notice = {
      period: "2026-06-30", due: "2026-08-14", checked: true,
      filing: { form: "13F-NT", period: "2026-06-30", filed: "2026-08-14", accession: "0001172661-26-003777", url: "https://www.sec.gov/nt",
        otherManagers: [{ cik: "0002026053", name: "PERSHING SQUARE INC.", fileNumber: "028-25746" }] },
    };
    const rows = [
      { id: "psc", cik: "0001336528", name: "Pershing Square Capital Management, L.P.", periodOfReport: "2026-03-31", source: "funds" as const },
      { id: "psi", cik: "0002026053", name: "PERSHING SQUARE INC.", periodOfReport: "2026-06-30", source: "funds" as const },
      { id: "quiet", cik: "0000000007", name: "Quiet Fund", periodOfReport: "2026-03-31", source: "funds" as const },
    ];
    const asked: string[] = [];
    const headless = createThirteenFHeadless({
      loadBrowser: async () => ({ rows }),
      loadDetail: async () => ({ ...detail, filingGap: notice }),
      loadFilingGap: async (cik) => {
        asked.push(cik);
        return cik === "0001336528" ? notice : { period: "2026-06-30", due: "2026-08-14", filing: null, checked: true };
      },
    });
    const search = await headless.load({ ...args("auto"), argument: "Pershing", rawArgument: "Pershing" }, createTestHeadlessContext());
    // Only the funds behind are looked up.
    expect(asked).toEqual(["0001336528", "0000000007"]);
    expect(search.metadata?.notices).toEqual([
      "Pershing Square Capital Management, L.P.: 13F-NT for Q2 2026, filed 14 Aug; holdings reported by PERSHING SQUARE INC. | open: fn 13F 0002026053",
      "Quiet Fund: no 13F for Q2 2026, due 14 Aug",
    ]);
    const holdings = await headless.load(args("holdings"), createTestHeadlessContext());
    expect(holdings.metadata?.notices).toContain("13F-NT for Q2 2026, filed 14 Aug; holdings reported by PERSHING SQUARE INC. | open: fn 13F 0002026053");
    expect(holdings.metadata?.filingGap).toMatchObject({ filing: { url: "https://www.sec.gov/nt" } });
  });
});

describe("13F overlap against an ETF and flags", () => {
  const etfFunds = [{ ticker: "IVV", name: "S&P 500", aliases: ["SPY", "SPX"], changes: "sp500" as const, asOf: "2026-10-08" }, { ticker: "IWM", name: "Russell 2000", aliases: [], changes: "none" as const, asOf: "2026-10-08" }];
  const etfFile = { fund: etfFunds[0]!, asOf: "2026-10-08", stale: false, members: [{ symbol: "AAPL", weight: 0.07 }, { symbol: "MSFT", weight: 0.93 }] } as never;
  const searched: string[] = [];
  const managers = [{ id: "spy", cik: "0000000009", name: "Spyglass Capital Management LLC", source: "funds" as const }];
  const headless = createThirteenFHeadless({
    loadBrowser: async (_tab, query) => { searched.push(query); return { rows: managers.filter((row) => row.name.toLowerCase().includes(query.toLowerCase())) }; },
    loadDetail: async (cik) => cik === detail.cik ? detail : { ...detail, cik, name: "Spyglass Capital Management LLC" },
    loadEtfFunds: async () => etfFunds,
    loadEtfHoldings: async () => etfFile,
  });
  const load = (options: Record<string, string | number>, argument = "1067983") => headless.load({ rawArgument: argument, argument: argument || null, symbols: [], options: { view: "auto", limit: 50, ...options } }, createTestHeadlessContext());

  test("a ticker MEMB covers compares with its holdings file, and --compare alone implies the overlap view", async () => {
    searched.length = 0;
    const result = await load({ compare: "spy" });
    expect(searched).toEqual([]);
    expect(result.metadata).toMatchObject({ view: "overlap", comparedWith: "etf", secondFund: "SPY", etf: { ticker: "IVV", asOf: "2026-10-08" }, comparedPeriod: "2026-06-30", filed: "2026-08-14" });
    expect(result.metadata?.overlap).toBeCloseTo(0.07);
    expect(result.metadata?.notices).toEqual(expect.arrayContaining([
      "--compare implies --view overlap",
      "SPY read as an ETF: S&P 500 holdings (IVV file), as fn MEMB SPY shows",
      "Overlap 7.0% (sum of the smaller weight per name) | Active share 93.0%",
      "Quarter compared: 30 Jun 2026, filed 14 Aug 2026 | SPY holdings as of 8 Oct 2026",
      "SPY holds every position in the 13F",
    ]));
  });

  test("an uncovered ticker names the covered ETFs and never falls back to a partial manager name", async () => {
    await expect(load({ view: "overlap", compare: "VTV" })).rejects.toThrow(
      'VTV is not an ETF MEMB covers (covered: IVV (also SPY, SPX), IWM), and no 13F manager is named "VTV". For a manager, use its CIK or full name.',
    );
    // A longer name is still a manager lookup.
    const fund = await load({ compare: "Spyglass" });
    expect(fund.metadata).toMatchObject({ comparedWith: "fund", secondFund: "Spyglass Capital Management LLC" });
  });

  test("overlap without --compare asks for it; --compare with another view fails; unused flags are named", async () => {
    await expect(load({ view: "overlap" })).rejects.toThrow(/add --compare <fund name, CIK or ETF ticker>, as in fn 13F 1067983 --compare SPY/);
    await expect(load({ view: "holdings", compare: "SPY" })).rejects.toThrow(/--view holdings does not use it/);
    const holdings = await load({ rank: "exits", offset: 25 });
    expect(holdings.metadata?.notices).toEqual(expect.arrayContaining([
      "--rank orders --view crowding only; ignored here",
      "--offset pages a ticker's holders only; ignored here",
    ]));
  });
});
