import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createYieldCurveHeadless } from "./headless";
import { TREASURY_MATURITIES } from "./treasury-data";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };

describe("yield curve headless model", () => {
  test("marks a partial, mixed-date curve incomplete and does not calculate a spread", async () => {
    const headless = createYieldCurveHeadless({
      load: async () => [
        { maturity: "10Y", maturityYears: 10, yield: 4.1, asOf: "2026-09-03" },
        { maturity: "2Y", maturityYears: 2, yield: 4.35, asOf: "2026-09-04" },
      ],
    });
    const result = await headless.load(args, {} as HeadlessPaneContext);
    expect(result.rows).toHaveLength(10);
    expect(result.metadata).toMatchObject({
      requestedDate: null, asOf: null, inverted: null, spread2Y10YBasisPoints: null,
      missingTenors: ["1M", "3M", "6M", "1Y", "5Y", "7Y", "20Y", "30Y"], stale: false,
    });
    expect(result.errors).toHaveLength(2);
  });

  test("date options call bounded series history, preserve observation dates and flag stale sources", async () => {
    const calls: string[] = [];
    const context = { apiClient: { getCloudFredSeries: async (id: string, options: { endDate: string }) => {
      calls.push(`${id}:${options.endDate}`);
      return {
        info: { units: "Percent", frequency: "Daily" },
        observations: [{ date: "2024-03-01", value: id === "DGS2" ? 4.54 : 4.19 }],
        stale: id === "DGS30",
      };
    } } } as unknown as HeadlessPaneContext;
    const result = await createYieldCurveHeadless().load({ ...args, options: { date: "2024-03-02" } }, context);
    expect(calls).toEqual(TREASURY_MATURITIES.map(({ seriesId }) => `${seriesId}:2024-03-02`));
    expect(result.metadata).toMatchObject({ requestedDate: "2024-03-02", asOf: "2024-03-01", spread2Y10YBasisPoints: -35, missingTenors: [], stale: true });
    expect(result.errors).toEqual(["Some Treasury sources are stale cached data."]);
  });
});
