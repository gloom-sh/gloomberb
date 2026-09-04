import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createCreditConditionsHeadless } from "./headless";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };

describe("credit conditions headless model", () => {
  test("returns normalized spread rows and partial errors", async () => {
    const headless = createCreditConditionsHeadless({
      load: async () => ({
        rows: [{
          seriesId: "BAMLC0A0CM",
          label: "US IG",
          title: "US Corporate Option-Adjusted Spread",
          units: "Percent",
          frequency: "Daily",
          oasBp: 82.4,
          dailyChangeBp: 1.2,
          date: "2026-09-03",
          stale: false,
        }],
        stale: false,
        errors: ["one series unavailable"],
      }),
    });
    const result = await headless.load(args, {} as HeadlessPaneContext);

    expect(result.rows).toEqual([expect.objectContaining({ label: "US IG", oasBp: 82.4 })]);
    expect(result.errors).toEqual(["one series unavailable"]);
  });
});
