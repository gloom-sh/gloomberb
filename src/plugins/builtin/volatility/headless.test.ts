import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createVolatilityHeadless } from "./headless";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };

describe("volatility headless model", () => {
  test("projects aligned tenors and the derived curve state", async () => {
    const headless = createVolatilityHeadless({
      load: async () => ({
        data: {
          metrics: [
            { seriesId: "VIXCLS", label: "VIX", tenor: "30D", title: "VIX", value: 18, date: "2026-09-03", history: [] },
            { seriesId: "VXVCLS", label: "VIX 3M", tenor: "3M", title: "VIX 3M", value: 21, date: "2026-09-03", history: [] },
          ],
          termPoints: [],
          termDate: "2026-09-03",
          ratio: 21 / 18,
          slope: 3,
          ratioHistory: [],
          termState: "normal",
        },
        stale: false,
        errors: [],
      }),
    });
    const result = await headless.load(args, {} as HeadlessPaneContext);

    expect(result.sections[0]?.entries?.slice(0, 2)).toEqual([
      { label: "State", value: "normal" },
      { label: "As of", value: "2026-09-03" },
    ]);
    expect(result.sections[1]?.rows?.[0]).toMatchObject({ label: "VIX", value: 18 });
  });
});
