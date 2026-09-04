import { describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { createYieldCurveHeadless } from "./headless";

const args: HeadlessPaneLoadArgs = { rawArgument: "", argument: null, symbols: [], options: {} };

describe("yield curve headless model", () => {
  test("returns ordered maturities and the shared 2Y to 10Y spread", async () => {
    const headless = createYieldCurveHeadless({
      load: async () => [
        { maturity: "10Y", maturityYears: 10, yield: 4.1, asOf: "2026-09-03" },
        { maturity: "2Y", maturityYears: 2, yield: 4.35, asOf: "2026-09-04" },
      ],
    });
    const result = await headless.load(args, {} as HeadlessPaneContext);

    expect(result.rows.map((row) => row.maturity)).toEqual(["2Y", "10Y"]);
    expect(result.metadata).toEqual({
      asOf: "2026-09-04",
      inverted: true,
      spread2Y10YBasisPoints: -25,
    });
  });
});
