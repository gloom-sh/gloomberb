import { describe, expect, test } from "bun:test";
import type { CloudCdsHistoryPointPayload, CloudCdsTradePayload } from "../../../api-client";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv, selectReportTables } from "../../../cli/report-tables";
import type { HeadlessBundleResult, HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { cdsHeadless, createCdsHeadless } from "./headless";
import type { CdsActivity, CdsSpreadHistory } from "./client";
import { normalizeCdsTrades, sortIssuers, type CdsIssuerSummary } from "./model";

/** Sunday 11 Oct 2026, two days after Ford's last trade. */
const NOW = Date.parse("2026-10-11T15:14:00Z");

function tape(id: string, executed: string, overrides: Partial<CloudCdsTradePayload> = {}): CloudCdsTradePayload {
  return {
    disseminationId: id, originalDisseminationId: null, actionType: "NEWT",
    executionTimestamp: executed, eventTimestamp: executed,
    effectiveDate: null, expirationDate: null, maturityDate: "2031-12-20",
    issuerName: "Ford Motor Company", underlierId: null, underlierIdSource: null,
    upi: null, upiFisn: null, upiUnderlierName: null, notionalAmount: 5_000_000,
    notionalCapped: true, notionalCurrency: "USD", fixedRate: 0.05,
    reportedSpread: null, spreadNotation: null, upfrontAmount: 762_500, upfrontCurrency: "USD",
    ...overrides,
  };
}

const FORD: CdsActivity = {
  source: "DTCC PPD",
  // When the tape was fetched: never what the report is dated by.
  asOf: "2026-10-11T15:14:13Z",
  query: "F",
  issuer: "Ford Motor Company",
  days: 5,
  trades: normalizeCdsTrades([
    tape("1", "2026-10-09T13:21:00Z"),
    tape("2", "2026-10-08T18:15:00Z", { fixedRate: 0.01, notionalAmount: 2_000_000, notionalCapped: false, upfrontAmount: 36_400 }),
  ]),
};

function level(date: string, spreadBp: number, maturity = "2031-12-20"): CloudCdsHistoryPointPayload {
  return { date, spreadBp, prints: 3, reported: 0, maturity };
}

const IN_BP = { quote: "spread", couponBp: null, upfrontPts: null, change1WPts: null, change1MPts: null } as const;

// Ford's 5Y line: its range over two years, and a month back on the Jun 2031 contract, before the roll.
const FORD_LINE: CdsSpreadHistory = {
  issuer: "Ford Motor Company",
  points: [
    level("2024-10-11", 160, "2029-12-20"),
    level("2025-04-10", 276, "2030-06-20"),
    level("2026-02-12", 129, "2031-06-20"),
    level("2026-09-04", 140, "2031-06-20"),
    level("2026-10-09", 157),
  ],
  // The server's moves, chained through the Sep 20 roll by the index board's rule.
  change1W: 12,
  change1M: 17.04,
  ...IN_BP,
  noLevelReason: null,
};

function args(argument: string | null, options: HeadlessPaneLoadArgs["options"] = {}): HeadlessPaneLoadArgs {
  return { rawArgument: argument ?? "", argument, symbols: argument ? [argument] : [], options };
}

const STATUS = { complete: true, unavailableSymbols: [] };

async function report(
  argument: string | null,
  load: Parameters<typeof createCdsHeadless>[0],
  apiClient: object = {},
  options: HeadlessPaneLoadArgs["options"] = {},
) {
  const definition = createCdsHeadless(load);
  const loadArgs = args(argument, options);
  const result = await definition.load(loadArgs, { apiClient } as unknown as HeadlessPaneContext) as HeadlessBundleResult;
  const freshness = deriveHeadlessFreshness(definition, result, NOW);
  const tables = headlessReportTables(definition, result, loadArgs, "CDS", freshness, STATUS);
  return {
    result,
    freshness,
    tables,
    text: renderHeadlessPaneText(definition, result, loadArgs, "CDS", freshness),
    csv: renderReportCsv(tables),
  };
}

describe("CDS report", () => {
  test("a name's report carries the 5Y level, date, 1W and 1M moves and range the pane shows, its trades, and its last trade", async () => {
    const { result, freshness, text, csv } = await report("F", {
      load: async () => FORD,
      loadHistory: async () => FORD_LINE,
    });

    // The figures over the pane's chart, under the entity the ticker became, then the chart as a table.
    expect(result.sections.map((section) => section.title)).toEqual(["Ford Motor Company", "Trades", "Daily"]);
    expect(result.sections[0]!.entries!.map((entry) => [entry.key, entry.value])).toEqual([
      ["spreadBp", 157],
      ["date", "2026-10-09"],
      // A month back is the Jun 2031 contract: the server chains the move through the roll, as the index board does.
      ["change1wBp", 12],
      ["change1mBp", 17.04],
      ["range", { lowBp: 129, highBp: 276, since: "2024-10-11" }],
    ]);
    expect(text).toMatch(/5Y spread\s+157bp/);
    expect(text).toMatch(/1W change\s+\+12\.0bp/);
    expect(text).toMatch(/1M change\s+\+17\.0bp/);
    expect(text).toMatch(/Range\s+129 to 276bp since 2024-10-11/);
    // ISO times, and the upfront without a side it does not have.
    expect(text).toContain("2026-10-09 13:21");
    expect(text).not.toMatch(/\d{2}\/\d{2} \d{2}:\d{2}/);
    expect(text).toContain("Abs upfront");
    expect(text).toContain("762.5k USD");
    expect(text).not.toMatch(/\+[\d.]+k USD/);
    // Dated by the last trade, not the fetch, the line the pane and the shot end with.
    expect(freshness).toMatchObject({ source: "DTCC", asOf: "2026-10-09T13:21:00.000Z", lagDays: 2, observation: "last trade" });
    expect(text.trimEnd().split("\n").at(-1)).toBe("Source: DTCC · last trade 2026-10-09 · lag 2 days");

    expect(csv).toContain("5Y spread (bp),157");
    expect(csv).toContain("Date,2026-10-09");
    expect(csv).toContain("2026-10-09T13:21:00Z");
    expect(csv).toContain("# Source: DTCC · last trade 2026-10-09 · lag 2 days");
  });

  test("a move without a comparable level reads --, not zero", async () => {
    const { result, text } = await report("F", {
      load: async () => FORD,
      loadHistory: async () => ({ ...FORD_LINE, change1W: null, change1M: null }),
    });
    expect(result.sections[0]!.entries!.find((entry) => entry.key === "change1mBp")?.value).toBeNull();
    expect(text).toMatch(/1W change\s+--/);
    expect(text).toMatch(/1M change\s+--/);
  });

  test("exports the daily 5Y levels, newest first, over --days", async () => {
    const { result, tables, text } = await report("F", {
      load: async () => FORD,
      loadHistory: async () => FORD_LINE,
    }, {}, { days: 60 });
    expect(result.sections.at(-1)!.rows!.map((row) => [row.day, row.spreadBp, row.maturity])).toEqual([
      ["2026-10-09", 157, "2031-12-20"],
      ["2026-09-04", 140, "2031-06-20"],
    ]);
    expect(text).toMatch(/2026-09-04\s+140bp\s+3\s+Jun 2031/);
    // `fn CDS F --csv --section daily`: that table alone, a row per day, the contract as its maturity.
    const daily = renderReportCsv(selectReportTables(tables, "daily")).split("\n");
    expect(daily[0]).toMatch(/^Date,5Y spread \(bp\),Prints,Contract/);
    expect(daily.slice(1, 3).map((line) => line.split(",").slice(0, 4).join(","))).toEqual([
      "2026-10-09,157,3,2031-12-20",
      "2026-09-04,140,3,2031-06-20",
    ]);
    // The default year reaches back past the roll before.
    const year = await report("F", { load: async () => FORD, loadHistory: async () => FORD_LINE });
    expect(year.result.sections.at(-1)!.rows).toHaveLength(3);
  });

  test("says why a name has no level when its prints carry upfront without the payer side", async () => {
    const barclays: CdsSpreadHistory = {
      issuer: "Barclays PLC", points: [], change1W: null, change1M: null, ...IN_BP, noLevelReason: "upfront-side-unknown",
    };
    const { result, text } = await report("Barclays PLC", {
      load: async () => ({ ...FORD, query: "Barclays PLC", issuer: "Barclays PLC", trades: [] }),
      loadHistory: async () => barclays,
    });
    expect(result.notes).toEqual(["5Y level not derivable: DTCC prints carry upfront without payer side."]);
    expect(text).toContain("5Y level not derivable: DTCC prints carry upfront without payer side");
    expect(text).not.toContain("No 5Y spread level");
    // A stale level says the prints after it set none.
    const stale = await report("BAT", {
      load: async () => ({ ...FORD, query: "BAT", issuer: "British American Tobacco p.l.c.", trades: [] }),
      loadHistory: async () => ({ ...barclays, issuer: null, points: [level("2025-10-17", 120)] }),
    });
    expect(stale.result.notes).toEqual(["5Y level not derivable after 2025-10-17: DTCC prints carry upfront without payer side."]);
  });

  test("lists issuers with their 5Y level and its date from one request, however many are listed", async () => {
    const requests = { levels: 0, history: 0 };
    const listed = Array.from({ length: 40 }, (_, index) => (
      tape(String(100 + index), "2026-10-06T12:00:00Z", { issuerName: `Issuer ${index} Holdings` })
    ));
    const { result, text } = await report(null, {
      load: async () => ({
        ...FORD,
        query: null,
        issuer: null,
        trades: normalizeCdsTrades([
          ...FORD.trades.map((trade) => tape(trade.id, new Date(trade.eventAt).toISOString())),
          tape("3", "2026-10-09T19:55:00Z", { issuerName: "Amazon.com;Inc." }),
          tape("4", "2026-10-08T12:00:00Z", { issuerName: "AMAZON.COM INC" }),
          tape("5", "2026-10-07T12:00:00Z", { issuerName: "Amazon.com;Inc." }),
          ...listed,
        ]),
      }),
    }, {
      getCloudCdsLevels: async () => {
        requests.levels += 1;
        return {
          source: "DTCC PPD",
          tenor: "5Y",
          asOf: null,
          levels: [
            { issuer: "Amazon.com, Inc.", spreadBp: 73, date: "2026-10-09", change1W: 3, change1M: 5.8 },
            { issuer: "Issuer 7 Holdings", spreadBp: 412.5, date: "2026-10-07", change1W: -2.04, change1M: null },
          ],
        };
      },
      getCloudCdsHistory: async () => {
        requests.history += 1;
        throw new Error("not for the list");
      },
    });
    expect(requests).toEqual({ levels: 1, history: 0 });
    const rows = result.sections[0]!.rows!;
    // DTCC's `;` is the comma it stands for, every spelling is one issuer, and a name without a level has none.
    expect(rows.slice(0, 2).map((row) => [row.issuer, row.trades, row.level, row.change1W, row.change1M, row.unit, row.spread5yDate]))
      .toEqual([
        ["Amazon.com, Inc.", 3, 73, 3, 5.8, "bp", "2026-10-09"],
        ["Ford Motor Company", 2, null, null, null, "bp", null],
      ]);
    expect(rows).toHaveLength(42);
    // Ranked by level, names without one last.
    expect(sortIssuers(rows as unknown as CdsIssuerSummary[], { columnId: "spread", direction: "desc" })
      .slice(0, 3).map((row) => [row.issuer, row.spread5yBp])).toEqual([
      ["Issuer 7 Holdings", 412.5],
      ["Amazon.com, Inc.", 73],
      ["Ford Motor Company", null],
    ]);
    expect(text).toMatch(/Amazon\.com, Inc\.\s+3\s+2026-10-09 19:55\s+73bp\s+\+3\.0bp\s+\+5\.8bp\s+2026-10-09/);
    expect(text.trimEnd().split("\n").at(-1)).toBe("Source: DTCC · last trade 2026-10-09 · lag 2 days");
  });

  test("--sort ranks the list by the 5Y level or its 1W or 1M move, from the same one request", async () => {
    const requests = { levels: 0 };
    const load = async () => ({
      ...FORD,
      query: null,
      issuer: null,
      trades: normalizeCdsTrades([
        ...FORD.trades.map((trade) => tape(trade.id, new Date(trade.eventAt).toISOString())),
        tape("3", "2026-10-09T19:55:00Z", { issuerName: "Oracle Corporation" }),
        tape("4", "2026-10-09T18:00:00Z", { issuerName: "Whirlpool Corporation" }),
      ]),
    });
    const apiClient = {
      getCloudCdsLevels: async () => {
        requests.levels += 1;
        return {
          source: "DTCC PPD",
          tenor: "5Y",
          asOf: null,
          levels: [
            { issuer: "Oracle Corporation", spreadBp: 160, date: "2026-10-09", change1W: 41.5, change1M: 75.4 },
            { issuer: "Whirlpool Corporation", spreadBp: 520, date: "2026-10-09", change1W: 36.7, change1M: 164.8 },
            { issuer: "Ford Motor Company", spreadBp: 157, date: "2026-10-09", change1W: 0.9, change1M: -0.3 },
          ],
        };
      },
    };
    const order = async (sort?: string) => {
      const { result } = await report(null, { load }, apiClient, sort ? { sort } : {});
      return result.sections[0]!.rows!.map((row) => row.issuer);
    };
    expect(await order()).toEqual(["Ford Motor Company", "Oracle Corporation", "Whirlpool Corporation"]);
    expect(await order("spread")).toEqual(["Whirlpool Corporation", "Oracle Corporation", "Ford Motor Company"]);
    expect(await order("1w")).toEqual(["Oracle Corporation", "Whirlpool Corporation", "Ford Motor Company"]);
    expect(await order("1m")).toEqual(["Whirlpool Corporation", "Oracle Corporation", "Ford Motor Company"]);
    expect(requests.levels).toBe(4);
  });

  test("quotes a name past 2,000bp in points upfront, moves too, and ranks it after the bp names", async () => {
    const load = async () => ({
      ...FORD,
      query: null,
      issuer: null,
      trades: normalizeCdsTrades([
        ...FORD.trades.map((trade) => tape(trade.id, new Date(trade.eventAt).toISOString())),
        tape("3", "2026-10-09T19:55:00Z", { issuerName: "Oracle Corporation" }),
        tape("4", "2026-10-09T18:00:00Z", { issuerName: "VIRGIN MEDIA FINANCE PLC", notionalCurrency: "EUR" }),
        tape("5", "2026-10-09T17:00:00Z", { issuerName: "American Airlines Group Inc." }),
      ]),
    });
    const apiClient = {
      getCloudCdsLevels: async () => ({
        source: "DTCC PPD",
        tenor: "5Y",
        asOf: null,
        levels: [
          { issuer: "Oracle Corporation", spreadBp: 285.4, date: "2026-10-09", change1W: 28.1, change1M: 75.4 },
          { issuer: "Ford Motor Company", spreadBp: 157.8, date: "2026-10-09", change1W: 0.9, change1M: -0.3 },
          {
            issuer: "VIRGIN MEDIA FINANCE PLC", spreadBp: 18654.4, date: "2026-10-08", change1W: 15266.3, change1M: 17418.4,
            quote: "upfront" as const, couponBp: 500, upfrontPts: 57.65, change1WPts: 10.9, change1MPts: 36.1,
          },
          // More than 5 trading days behind the tape: a level, no moves.
          { issuer: "American Airlines Group Inc.", spreadBp: 512, date: "2026-10-01", change1W: null, change1M: null },
        ],
      }),
    };
    const { result, text, tables } = await report(null, { load }, apiClient, { sort: "1m" });
    const rows = result.sections[0]!.rows!;
    expect(rows.map((row) => [row.issuer, row.level, row.change1M, row.unit])).toEqual([
      ["Oracle Corporation", 285.4, 75.4, "bp"],
      ["Ford Motor Company", 157.8, -0.3, "bp"],
      ["VIRGIN MEDIA FINANCE PLC", 57.65, 36.1, "pts"],
      ["American Airlines Group Inc.", 512, null, "bp"],
    ]);
    // The bp level stays beside the quote, with the coupon the points are on.
    expect(rows[2]).toMatchObject({ quote: "upfront", spread5yBp: 18654.4, couponBp: 500 });
    expect(text).toMatch(/VIRGIN MEDIA FINANCE PLC\s+1\s+2026-10-09 18:00\s+57\.6 pts\s+\+10\.9 pts\s+\+36\.1 pts\s+2026-10-08/);
    expect(text).toMatch(/American Airlines Group Inc\.\s+1\s+2026-10-09 17:00\s+512bp\s+--\s+--\s+2026-10-01/);
    expect(text).not.toContain("18654");
    // Exports write the number and its unit, as the index board's do.
    const csv = renderReportCsv(tables).split("\n");
    const header = csv.find((line) => line.startsWith("Issuer,"))!.split(",");
    const virgin = csv.find((line) => line.startsWith("VIRGIN MEDIA"))!.split(",");
    expect([virgin[header.indexOf("5Y")], virgin[header.indexOf("5Y unit")], virgin[header.indexOf("1M")]]).toEqual(["57.65", "pts", "36.1"]);
  });

  test("a name quoted upfront reports its points, coupon and moves in points, and lists its daily points beside the spread", async () => {
    const virgin: CdsSpreadHistory = {
      issuer: "VIRGIN MEDIA FINANCE PLC",
      points: [
        { ...level("2026-09-15", 1236), upfrontPts: 21.55 },
        { ...level("2026-10-08", 18654.4), upfrontPts: 57.65 },
      ],
      change1W: 15266.3,
      change1M: 17418.4,
      quote: "upfront",
      couponBp: 500,
      upfrontPts: 57.65,
      change1WPts: 10.9,
      change1MPts: 36.1,
      noLevelReason: null,
    };
    const { result, text, tables } = await report("Virgin Media Finance", {
      load: async () => ({ ...FORD, query: "Virgin Media Finance", issuer: "VIRGIN MEDIA FINANCE PLC", trades: [] }),
      loadHistory: async () => virgin,
    });
    expect(result.sections[0]!.entries!.map((entry) => [entry.key, entry.value])).toEqual([
      ["upfrontPts", 57.65],
      ["couponBp", 500],
      ["date", "2026-10-08"],
      ["change1wPts", 10.9],
      ["change1mPts", 36.1],
      ["range", { lowPts: 21.55, highPts: 57.65, since: "2026-09-15" }],
    ]);
    expect(result.metadata).toMatchObject({ quote: "upfront" });
    expect(text).toMatch(/5Y upfront\s+57\.6 pts/);
    expect(text).toMatch(/Coupon\s+500bp/);
    expect(text).toMatch(/1M change\s+\+36\.1 pts/);
    expect(text).toMatch(/Range\s+21\.6 to 57\.6 pts since 2026-09-15/);
    expect(text).toMatch(/2026-10-08\s+18654bp\s+57\.6 pts\s+3\s+Dec 2031/);
    const daily = renderReportCsv(selectReportTables(tables, "daily")).split("\n");
    expect(daily[0]).toMatch(/^Date,5Y spread \(bp\),5Y upfront \(pts\),Prints,Contract/);
    expect(daily[1]!.split(",").slice(0, 4)).toEqual(["2026-10-08", "18654.4", "57.65", "3"]);
  });

  test("still lists the issuers, without levels, when the levels request fails", async () => {
    const { result } = await report(null, {
      load: async () => ({ ...FORD, query: null, issuer: null }),
    }, {
      getCloudCdsLevels: async () => {
        throw new Error("offline");
      },
    });
    expect(result.errors).toEqual(["5Y spreads unavailable."]);
    expect(result.sections[0]!.rows!.map((row) => [row.issuer, row.trades, row.spread5yBp])).toEqual([
      ["Ford Motor Company", 2, null],
    ]);
  });

  test("a ticker whose CDS trades under another entity reads that entity, and an empty window says what was searched", async () => {
    const requested: Array<string | undefined> = [];
    const searched: string[] = [];
    const result = await cdsHeadless.load(args("CHTR"), {
      apiClient: {
        getCloudCds: async (params: { issuer?: string }) => {
          requested.push(params.issuer);
          return { source: "DTCC PPD", asOf: null, trades: [] };
        },
        getCloudCdsHistory: async () => ({ source: "DTCC PPD", issuer: "CCO Holdings LLC", tenor: "5Y", currency: null, asOf: null, points: [] }),
        searchInstruments: async (query: string) => {
          searched.push(query);
          return [];
        },
      },
    } as unknown as HeadlessPaneContext) as HeadlessBundleResult;
    expect(searched).toEqual([]);
    expect(requested).toEqual(["CCO Holdings, LLC"]);
    expect(result.sections.at(-1)).toMatchObject({ rows: [], empty: "No CDS trades for CCO Holdings, LLC (CHTR) in the last 5 days." });
  });

  test("loads source notation through the default adapter without inventing monetary rates", async () => {
    const trades = ["4", "1", "Other"].map((spreadNotation, index) => tape(String(index), "2026-09-11T14:00:00Z", {
      issuerName: "Oracle Corporation", fixedRate: 0.01, reportedSpread: 250, spreadNotation, upfrontAmount: 0,
    }));
    const result = await cdsHeadless.load(args("Oracle Corporation"), {
      apiClient: {
        getCloudCds: async () => ({ source: "DTCC", asOf: null, trades }),
        getCloudCdsHistory: async () => ({ source: "DTCC", issuer: null, tenor: "5Y", currency: null, asOf: null, points: [] }),
      },
    } as unknown as HeadlessPaneContext) as HeadlessBundleResult;
    const rows = result.sections.at(-1)!.rows!;
    expect(rows.map((row) => [row.spreadNotation, row.reportedSpread, row.spreadBp]))
      .toEqual([["4", 250, 250], ["1", 250, null], ["Other", 250, null]]);
    expect(rows.map((row) => [row.couponBp, row.upfront])).toEqual([[100, 0], [100, 0], [100, 0]]);
  });
});
