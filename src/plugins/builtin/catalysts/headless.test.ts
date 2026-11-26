import { expect, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessPaneContext } from "../../../types/headless";
import { catalystsHeadless, litigationHeadless } from "./headless";
import { catalystFixture, catalystPayload } from "./test-fixture";

function exportCsv(result: Awaited<ReturnType<typeof catalystsHeadless.load>>, args: ReturnType<typeof createTestHeadlessArgs>): string {
  return renderReportCsv(headlessReportTables(catalystsHeadless, result, args, "CATL", deriveHeadlessFreshness(catalystsHeadless, result), { complete: true, unavailableSymbols: [] }));
}

async function report(definition: typeof catalystsHeadless, access: { pro: boolean; lockedRows: number; lockedUpcoming?: number }) {
  const ctx = createTestHeadlessContext({
    apiClient: { getCloudCatalysts: async () => ({ ...catalystPayload(), total: 1 + access.lockedRows, access: { ...access, previewLimit: 3 } }) } as unknown as HeadlessPaneContext["apiClient"],
  });
  const args = createTestHeadlessArgs({ rawArgument: "PFE", argument: "PFE", options: { tab: "calendar", limit: 100 } });
  const result = await definition.load(args, ctx);
  return { result, text: renderHeadlessPaneText(definition, result, args, "CATL") };
}

test("a free preview says how many events it holds back, so it never reads as complete", async () => {
  const { result, text } = await report(catalystsHeadless, { pro: false, lockedRows: 193 });
  expect(result.complete).toBe(false);
  expect(result.errors).toEqual(["193 more events need Gloom Pro"]);
  expect(text).toContain("Pro: 193 more events need Gloom Pro");
  expect((await report(litigationHeadless, { pro: false, lockedRows: 4 })).result.errors).toEqual(["4 more cases need Gloom Pro"]);
  expect((await report(litigationHeadless, { pro: false, lockedRows: 1 })).result.errors).toEqual(["1 more case needs Gloom Pro"]);
  expect((await report(catalystsHeadless, { pro: false, lockedRows: 1204 })).result.errors).toEqual(["1,204 more events need Gloom Pro"]);
  // The service counts the held-back events still to come, and the line says so.
  expect((await report(catalystsHeadless, { pro: false, lockedRows: 2, lockedUpcoming: 1 })).text).toContain("Pro: 2 more events (1 upcoming) need Gloom Pro");
});

test("a Pro report holds nothing back", async () => {
  const { result } = await report(catalystsHeadless, { pro: true, lockedRows: 0 });
  expect(result.complete).not.toBe(false);
  expect(result.errors).toBeUndefined();
});

test("the text reads like the pane while exports keep the service's codes", async () => {
  const { result, text } = await report(catalystsHeadless, { pro: true, lockedRows: 0 });
  // The fixture's date is a deadline, its party Pfizer Inc, its status RECRUITING.
  expect(text).toMatch(/Deadline +PFE\S* +Pfizer +Primary completion date updated +Clinical +Recruiting/);
  const csv = renderReportCsv(headlessReportTables(catalystsHeadless, result, createTestHeadlessArgs({ argument: "PFE" }), "CATL",
    deriveHeadlessFreshness(catalystsHeadless, result), { complete: true, unavailableSymbols: [] }));
  expect(csv).toContain("clinical,RECRUITING,FDA");
  // The parties print as names in CSV, but JSON keeps the service's array.
  expect(csv.split("\n")[0]).toContain("Parties");
  expect(csv).toContain("Pfizer");
  const json = serializeHeadlessPaneResult(catalystsHeadless, result) as { sections: Array<{ rows: Array<{ parties: unknown }> }> };
  expect(json.sections[0]!.rows[0]!.parties).toEqual(catalystFixture.parties);
});

test("a kind report reads its types together in calendar order, under the pane's columns for it", async () => {
  const party = (name: string, ticker: string | null) => ({ ...catalystFixture.parties[0]!, name, ticker });
  const results = { ...catalystFixture, id: "results", type: "results" as const, title: "Fourth quarter results", status: "scheduled", deadlineDate: "2027-02-03", datePrecision: { deadline: "day" as const } };
  const vote = { ...catalystFixture, id: "vote", type: "merger_vote" as const, title: "Vote on the merger", status: "scheduled", deadlineDate: "2027-01-20", datePrecision: { deadline: "day" as const },
    parties: [party("Pfizer Inc", "PFE"), party("Metsera, Inc.", null)] };
  const types: string[] = [];
  const ctx = createTestHeadlessContext({
    apiClient: { getCloudCatalysts: async (query: { type?: string }) => {
      types.push(String(query.type));
      const events = query.type === "results" ? [results] : query.type === "merger_vote" ? [vote] : [];
      return { ...catalystPayload(), events, total: events.length };
    } } as unknown as HeadlessPaneContext["apiClient"],
  });
  const args = createTestHeadlessArgs({ rawArgument: "PFE", argument: "PFE", options: { tab: "calendar", kind: "company", limit: 100 } });
  const result = await catalystsHeadless.load(args, ctx);
  expect(types.sort()).toEqual(["deal_closing", "investor_day", "merger_vote", "results", "shareholder_meeting"]);
  const [section] = (result as unknown as { sections: Array<{ title: string; columns: Array<{ header: string }>; rows: Array<{ id: string; with?: string }> }> }).sections;
  expect(section!.title).toBe("Company events");
  // PFE's own calendar: the other party, not PFE again; two types, so the Type column stays,
  // and what every row says alike (scheduled, filed with one body) is left out, as in the pane.
  expect(section!.columns.map((column) => column.header)).toEqual(["Date", "With", "Event", "Type", "Primary source"]);
  expect(section!.rows.map((row) => [row.id, row.with])).toEqual([["vote", "Metsera"], ["results", ""]]);
  expect(renderHeadlessPaneText(catalystsHeadless, result, args, "CATL")).toMatch(/20 Jan 2027 +Metsera +Vote on the merger +Merger vote/);
  // The text draws the day first; JSON and CSV keep the ISO day, as the default calendar does.
  expect((serializeHeadlessPaneResult(catalystsHeadless, result) as { sections: Array<{ rows: Array<{ date: string }> }> }).sections[0]!.rows.map((row) => row.date))
    .toEqual(["2027-01-20", "2027-02-03"]);
  expect(exportCsv(result, args).split("\n").slice(1, 3).map((line) => line.split(",")[0])).toEqual(["2027-01-20", "2027-02-03"]);
});

test("a change reads its days first in the text and keeps them in ISO in JSON and CSV", async () => {
  const ctx = createTestHeadlessContext({ apiClient: { getCloudCatalysts: async () => catalystPayload(),
    getCloudCatalystEvent: async () => ({ event: catalystFixture, history: [catalystFixture], historyTotal: 1, historyOffset: 0, historyHasMore: false, historyTruncated: false,
      asOf: catalystFixture.observedAt, access: { pro: true, lockedRows: 0, previewLimit: 3 } }) } as unknown as HeadlessPaneContext["apiClient"] });
  for (const options of [{ tab: "changes" }, { event: "event-1" }] as Array<Record<string, string>>) {
    const args = createTestHeadlessArgs({ rawArgument: "PFE", argument: "PFE", options });
    const result = await catalystsHeadless.load(args, ctx);
    expect(renderHeadlessPaneText(catalystsHeadless, result, args, "CATL")).toContain("Deadline: 01 Mar 2027 → 01 Apr 2027");
    const sections = (serializeHeadlessPaneResult(catalystsHeadless, result) as { sections: Array<{ rows?: Array<{ changeSummary: string }> }> }).sections;
    expect(sections.find((section) => section.rows)!.rows![0]!.changeSummary).toBe("Deadline: 2027-03-01 → 2027-04-01");
    expect(exportCsv(result, args)).toContain("Deadline: 2027-03-01 → 2027-04-01");
  }
});
