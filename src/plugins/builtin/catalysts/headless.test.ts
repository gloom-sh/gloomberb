import { expect, test } from "bun:test";
import { renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HeadlessPaneContext } from "../../../types/headless";
import { catalystsHeadless, litigationHeadless } from "./headless";
import { catalystPayload } from "./test-fixture";

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
