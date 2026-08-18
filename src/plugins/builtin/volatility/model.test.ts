import { describe, expect, test } from "bun:test";
import { buildVolatilityData } from "./model";

const info = {
  id: "VIXCLS",
  title: "CBOE Volatility Index: VIX",
  units: "Index",
  frequency: "Daily, Close",
  seasonalAdjustment: "Not Seasonally Adjusted",
  source: "",
  notes: "",
};

describe("buildVolatilityData", () => {
  test("aligns term values and ratios to the latest shared close", () => {
    const data = buildVolatilityData({
      VIXCLS: {
        info,
        observations: [
          { date: "2026-08-17", value: 20 },
          { date: "2026-08-14", value: 10 },
        ],
      },
      VXVCLS: {
        info: { ...info, id: "VXVCLS", title: "CBOE S&P 500 3-Month Volatility Index" },
        observations: [{ date: "2026-08-14", value: 15 }],
      },
    });

    expect(data.metrics[0]?.value).toBe(20);
    expect(data.termDate).toBe("2026-08-14");
    expect(data.termPoints.map((point) => point.value)).toEqual([10, 15]);
    expect(data.ratio).toBe(1.5);
    expect(data.slope).toBe(5);
    expect(data.termState).toBe("normal");
  });

  test("reports partial state instead of combining unmatched dates", () => {
    const data = buildVolatilityData({
      VIXCLS: {
        info,
        observations: [{ date: "2026-08-17", value: 15 }],
      },
      VXVCLS: {
        info: { ...info, id: "VXVCLS" },
        observations: [{ date: "2026-08-14", value: 19 }],
      },
    });

    expect(data.termDate).toBeNull();
    expect(data.ratio).toBeNull();
    expect(data.termPoints.map((point) => point.value)).toEqual([null, null]);
    expect(data.termState).toBe("partial");
  });

  test("classifies a lower three-month implied-volatility close as inverted", () => {
    const data = buildVolatilityData({
      VIXCLS: { info, observations: [{ date: "2026-08-17", value: 24 }] },
      VXVCLS: { info: { ...info, id: "VXVCLS" }, observations: [{ date: "2026-08-17", value: 20 }] },
    });

    expect(data.termState).toBe("inverted");
    expect(data.ratio).toBeCloseTo(20 / 24);
    expect(data.slope).toBe(-4);
  });
});
