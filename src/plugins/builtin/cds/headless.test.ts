import { describe, expect, test } from "bun:test";
import type { CloudCdsHistoryPointPayload, CloudCdsTradePayload } from "../../../api-client";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
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
};

function args(argument: string | null): HeadlessPaneLoadArgs {
  return { rawArgument: argument ?? "", argument, symbols: argument ? [argument] : [], options: {} };
}

const STATUS = { complete: true, unavailableSymbols: [] };

async function report(argument: string | null, load: Parameters<typeof createCdsHeadless>[0], apiClient: object = {}) {
  const definition = createCdsHeadless(load);
  const result = await definition.load(args(argument), { apiClient } as unknown as HeadlessPaneContext) as HeadlessBundleResult;
  const freshness = deriveHeadlessFreshness(definition, result, NOW);
  return {
    result,
    freshness,
    text: renderHeadlessPaneText(definition, result, args(argument), "CDS", freshness),
    csv: renderReportCsv(headlessReportTables(definition, result, args(argument), "CDS", freshness, STATUS)),
  };
}

describe("CDS report", () => {
  test("a name's report carries the 5Y level, date, 1M move and range the pane shows, its trades, and its last trade", async () => {
    const { result, freshness, text, csv } = await report("F", {
      load: async () => FORD,
      loadHistory: async () => FORD_LINE,
    });

    // The figures over the pane's chart, under the entity the ticker became.
    expect(result.sections.map((section) => section.title)).toEqual(["Ford Motor Company", "Trades"]);
    expect(result.sections[0]!.entries!.map((entry) => [entry.key, entry.value])).toEqual([
      ["spreadBp", 157],
      ["date", "2026-10-09"],
      // A month back is the Jun 2031 contract: the roll is not a move, as the pane leaves it out.
      ["change1mBp", null],
      ["range", { lowBp: 129, highBp: 276, since: "2024-10-11" }],
    ]);
    expect(text).toMatch(/5Y spread\s+157bp/);
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

  test("the 1M move compares the same contract a month back", async () => {
    const { result, text } = await report("F", {
      load: async () => FORD,
      loadHistory: async () => ({ ...FORD_LINE, points: [level("2026-09-01", 144.6), level("2026-10-09", 157.3)] }),
    });
    expect(result.sections[0]!.entries!.find((entry) => entry.key === "change1mBp")?.value).toBe(12.7);
    expect(text).toMatch(/1M change\s+\+13bp/);
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
            { issuer: "Amazon.com, Inc.", spreadBp: 73, date: "2026-10-09" },
            { issuer: "Issuer 7 Holdings", spreadBp: 412.5, date: "2026-10-07" },
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
    expect(rows.slice(0, 2).map((row) => [row.issuer, row.trades, row.spread5yBp, row.spread5yDate])).toEqual([
      ["Amazon.com, Inc.", 3, 73, "2026-10-09"],
      ["Ford Motor Company", 2, null, null],
    ]);
    expect(rows).toHaveLength(42);
    // Ranked by level, names without one last.
    expect(sortIssuers(rows as unknown as CdsIssuerSummary[], { columnId: "spread", direction: "desc" })
      .slice(0, 3).map((row) => [row.issuer, row.spread5yBp])).toEqual([
      ["Issuer 7 Holdings", 412.5],
      ["Amazon.com, Inc.", 73],
      ["Ford Motor Company", null],
    ]);
    expect(text).toMatch(/Amazon\.com, Inc\.\s+3\s+2026-10-09 19:55\s+73bp\s+2026-10-09/);
    expect(text.trimEnd().split("\n").at(-1)).toBe("Source: DTCC · last trade 2026-10-09 · lag 2 days");
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
