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
  expect(text).toContain(`Pro: ${lock}`);
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
