import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import type { HeadlessPaneLoadArgs } from "../../../types/plugin";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { mapForm } from "./api";
import { createThirteenFHeadless, thirteenFHeadless } from "./headless";
import { AS_FILED_VALUE, filingGapText, OPTION_ROWS_NOTE, THIRTEENF_LIMITS } from "./report-notes";
import type { FundPerformanceResult } from "./data";
import type { FundDetailData } from "./types";
import { createTestDataProvider } from "../../../test-support/data-provider";
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

  test("holdings price a line that moved as across a split by its corporate actions, and name the lines split-adjusted or left without a figure", async () => {
    // KLAC 10:1 at 120 a share before the split and 12 after (-88 on each old share, read naively): 10 shares became 100, so it is held, not an add. ODD moves the same way.
    const line = (ticker: string, cusip: string, value: number, shares: number, accessionNumber: string) =>
      ({ ...detail.latestHoldings[0]!, ticker, cusip, issuer: `${ticker} Corp`, value, shares, accessionNumber });
    const headless = createThirteenFHeadless({
      loadBrowser: async () => ({ rows: [] }),
      loadDetail: async () => ({
        ...detail,
        latestHoldings: [line("KLAC", "482480100", 1200, 100, "latest"), line("ODD", "999999999", 1200, 100, "latest"), detail.latestHoldings[0]!],
        previousHoldings: [line("KLAC", "482480100", 1000, 10, "previous"), line("ODD", "999999999", 1000, 10, "previous"), detail.previousHoldings[0]!],
      }),
    });
    const looked: string[] = [];
    const actions = (ticker: string) => ticker === "KLAC"
      ? { symbol: ticker, dividends: [], earnings: [], splits: [{ date: "2026-05-04", fromFactor: 1, toFactor: 10 }] }
      : Promise.reject(new Error("corporate actions down"));
    const context = createTestHeadlessContext({ marketData: createTestDataProvider({
      getCorporateActions: async (ticker) => { looked.push(ticker); return actions(ticker); },
    }) });
    const result = await headless.load(args("holdings"), context);
    // Only the lines that move like a split are looked up; AAPL, added to at a flat price, is read as it stands.
    expect(looked.sort()).toEqual(["KLAC", "ODD"]);
    expect(result.rows.find((row) => row.ticker === "KLAC")).toMatchObject({ estimatedPnl: 200, splitRatio: 10, sharesChange: 0, action: "held" });
    expect(result.rows.find((row) => row.ticker === "ODD")).toMatchObject({ estimatedPnl: null, splitUnread: true, sharesChange: 90, action: "add" });
    expect(result.rows.find((row) => row.ticker === "AAPL")).toMatchObject({ estimatedPnl: 0 });
    expect(result.metadata?.notices).toEqual(expect.arrayContaining([
      "Est P&L split-adjusted: KLAC 10:1 (split between the filings, as the corporate actions show)",
      "No Est P&L: ODD (shares and value per share moved as across a split, and the corporate actions could not be read to tell)",
    ]));
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
      loadPerformance: async (cik, name) => ({
        rows: [{ id: "own", cik, name, periodOfReport: "2026-06-30", estQuarterReturn: 7.99, priorReturns: [{ quarter: "2026Q1", value: null }], source: "performance" }],
        quarter: "2026Q2", period: "2026-06-30", basis: "filings", ranking: "unranked",
      }),
    });

    const browser = await headless.load({ ...args("performance", 1), argument: null, rawArgument: "" }, createTestHeadlessContext());
    expect(browser.rows).toEqual([expect.objectContaining({
      cik: detail.cik,
      name: detail.name,
      estQuarterReturn: 8.2,
    })]);

    // A named fund gets its own row, in the list's columns, and the command that copies it.
    const own = await headless.load(args("performance"), createTestHeadlessContext());
    expect(own.rows).toEqual([expect.objectContaining({ cik: detail.cik, estQuarterReturn: 7.99, return1: null })]);
    expect(own.columns?.map((column) => column.header)).toEqual(["Fund", "CIK", "Period", "Est 13F", "Value (USD)", "2026Q1"]);
    expect(own.metadata?.notices).toEqual([
      "Est 13F: from the 2026-03-31 and 2026-06-30 filings, the Est P&L of positions held through the quarter over their value at its start (not in the 2026Q2 ranking)",
      "Copy this basket: gloomberb portfolio import --13f 0001067983",
    ]);

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

  test("a fund's own performance row says truly where its estimate comes from, and a name that matches no fund points to the ranking", async () => {
    let result: Partial<FundPerformanceResult> = {};
    const headless = createThirteenFHeadless({
      loadBrowser: async () => ({ rows: [] }),
      loadDetail: async () => detail,
      loadPerformance: async (cik, name) => ({
        rows: [{ id: "own", cik, name, periodOfReport: "2026-06-30", estQuarterReturn: 7.99, priorReturns: [], source: "performance" }],
        quarter: "2026Q2", period: "2026-06-30", basis: "filings", ranking: "unranked", ...result,
      }),
    });
    const notices = async (next: Partial<FundPerformanceResult>) => {
      result = next;
      return ((await headless.load(args("performance"), createTestHeadlessContext())).metadata?.notices as string[]).slice(0, -1);
    };
    const est = "Est 13F: from the 2026-03-31 and 2026-06-30 filings, the Est P&L of positions held through the quarter over their value at its start";
    expect(await notices({ ranking: "ranked" })).toEqual([`${est} (the 2026Q2 ranking lists it without a return)`]);
    expect(await notices({ ranking: "unavailable" })).toEqual([`${est} (the 2026Q2 ranking did not load)`]);
    expect(await notices({ basis: "ranking", ranking: "ranked" })).toEqual([]);
    expect(await notices({
      splits: [{ ticker: "NVDA", issuer: "NVIDIA", ratio: 10 }, { ticker: "", issuer: "Odd Co", ratio: 0.1 }],
      skipped: [{ ticker: "XYZ", issuer: "Xyz" }],
    })).toEqual([
      `${est} (not in the 2026Q2 ranking)`,
      "Split-adjusted: NVDA 10:1, Odd Co 1:10 (split between the filings, as the corporate actions show)",
      "Left out of Est 13F: XYZ (shares and value per share moved as across a split, and the corporate actions could not be read to tell)",
    ]);
    expect(await notices({ basis: null, ranking: "ranked", unavailable: "No comparable quarter before 2026-06-30 to estimate a return from." }))
      .toEqual(["No Est 13F (the 2026Q2 ranking lists it without a return): No comparable quarter before 2026-06-30 to estimate a return from."]);
    expect(await notices({ basis: null, ranking: null, quarter: undefined, unavailable: "No 13F filing in the last four years." }))
      .toEqual(["No Est 13F: No 13F filing in the last four years."]);
    // A fund behind on its filings says so beside its row, as its holdings do.
    const gap = { period: "2026-09-30", due: "2026-11-16", checked: true, filing: { form: "13F-NT", period: "2026-09-30", filed: "2026-11-14", accession: "0000000000-26-000001", url: "https://www.sec.gov/" } };
    expect((await notices({ basis: "ranking", ranking: "ranked", filingGap: gap })).at(-1)).toBe(filingGapText(gap));

    await expect(headless.load({ ...args("performance"), argument: "Nobody Capital", rawArgument: "Nobody Capital" }, createTestHeadlessContext()))
      .rejects.toThrow('No 13F fund matched "Nobody Capital". For the performance ranking, run gloomberb fn 13F --view performance; for one fund, give its CIK, as in gloomberb fn 13F 0001067983 --view performance.');
  });

  test("the performance ranking without a fund prints as it did before a fund could have its own row", async () => {
    setSystemTime(new Date("2026-10-18T12:00:00Z"));
    try {
      const ranked = [
        { cik: "0001336528", name: "PERSHING SQUARE CAPITAL MANAGEMENT, L.P.", estQuarterReturn: 12.4, value: 15_200_000_000, entries: 11, prior: [3.1, -2.2, null] },
        { cik: "0001649339", name: "SCION ASSET MANAGEMENT, LLC", estQuarterReturn: 9.87, value: 263_000_000, entries: 8, prior: [null, 14.5, 6] },
        { cik: "0001037389", name: "RENAISSANCE TECHNOLOGIES LLC", estQuarterReturn: -1.05, value: 75_400_000_000, entries: 3_412, prior: [0.5, 1.25, -0.75] },
      ];
      const headless = createThirteenFHeadless({
        loadBrowser: async (tab) => {
          expect(tab).toBe("performance");
          return {
            rows: ranked.map((fund) => ({
              id: `performance:${fund.cik}`, cik: fund.cik, name: fund.name, periodOfReport: "2026-06-30", filedAsOfDate: "2026-08-14",
              tableValueTotal: fund.value, tableEntryTotal: fund.entries, estQuarterReturn: fund.estQuarterReturn,
              priorReturns: ["2026Q1", "2025Q4", "2025Q3"].map((quarter, index) => ({ quarter, value: fund.prior[index] ?? null })), source: "performance" as const,
            })),
            quarter: "2026Q2", hasMore: false,
          };
        },
        loadDetail: async () => detail,
      });
      const input = { rawArgument: "", argument: null, symbols: [], options: { view: "performance", limit: 50 } };
      const result = await headless.load(input, createTestHeadlessContext());
      expect(renderHeadlessPaneText(headless, result, input, "13F")).toMatchInlineSnapshot(`
        "13F Performance

        Fund                                      CIK         Period      Est 13F  Value (USD)  2026Q1   2025Q4  2025Q3
        ────────────────────────────────────────  ──────────  ──────────  ───────  ───────────  ──────  ───────  ──────
        PERSHING SQUARE CAPITAL MANAGEMENT, L.P.  0001336528  2026-06-30  +12.40%      $15.20B  +3.10%   -2.20%      --
        SCION ASSET MANAGEMENT, LLC               0001649339  2026-06-30   +9.87%     $263.00M      --  +14.50%  +6.00%
        RENAISSANCE TECHNOLOGIES LLC              0001037389  2026-06-30   -1.05%      $75.40B  +0.50%   +1.25%  -0.75%

        Source: SEC EDGAR · Fri 14 Aug 2026 · not a live feed (13F filings)"
      `);
      expect(result.metadata).toMatchInlineSnapshot(`
        {
          "hasMore": false,
          "notices": [],
          "period": null,
          "quarter": "2026Q2",
          "query": null,
          "shown": 3,
          "truncated": false,
          "view": "performance",
        }
      `);
    } finally {
      setSystemTime();
    }
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
        throw new ApiRequestError(`No 13F CUSIP found for ${params.tickers}`, 404);
      }) as never);
      const tabs: string[] = [];
      const tiger = { id: "tiger", cik: "0001167483", name: "Tiger Global Management LLC", periodOfReport: "2026-06-30", source: "funds" as const };
      const headless = createThirteenFHeadless({
        loadBrowser: async (tab, query) => {
          tabs.push(`${tab}:${query}`);
          return tab === "funds" && query.toLowerCase() === "tiger" ? { rows: [tiger] } : { rows: [], ...(tab === "byTicker" ? { warning: `No CUSIP found for ${query.toUpperCase()}` } : {}) };
        },
        loadDetail: async () => detail,
        searchFunds: async () => [],
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

    test("a lowercase ticker that also names a fund lists the holders and gives the command for the fund", async () => {
      spy = spyOn(apiClient, "getCloudSec13F").mockImplementation((async () => page(0, 2, false)) as never);
      const searched: string[] = [];
      let funds = [
        { cik: "0002111811", name: "Blind Man Capital, LLC" },
        { cik: "0001637460", name: "Man Group plc" },
        // Substring matches the name search also returns are not funds of that name.
        { cik: "0002067071", name: "Ackerman Asset Management, LLC" },
        { cik: "0001520000", name: "Man Investment Partners (US) LP" },
        { cik: "0001520001", name: "Prudent Man Advisors, LLC" },
      ];
      const headless = createThirteenFHeadless({
        loadBrowser: async () => ({ rows: [] }),
        loadDetail: async () => detail,
        searchFunds: async (query) => { searched.push(query); return funds; },
      });
      const load = (word: string) => headless.load({ ...args("auto"), argument: word, rawArgument: word }, createTestHeadlessContext());

      const several = await load("man");
      expect(several.metadata).toMatchObject({ view: "ticker-holdings" });
      expect(searched).toEqual(["man "]);
      // Funds the word starts come first.
      expect(several.metadata?.notices).toContain('"man" also names 13F filers: Man Group plc (fn 13F 0001637460); Man Investment Partners (US) LP (fn 13F 0001520000); Blind Man Capital, LLC (fn 13F 0002111811) and 1 more');
      funds = funds.slice(1, 3);
      expect((await load("man")).metadata?.notices).toContain('"man" also names a 13F filer: Man Group plc (fn 13F 0001637460)');
      // An uppercase word or a $ticker is meant as the ticker; no fund search.
      searched.length = 0;
      for (const word of ["MAN", "$man"])
        expect(((await load(word)).metadata?.notices as string[]).some((notice) => notice.includes("13F filer"))).toBe(false);
      expect(searched).toEqual([]);
    });

    test("an outage or failed holder lookup is said, never read as no filer or ticker", async () => {
      let failure: Error = new TypeError("Unable to connect");
      spy = spyOn(apiClient, "getCloudSec13F").mockImplementation((async () => { throw failure; }) as never);
      let holders: string | undefined;
      const headless = createThirteenFHeadless({
        loadBrowser: async (tab) => ({ rows: [], ...(tab === "byTicker" && holders ? { warning: holders } : {}) }),
        loadDetail: async () => detail,
        searchFunds: async () => [],
      });
      const load = (word: string) => headless.load({ ...args("auto"), argument: word, rawArgument: word }, createTestHeadlessContext());
      for (const word of ["aapl", "AAPL"]) await expect(load(word)).rejects.toThrow("Unable to connect");
      failure = new ApiRequestError("Service unavailable", 503);
      await expect(load("aapl")).rejects.toThrow("Service unavailable");

      // A ticker with no CUSIP moves on to its holders' books; when that lookup fails, the failure is the answer.
      failure = new ApiRequestError("No 13F CUSIP found for AAPL", 404);
      holders = "Forms13F 503 for /holders";
      const failed = await load("AAPL");
      expect(failed.errors).toEqual(["Forms13F 503 for /holders"]);
      expect(renderHeadlessPaneText(headless, failed, args("auto"), "13F")).not.toContain("matches");
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
    let unasked = false;
    const headless = createThirteenFHeadless({
      loadBrowser: async () => ({ rows }),
      loadDetail: async () => ({ ...detail, filingGap: notice }),
      loadFilingGap: async (cik) => {
        asked.push(cik);
        return cik === "0001336528" ? notice : { period: "2026-06-30", due: "2026-08-14", filing: null, checked: !unasked };
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

    // EDGAR unasked (no route, a failure, a timeout): only what the loaded filings show.
    unasked = true;
    const quiet = await headless.load({ ...args("auto"), argument: "Pershing", rawArgument: "Pershing" }, createTestHeadlessContext());
    expect(quiet.metadata?.notices).toContain("Quiet Fund: Q2 2026 13F (due 14 Aug) not in the loaded filings; EDGAR not checked");

    // A search asks about ten lagging funds at most, and says so when there are more.
    rows.push(...Array.from({ length: 10 }, (_, index) => ({ id: `lag${index}`, cik: `${index + 100}`, name: `Lagging ${index}`, periodOfReport: "2026-03-31", source: "funds" as const })));
    asked.length = 0;
    const capped = await headless.load({ ...args("auto"), argument: "Pershing", rawArgument: "Pershing" }, createTestHeadlessContext());
    expect(asked).toHaveLength(10);
    expect(capped.metadata?.notices).toContain("EDGAR checked for the first 10 of 12 funds with no Q2 2026 13F loaded; fn 13F <CIK> checks any other");
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

describe("13F shot state", () => {
  const shotState = (metadata: Record<string, unknown>, argument = "0001067983", options: Record<string, string | number> = {}) => thirteenFHeadless.shotState!(
    { rawArgument: argument, argument: argument || null, symbols: [], options: { view: "auto", limit: 50, ...options } },
    async () => ({ rows: [], metadata }),
    new Set(Object.keys(options)),
  );

  test("opens the fund a name resolved to on its view's tab, with the overlap's second fund or ETF", async () => {
    expect(await shotState({ view: "filings", cik: "0001067983" }, "Berkshire Hathaway")).toEqual({
      settings: { initialCik: "0001067983" },
      pluginState: { "ticker-research": { browserTab: "funds", detailTab: "filings" } },
    });
    expect((await shotState({ view: "overlap", cik: "0001067983", etf: { symbol: "SPY", ticker: "IVV", name: "S&P 500", asOf: "2026-10-08" } })).pluginState).toEqual({
      "ticker-research": { browserTab: "funds", detailTab: "overlap", "overlap:etf": { symbol: "SPY", ticker: "IVV", name: "S&P 500" }, "overlap:target": null },
    });
    expect((await shotState({ view: "overlap", cik: "0001067983", secondCik: "0001336528", secondFund: "Pershing Square" })).pluginState?.["ticker-research"]).toMatchObject({
      "overlap:etf": null, "overlap:target": { cik: "0001336528", name: "Pershing Square" },
    });
    // A CIK asked for as a funds search lists it rather than opening it.
    expect(await shotState({ view: "funds" }, "0001067983", { view: "funds" })).toEqual({
      settings: { query: "0001067983", initialCik: "" },
      pluginState: { "ticker-research": { browserTab: "funds", query: "0001067983" } },
    });
    expect((await shotState({ view: "crowding", rank: "exits" }, "", { view: "crowding", rank: "exits" })).pluginState).toEqual({
      "ticker-research": { browserTab: "crowding", "13f-crowding:ranking": "exitCount" },
    });
  });

  test("refuses the views the pane draws only another way", async () => {
    await expect(shotState({ view: "performance", cik: "0001067983", fund: "BERKSHIRE HATHAWAY INC" }, "0001067983", { view: "performance" }))
      .rejects.toThrow("The 13F pane draws the performance ranking, not one fund's row.");
    await expect(shotState({ view: "crowding", rank: "new" }, "AAPL", { view: "crowding" })).rejects.toThrow(/not one ticker's rank/);
    await expect(shotState({ view: "holdings", cik: "0001067983" }, "0001067983", { rank: "exits" })).rejects.toThrow(/--rank orders the crowding ranking only/);
  });
});

