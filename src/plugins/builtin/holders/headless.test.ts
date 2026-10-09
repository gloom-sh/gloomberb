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
    // The fund with a change is shown, so the change columns stay.
    expect(byValue.columns?.map((column) => column.key)).toContain("changeShares");
    expect(byValue.metadata).toMatchObject({ shown: 1, reported: 2, truncated: true });
  });

  test("drops the change columns no row fills and says once where the change is", async () => {
    const headless = createHoldersHeadless({
      loadSnapshot: async () => ({
        data: {
          symbol: "BHP.L",
          name: "BHP Group Limited",
          currency: "GBp",
          exchange: "LSE",
          asOf: "2026-06-30",
          holders: [
            { ownerType: "institution", name: "First", value: 210_660_700, shares: 66_100, reportDate: "2026-06-30" },
            { ownerType: "institution", name: "Second", value: 382_440, shares: 120, reportDate: "2026-06-30" },
          ],
        },
      }),
    });

    const result = await headless.load({ ...args(), rawArgument: "BHP", argument: "BHP", symbols: ["BHP"] }, createTestHeadlessContext());
    expect(result.columns?.map((column) => column.key)).toEqual(["name", "ownerType", "value", "shares", "percentHeld", "reportDate"]);
    expect(result.columns?.find((column) => column.key === "value")?.header).toBe("Mkt value (GBp)");
    // JSON keeps the fields; only the text table loses the empty columns.
    expect(result.rows[0]).toMatchObject({ changeShares: null, changePercent: null });
    expect(result.metadata?.notices).toEqual([
      "BHP Group Limited (BHP.L) | LSE | GBp (pence) | top 2 reported",
      "Mkt value = shares reported at 2026-06-30 x latest price. Change vs prior quarter: not reported by this source; see fn 13F BHP",
      "Positions come from institutional filings (mostly US 13F), not the LSE share register.",
    ]);
  });
});
