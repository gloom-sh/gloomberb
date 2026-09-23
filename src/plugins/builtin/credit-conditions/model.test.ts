import { describe, expect, test } from "bun:test";
import { CREDIT_SERIES, normalizeCreditSeries } from "./model";

function payload(overrides: Record<string, unknown> = {}, observations: Array<{ date: string; value: number | null }> = [
  { date: "2026-08-17", value: 0.81 },
  { date: "2026-08-14", value: 0.8 },
  { date: "2026-08-16", value: null },
]) {
  return {
    observations,
    info: {
      id: "BAMLC0A0CM",
      title: "ICE BofA US Corporate Index Option-Adjusted Spread",
      units: "Percent",
      frequency: "Daily, Close",
      seasonalAdjustment: "Not Seasonally Adjusted",
      source: "",
      notes: "",
      ...overrides,
    },
  };
}

describe("normalizeCreditSeries", () => {
  test("converts the official percent OAS to basis points", () => {
    const row = normalizeCreditSeries(CREDIT_SERIES[0], payload(), true);

    expect(row).toMatchObject({
      label: "US IG",
      oasBp: 81,
      dailyChangeBp: 1,
      date: "2026-08-17",
      units: "Percent",
      frequency: "Daily, Close",
      stale: true,
    });
  });

  test("ranks the latest spread within the year before it, not the whole fetched history", () => {
    const row = normalizeCreditSeries(CREDIT_SERIES[0], payload({}, [
      { date: "2025-08-01", value: 3 },
      { date: "2025-08-20", value: 0.7 },
      { date: "2026-02-02", value: 0.9 },
      { date: "2026-08-17", value: 0.8 },
    ]));

    expect(row.history.map((point) => point.date)).toEqual(["2025-08-20", "2026-02-02", "2026-08-17"]);
    expect(row).toMatchObject({ percentile1Y: 50, rangeLowBp: 70, rangeHighBp: 90 });
  });

  test("rejects metadata that would make spread normalization misleading", () => {
    expect(() => normalizeCreditSeries(CREDIT_SERIES[0], payload({ units: "Index" }))).toThrow("unexpected FRED metadata");
    expect(() => normalizeCreditSeries(CREDIT_SERIES[0], payload({ title: "Corporate Effective Yield" }))).toThrow("unexpected FRED metadata");
    expect(() => normalizeCreditSeries(CREDIT_SERIES[0], payload({ id: "BAMLH0A0HYM2" }))).toThrow("unexpected FRED metadata");
  });
});
