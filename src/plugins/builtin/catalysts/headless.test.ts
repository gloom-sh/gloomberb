import { expect, test } from "bun:test";
import { deriveHeadlessFreshness } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText, serializeHeadlessPaneResult } from "../../../cli/pane-functions/headless";
import { renderReportCsv } from "../../../cli/report-tables";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessPaneContext } from "../../../types/headless";
import { catalystsHeadless, litigationHeadless } from "./headless";
import { catalystFixture, catalystPayload } from "./test-fixture";

async function report(definition: typeof catalystsHeadless, access: { pro: boolean; lockedRows: number }) {
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
