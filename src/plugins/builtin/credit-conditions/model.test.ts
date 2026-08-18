import { describe, expect, test } from "bun:test";
import { CREDIT_SERIES, normalizeCreditSeries } from "./model";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    observations: [
      { date: "2026-08-17", value: 0.81 },
      { date: "2026-08-14", value: 0.8 },
      { date: "2026-08-16", value: null },
    ],
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

  test("rejects metadata that would make spread normalization misleading", () => {
    expect(() => normalizeCreditSeries(CREDIT_SERIES[0], payload({ units: "Index" }))).toThrow("unexpected FRED metadata");
    expect(() => normalizeCreditSeries(CREDIT_SERIES[0], payload({ title: "Corporate Effective Yield" }))).toThrow("unexpected FRED metadata");
  });
});
