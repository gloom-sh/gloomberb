import { expect, test } from "bun:test";
import type { AwardFilter, AwardsPayload } from "../../../api-client/awards";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import { createTestDataProvider, createTestQuote } from "../../../test-support/data-provider";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessPaneContext } from "../../../types/headless";
import { awardsHeadless } from "./headless";
import { awardHistory, awardRow, awardsPayload } from "./test-fixture";

const source = (name: string, coverageStart: string | null, records: number): AwardsPayload["sources"][number] => ({ source: name, enabled: true,
  lastAttemptAt: null, lastOkAt: null, nextPollAt: null, failures: 0, lastError: null, cursor: null, coverageStart, coverageEnd: null, coverageComplete: false, records, requestsToday: 0 });
// The free preview: the latest awards of anyone, whatever was asked, with Pro's sources behind it.
const preview = awardsPayload({ access: "preview", locked: true, generatedAt: "2026-10-11T12:00:00Z",
  rows: ["UK", "US", "CA"].map((country, index) => awardRow({ id: `award-${index}`, entity: null, recipient: { name: `${country} supplier` }, awardDate: "2026-10-05" })),
  sources: [source("uk-contracts-finder", "2026-09-27", 1_384), source("usaspending", "2024-10-01", 37_458), source("ted", null, 0)] });

async function report(ticker: string, getQuote: HeadlessPaneContext["marketData"]["getQuote"]) {
  const requests: AwardFilter[] = [];
  const quotes: string[] = [];
  const ctx = createTestHeadlessContext({
    apiClient: { getCloudAwards: async (query: AwardFilter) => { requests.push(query); return structuredClone(preview); } } as unknown as HeadlessPaneContext["apiClient"],
    marketData: createTestDataProvider({ getQuote: async (symbol, exchange) => { quotes.push(symbol); return getQuote(symbol, exchange); } }),
  });
  const args = createTestHeadlessArgs({ rawArgument: ticker, argument: ticker || null, options: { tab: "feed", type: "prime", limit: 100 } });
  const result = await awardsHeadless.load(args, ctx);
  return { result, requests, quotes, text: renderHeadlessPaneText(awardsHeadless, result, args, "AWARDS") };
}

const lock = "Free shows the 3 latest awards from any company: the preview can't filter by ticker. Gloom Pro adds ticker filters and every collected award, with history from 1 Oct 2024.";

test("a ticker the preview cannot filter by is named as such, never as the ticker's awards", async () => {
  const { result, requests, text } = await report("LMT", async () => createTestQuote({ symbol: "LMT" }));
  expect(requests[0]?.ticker).toBe("LMT");
  expect(result.errors).toEqual([lock]);
  expect(result.metadata).toMatchObject({ filters: { ticker: "LMT" }, filtersApplied: false });
  // Whether LMT has awards is not in a preview, so the report does not say it has none.
  expect(text).toContain(`Pro: ${lock.replace(/\.$/, "")} · gloom.sh/cloud`);
  expect(text).not.toMatch(/No LMT awards|Not a ticker/);
});

test("a symbol no listing has is said apart from a real ticker, and a failed lookup claims nothing", async () => {
  const missing = await report("ZZZZQ", async (symbol) => { throw new Error(`Not a ticker: ${symbol}.`); });
  expect(missing.result.errors).toEqual(["Not a ticker: ZZZZQ.", lock]);
  expect(missing.text).toContain("Errors: Not a ticker: ZZZZQ.");
  const timedOut = await report("LMT", async () => { throw new Error("Quote request timed out"); });
  expect(timedOut.result.errors).toEqual([lock]);
});

test("with no ticker the preview is the latest awards, and an award date after today says it is the source's", async () => {
  const { result, quotes } = await report("", async () => createTestQuote());
  expect(quotes).toEqual([]);
  expect(result.errors).toEqual(["Free shows the 3 latest awards. Gloom Pro adds every collected award and filters, with history from 1 Oct 2024."]);
  expect(result.notes).toBeUndefined();

  const future = awardsPayload({ ...preview, rows: [awardRow({ awardDate: "2026-10-31" }), awardRow({ id: "award-2", awardDate: "2026-10-12", dateBasis: "period-start" })] });
  const ctx = createTestHeadlessContext({ apiClient: { getCloudAwards: async () => future } as unknown as HeadlessPaneContext["apiClient"] });
  const dated = await awardsHeadless.load(createTestHeadlessArgs({ options: { tab: "feed" } }), ctx);
  // A future period start is a schedule, not an award date.
  expect(dated.notes).toEqual(["1 award date is after today, as the source published it."]);
});

test("collection health is a coverage note, never an error, and an empty selection says so once", async () => {
  const gaps = ["Some jurisdictions are awaiting their first collection.", "Some source records were quarantined; historical coverage is incomplete."];
  const run = async (payload: AwardsPayload) => {
    const args = createTestHeadlessArgs({ options: { tab: "feed" } });
    const result = await awardsHeadless.load(args, createTestHeadlessContext({ apiClient: { getCloudAwards: async () => payload } as unknown as HeadlessPaneContext["apiClient"] }));
    return { result, text: renderHeadlessPaneText(awardsHeadless, result, args, "AWARDS") };
  };
  const partial = await run(awardsPayload({ status: "partial", gaps }));
  expect(partial.result.errors).toEqual([]);
  expect(partial.result.notes).toEqual(gaps);
  expect(partial.text).toContain(`Notes:\n  ${gaps[0]}\n  ${gaps[1]}`);
  expect(partial.text).not.toContain("Errors");

  const none = await run(awardsPayload({ status: "unavailable", rows: [], alerts: [], history: [], agencies: [], sectors: [], gaps: ["No awards are available for this selection.", gaps[0]!] }));
  expect(none.result).toMatchObject({ empty: "No awards are available for this selection.", notes: [gaps[0]], errors: [] });
  expect(none.text).toContain("No awards are available for this selection.");
  expect(none.text).not.toContain("Errors");
});

test("cohort amounts print compact as the pane draws them, while exports keep the source's exact decimals", async () => {
  const payload = awardsPayload({ history: [awardHistory({ month: "2026-10-01", cumulativeObligatedAmount: "2087053990255.52" })] });
  const args = createTestHeadlessArgs({ rawArgument: "TEST", argument: "TEST", symbols: ["TEST"], options: { tab: "company" } });
  const result = await awardsHeadless.load(args, createTestHeadlessContext({
    apiClient: { getCloudAwards: async () => payload } as unknown as HeadlessPaneContext["apiClient"],
  }));
  const freshness = deriveHeadlessFreshness(awardsHeadless, result);
  const text = renderHeadlessPaneText(awardsHeadless, result, args, "AWARDS", freshness);
  expect(text).toContain("2.09T");
  expect(text).toContain("100.00M");
  expect(text).not.toContain("2087053990255");
  const csv = renderReportCsv(headlessReportTables(awardsHeadless, result, args, "AWARDS", freshness, { complete: true, unavailableSymbols: [] }));
  expect(csv).toContain("2087053990255.52");
  expect(csv).toContain("100000000.05");
});

test("a source's licence statement is a note under the awards it covers", async () => {
  const notice = "Contains information from Government Procurement via GeBIZ accessed on 12 November 2026 from data.gov.sg which is made available under the terms of the Singapore Open Data Licence version 1.0 https://data.gov.sg/open-data-licence";
  const payload = awardsPayload({ rows: [awardRow({ source: "sg-gebiz", jurisdiction: "SG", currency: "SGD", revenueComparison: null })], sources: [{ ...source("sg-gebiz", "2021-04-01", 246), attribution: notice }] });
  const run = (tab: string) => awardsHeadless.load(createTestHeadlessArgs({ options: { tab } }),
    createTestHeadlessContext({ apiClient: { getCloudAwards: async () => payload } as unknown as HeadlessPaneContext["apiClient"] }));
  expect((await run("feed")).notes).toEqual([notice]);
  // The agencies here are another source's, so the statement is not theirs to carry.
  expect((await run("agencies")).notes).toBeUndefined();
});

test("a value the source withholds reads withheld, with how its amounts read, in the feed and an award read alone", async () => {
  const attribution = "Contains information from Government Procurement via GeBIZ from data.gov.sg which is made available under the terms of the Singapore Open Data Licence version 1.0 https://data.gov.sg/open-data-licence";
  const amountNotice = "Singapore GeBIZ amounts are as the Ministry of Finance's dataset prints them. An amount under S$6,000, or one that two or more suppliers of a tender print alike, is shown as no amount.";
  const gebiz = awardRow({ id: "award-sg", source: "sg-gebiz", jurisdiction: "SG", currency: "SGD", awardAmount: null, obligatedAmount: null, ceilingAmount: null,
    recipient: { name: "CYCLE & CARRIAGE KIA PTE LTD" }, revenueComparison: null });
  // An award with no amount from a source that withholds none is unreported, never withheld.
  const unreported = awardRow({ id: "award-us", awardAmount: null });
  const payload = awardsPayload({ rows: [gebiz, unreported], sources: [{ ...source("sg-gebiz", "2021-04-01", 246), attribution, amountNotice }] });
  const apiClient = { getCloudAwards: async () => payload,
    getCloudAward: async () => ({ row: gebiz, revisions: [{ id: "revision-sg", observedAt: "2026-11-12T02:25:37Z", sourceUpdatedAt: null, supersedes: null, award: gebiz }],
      subawards: [], modifications: [], edges: [], access: "full", locked: false, attribution, amountNotice }) } as unknown as HeadlessPaneContext["apiClient"];
  for (const options of [{ tab: "feed" }, { award: "award-sg" }] as Record<string, string>[]) {
    const args = createTestHeadlessArgs({ options });
    const result = await awardsHeadless.load(args, createTestHeadlessContext({ apiClient }));
    expect(result.notes).toEqual([attribution, amountNotice]);
    const lines = renderHeadlessPaneText(awardsHeadless, result, args, "AWARDS", deriveHeadlessFreshness(awardsHeadless, result)).split("\n");
    expect(lines.find((line) => line.includes("CYCLE & CARRIAGE KIA"))).toMatch(/SGD\s+withheld\s/);
    if (options.tab) expect(lines.find((line) => line.includes("Contractor Corporation"))).not.toContain("withheld");
    // An award read alone: its revision's value too.
    else expect(lines.filter((line) => line.includes("withheld"))).toHaveLength(2);
  }
});
