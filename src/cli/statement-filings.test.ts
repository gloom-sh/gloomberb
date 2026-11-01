import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { apiClient } from "../api-client";
import { offeringNote } from "../utils/cash-runway";
import { createDefaultConfig } from "../types/config";
import type { TickerFinancials } from "../types/financials";
import { createTestDataProvider } from "../test-support/data-provider";
import { blockExternalNetwork } from "../test-support/network-guard";
import { buildTickerReport, ticker } from "./commands/ticker";
import {
  cloudStatementReportSources,
  detectResultsRelease,
  loadOfferingFilings,
  resultsReleaseText,
  statementFiling,
  type PeriodicFiling,
  type StatementReportSources,
} from "./statement-filings";
import type { MarketContext } from "./types";

blockExternalNetwork();

const filing = (form: string, filed: string, accessionNumber: string, extra: Partial<PeriodicFiling> = {}): PeriodicFiling =>
  ({ form, filed, accessionNumber, items: [], ...extra });
const release = (filed: string, accessionNumber: string, items = ["2.02", "9.01"]) => filing("8-K", filed, accessionNumber, { items });

// JPM on 2026-10-18: Q2's 10-Q is the latest statement; Q3's results came out on 13 Oct.
const JPM_FILINGS = [
  release("2026-10-13", "0001628280-26-065582"),
  filing("8-K", "2026-09-15", "0001628280-26-061000", { items: ["7.01", "9.01"] }),
  filing("10-Q", "2026-08-06", "0001628280-26-054343", { reportDate: "2026-06-30" }),
  release("2026-07-14", "0001628280-26-047000"),
  filing("10-Q", "2026-05-01", "0001628280-26-029344", { reportDate: "2026-03-31" }),
  filing("10-K", "2026-02-13", "0001628280-26-008131", { reportDate: "2025-12-31" }),
];

test("an Item 2.02 8-K filed after the next quarter ends is that quarter's release, before its 10-Q", () => {
  const jpm = detectResultsRelease({ latestQuarter: "2026-06-30", latestAnnual: "2025-12-31", filings: JPM_FILINGS })!;
  expect(jpm).toMatchObject({ fiscalQuarter: 3, periodMonth: "2026-09", filed: "2026-10-13", accessionNumber: "0001628280-26-065582", statementsForm: "10-Q", periodicReport: null });
  expect(resultsReleaseText(jpm)).toBe("Q3 (Sep 2026) results released 2026-10-13 (8-K); statements arrive with the 10-Q.");

  // The latest quarter's own release (20 Jul for June), an 8-K without 2.02, or one inside the quarter, is none.
  const zion = [release("2026-07-20", "z-1"), filing("10-Q", "2026-08-06", "z-2"), release("2026-09-10", "z-3"), filing("8-K", "2026-10-01", "z-4", { items: ["5.02"] })];
  expect(detectResultsRelease({ latestQuarter: "2026-06-30", latestAnnual: "2025-12-31", filings: zion })).toBeNull();
  expect(detectResultsRelease({ latestQuarter: "2026-06-30", latestAnnual: "2025-12-31", filings: [filing("8-K/A", "2026-10-14", "a", { items: ["2.02"] })] })).toBeNull();
});

test("a 52-53 week year reads its quarters on its own grid: Apple's September quarter is Q4, with the 10-K", () => {
  // Quarter ended Sat 27 Jun 2026, year ended Sat 27 Sep 2025; a year ending in the first days of a month belongs to the one before.
  const apple = detectResultsRelease({ latestQuarter: "2026-06-27", latestAnnual: "2025-09-27", filings: [release("2026-10-29", "a-1"), release("2026-07-30", "a-0")] })!;
  expect(apple).toMatchObject({ fiscalQuarter: 4, periodMonth: "2026-09", statementsForm: "10-K" });
  expect(resultsReleaseText(apple)).toBe("Q4 (Sep 2026) results released 2026-10-29 (8-K); statements arrive with the 10-K.");
  const retailer = detectResultsRelease({ latestQuarter: "2026-08-01", latestAnnual: "2026-01-31", filings: [release("2026-11-19", "r-1")] })!;
  expect(retailer).toMatchObject({ fiscalQuarter: 3, periodMonth: "2026-10" });
  // Two quarters behind: the newer quarter's release is the one named, its first filing.
  const behind = detectResultsRelease({ latestQuarter: "2026-03-31", latestAnnual: "2025-12-31", filings: [release("2026-10-13", "q3"), release("2026-10-20", "q3-recast"), release("2026-07-14", "q2")] })!;
  expect(behind).toMatchObject({ fiscalQuarter: 3, accessionNumber: "q3" });
});

test("a quarter that ends mid-month counts from its own end date: Costco's 10 May quarter, released 28 May", () => {
  // Costco's 52-53 week year: 12-week quarters to 23 Nov, 15 Feb and 10 May, a 16-week fourth to 30 Aug.
  const costco = [
    release("2026-09-24", "c-q4"),
    filing("10-Q", "2026-06-03", "c-q3-10q", { reportDate: "2026-05-10" }),
    release("2026-05-28", "c-q3"),
    filing("10-Q", "2026-03-11", "c-q2-10q", { reportDate: "2026-02-15" }),
    release("2026-03-05", "c-q2"),
  ];
  const q3 = detectResultsRelease({ latestQuarter: "2026-02-15", latestAnnual: "2025-08-31", filings: costco.slice(2) })!;
  expect(q3).toMatchObject({ fiscalQuarter: 3, periodMonth: "2026-05", filed: "2026-05-28", accessionNumber: "c-q3", statementsForm: "10-Q" });
  // From 10 May, its 16-week fourth quarter is released after 30 Aug, with the 10-K.
  expect(detectResultsRelease({ latestQuarter: "2026-05-10", latestAnnual: "2025-08-31", filings: costco })).toMatchObject({
    fiscalQuarter: 4, periodMonth: "2026-08", accessionNumber: "c-q4", statementsForm: "10-K",
  });
  // Its own quarter's release, filed after the 15 Feb end, is not a newer quarter's.
  expect(detectResultsRelease({ latestQuarter: "2026-02-15", latestAnnual: "2025-08-31", filings: costco.slice(4) })).toBeNull();
  // A calendar quarter still waits for the month's end: 30 Jun to 30 Sep, so a 2.02 on 29 Sep is inside the quarter.
  expect(detectResultsRelease({ latestQuarter: "2026-06-30", latestAnnual: "2025-12-31", filings: [release("2026-09-29", "inside")] })).toBeNull();
});

test("a 10-Q filed after the release while the statements still lack it is named, not promised", () => {
  const filed = detectResultsRelease({ latestQuarter: "2026-06-30", latestAnnual: "2025-12-31", filings: [filing("10-Q", "2026-11-04", "q"), ...JPM_FILINGS] })!;
  expect(filed.periodicReport).toEqual({ form: "10-Q", filed: "2026-11-04", accessionNumber: "q" });
  expect(resultsReleaseText(filed)).toBe("Q3 (Sep 2026) results released 2026-10-13 (8-K); the 10-Q followed on 2026-11-04 and its statements are not in yet.");
});

test("a statement's filing is its SEC accession, else the original 10-Q or 10-K for its period", () => {
  const sec = { date: "2026-06-30", dateSource: "sec" as const, dateEvidence: { accessionNumber: "0001628280-26-054343", filed: "2026-08-06" } };
  expect(statementFiling(sec, JPM_FILINGS, ["10-Q", "10-K"])).toEqual({ form: "10-Q", filed: "2026-08-06", accessionNumber: "0001628280-26-054343" });
  // Off the list, the filed date still stands; only the form is unknown.
  expect(statementFiling(sec, [], ["10-Q"])).toEqual({ form: null, filed: "2026-08-06", accessionNumber: "0001628280-26-054343" });
  const provider = { date: "2026-06-30", dateSource: "provider" as const };
  const amended = [filing("10-Q/A", "2026-09-01", "amend", { reportDate: "2026-06-30" }), filing("10-Q", "2026-08-06", "orig", { reportDate: "2026-06-30" })];
  expect(statementFiling(provider, amended, ["10-Q", "10-K"])?.accessionNumber).toBe("orig");
  // A foreign issuer's annual period comes from its 20-F or 40-F.
  expect(statementFiling({ date: "2025-10-31" }, [filing("40-F", "2025-12-03", "ry", { reportDate: "2025-10-31" })], ["10-K", "20-F", "40-F"]))
    .toMatchObject({ form: "40-F", filed: "2025-12-03" });
  // A fiscal fourth quarter's period comes from the 10-K.
  expect(statementFiling({ date: "2025-12-31" }, JPM_FILINGS, ["10-Q", "10-K"])).toMatchObject({ form: "10-K", filed: "2026-02-13" });
  expect(statementFiling({ date: "2025-09-30" }, JPM_FILINGS, ["10-Q", "10-K"])).toBeNull();
});

afterEach(() => {
  mock.restore();
});

test("a server that predates the form filter sends every form: only the periodic reports, annual reports and 8-Ks are kept", async () => {
  const spy = spyOn(apiClient, "getCloudSecFilings").mockResolvedValue({
    filings: [
      { accessionNumber: "p", form: "424B2", filingDate: "2026-10-14", cik: "1", filingUrl: "" },
      { accessionNumber: "r", form: "8-K", filingDate: "2026-10-13", items: "2.02,9.01", cik: "1", filingUrl: "" },
      { accessionNumber: "q", form: "10-Q", filingDate: "2026-08-06", reportDate: "2026-06-30", cik: "1", filingUrl: "" },
      { accessionNumber: "s", form: "6-K", filingDate: "2026-08-01", cik: "1", filingUrl: "" },
      { accessionNumber: "f", form: "40-F/A", filingDate: "2026-01-10", reportDate: "2025-10-31", cik: "1", filingUrl: "" },
    ],
  } as never);
  expect(await cloudStatementReportSources.statementFilings("JPM")).toEqual([
    { form: "8-K", filed: "2026-10-13", accessionNumber: "r", items: ["2.02", "9.01"] },
    { form: "10-Q", filed: "2026-08-06", accessionNumber: "q", items: [], reportDate: "2026-06-30" },
    { form: "40-F/A", filed: "2026-01-10", accessionNumber: "f", items: [], reportDate: "2025-10-31" },
  ]);
  expect(spy.mock.calls[0]?.[0]).toMatchObject({ ticker: "JPM", forms: ["10-K", "10-Q", "8-K", "20-F", "40-F"] });
});

const config = createDefaultConfig("/tmp/gloom-statement-filings-unused");
const JPM: TickerFinancials = {
  quote: { symbol: "JPM", name: "JPMorgan Chase & Co.", price: 330, currency: "USD", change: 0, changePercent: 0, lastUpdated: Date.parse("2026-10-16T20:00:00Z") },
  annualStatements: [{ date: "2025-12-31", currency: "USD", totalRevenue: 181_850_000_000, dateSource: "sec", dateEvidence: { accessionNumber: "0001628280-26-008131", filed: "2026-02-13" } }],
  quarterlyStatements: [{ date: "2026-06-30", currency: "USD", totalRevenue: 52_850_000_000, dateSource: "sec", dateEvidence: { accessionNumber: "0001628280-26-054343", filed: "2026-08-06" } }],
  priceHistory: [],
};

/** `ticker JPM --json` with these sources, and the text report on the filings it read. */
async function tickerReport(financials: TickerFinancials, sources: StatementReportSources) {
  let data: any;
  await ticker("JPM", {
    // An equity reads its IPO from Gloom Cloud otherwise.
    listingIpo: async () => null,
    initMarketData: async () => ({
      config, dataDir: "/tmp/gloom-statement-filings-unused", statementSources: sources,
      store: { loadTicker: async () => null, loadAllTickers: async () => [] }, persistence: { close: () => {} },
      dataProvider: { ...createTestDataProvider({ getTickerFinancials: async () => financials }), getNews: async () => [] },
    }) as unknown as MarketContext,
    fail: (message) => { throw new Error(message); },
    printResult: (result) => { data = result.data; },
  });
  const text = (await buildTickerReport({
    symbol: "JPM", tickerFile: null, financials, config, toBase: async (value) => value, statementFilings: data.statementFilings,
  })).replace(/\u001b\[[0-9;]*m/g, "");
  return { text, data };
}

test("ticker names each latest period's form and filed date, and the quarter released since", async () => {
  const sources: StatementReportSources = {
    statementFilings: async () => JPM_FILINGS,
    bankFigures: async () => { throw new Error("ticker reads no bank figures"); },
  };
  const { text, data } = await tickerReport(JPM, sources);
  expect(text).toContain("Latest Annual (2025-12-31, 10-K filed 2026-02-13)");
  expect(text).toContain("Latest Quarter (2026-06-30, 10-Q filed 2026-08-06)");
  expect(text).toContain("Q3 (Sep 2026) results released 2026-10-13 (8-K); statements arrive with the 10-Q.");
  expect(data.statementFilings).toMatchObject({
    latestQuarter: { date: "2026-06-30", form: "10-Q", filed: "2026-08-06" },
    resultsRelease: { fiscalQuarter: 3, filed: "2026-10-13", accessionNumber: "0001628280-26-065582" },
  });

  // A failed filings read keeps the filed date the statement carries, and says nothing of a release.
  const failed = await tickerReport(JPM, { ...sources, statementFilings: async () => { throw new Error("offline"); } });
  expect(failed.text).toContain("Latest Quarter (2026-06-30, filed 2026-08-06)");
  expect(failed.text).not.toContain("results released");
});


test("loadOfferingFilings skips non-US listings and leaves no note or error on a failed read", async () => {
  const read = spyOn(cloudStatementReportSources, "offeringFilings").mockRejectedValue(new Error("offline"));
  expect(await loadOfferingFilings(cloudStatementReportSources, { symbol: "SAP", exchange: "XETRA" }, true)).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  const filings = await loadOfferingFilings(cloudStatementReportSources, { symbol: "VKTX", exchange: "NASDAQ" }, true);
  expect(read).toHaveBeenCalledTimes(1);
  expect(filings).toEqual([]);
  expect(offeringNote(filings, "2026-06-30")).toBeNull();
});
