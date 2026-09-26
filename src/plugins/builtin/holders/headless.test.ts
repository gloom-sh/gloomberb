import { describe, expect, test } from "bun:test";
import type { HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createHoldersHeadless } from "./headless";
import { createTestHeadlessContext } from "../../../test-support/headless";

function args(overrides: Partial<HeadlessPaneLoadArgs["options"]> = {}): HeadlessPaneLoadArgs {
  return {
    rawArgument: "NVDA",
    argument: "NVDA",
    symbols: ["NVDA"],
    options: { sort: "value", order: "desc", limit: 25, ...overrides },
  };
}

describe("holders headless model", () => {
  test("projects holder values and applies sorting and limits", async () => {
    const headless = createHoldersHeadless({
      loadSnapshot: async () => ({
        marketCap: 1_000,
        data: {
          symbol: "NVDA",
          currency: "USD",
          asOf: "2026-06-30",
          holders: [
            { ownerType: "institution", name: "Small Fund", value: 100, shares: 4, reportDate: "2026-06-30" },
            { ownerType: "fund", name: "Large Fund", value: 300, shares: 8, changeShares: 2, reportDate: "2026-06-30" },
          ],
        },
      }),
    });

    const byValue = await headless.load(args({ limit: 1 }), createTestHeadlessContext());
    expect(byValue.rows).toEqual([{
      name: "Large Fund",
      ownerType: "fund",
      value: 300,
      shares: 8,
      changeShares: 2,
      changePercent: null,
      percentHeld: 0.3,
      reportDate: "2026-06-30",
      currency: "USD",
    }]);

    const byName = await headless.load(args({ sort: "holder", order: "asc", limit: 2 }), createTestHeadlessContext());
    expect(byName.rows.map((row) => row.name)).toEqual(["Large Fund", "Small Fund"]);
  });
});
