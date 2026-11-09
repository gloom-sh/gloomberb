import { describe, expect, test } from "bun:test";
import type { MoneyMarketRow, MoneyMarketsPayload } from "../../../api-client/money-markets";
import { ApiRequestError } from "../../../api-client/errors";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import { fetchMoneyMarkets, validateHongKongMoneyMarkets, validateMoneyMarkets } from "./client";
import { moneyMarketsHeadless } from "./headless";
import { createTestHeadlessArgs, createTestHeadlessContext } from "../../../test-support/headless";
import type { HongKongMoneyMarketsPayload } from "../../../api-client/money-markets";
import { moneyMarketAxis, moneyMarketCurves, moneyMarketHistory, moneyMarketNotices, moneyMarketObservations, moneyMarketRateChange, moneyMarketRows } from "./model";

function row(id = "sofr", overrides: Partial<MoneyMarketRow> = {}): MoneyMarketRow {
  return { id, label: id, seriesId: "SOFR", sourceSeriesIds: ["SOFR"], sourceUrl: null,
    group: "rates", unit: "percent", frequency: "daily", value: 0, asOf: "2026-09-21", previousValue: -0.01,
    previousAsOf: "2026-09-18", change: 1, changeUnit: "basis-points",
    percentile: { value: 50, rank: 2, sampleCount: 4, windowStart: "2025-09-21", windowEnd: "2026-09-21", min: -0.01, max: 0, mean: 0 },
    history: [{ date: "2026-09-18", value: -0.01 }, { date: "2026-09-21", value: 0 }], status: "available", fetchedAt: "2026-09-22T10:00:00Z", unavailableReason: null, notes: [], ...overrides };
}
function payload(): MoneyMarketsPayload {
  return { generatedAt: "2026-09-22T10:00:00Z", status: "available", rows: [row()],
    netLiquidity: row("net-liquidity", { group: "liquidity", unit: "usd-billions", changeUnit: "usd-billions" }),
    billsCurve: { asOf: "2026-09-21", status: "available", basis: "discount",
      points: [{ tenor: "4W", maturityYears: 28 / 365, seriesId: "DTB4WK", value: 0 }],
      comparisons: [{ period: "1W", targetDate: "2026-09-14", asOf: "2026-09-11", points: [{ tenor: "4W", maturityYears: 28 / 365, seriesId: "DTB4WK", value: -0.1 }] }, { period: "1Y", targetDate: "2025-09-21", asOf: null, points: [] }],
      slope: { valueBps: null, asOf: null, percentile: row().percentile, history: [] } } };
}

describe("money-market boundary", () => {
  test("keeps explicit zero, negative rates and a partially missing source", () => {
    const data = payload();
    data.status = "partial";
    data.rows.push(row("effr", { value: null, asOf: null, change: null, history: [], status: "unavailable", unavailableReason: "metadata-mismatch" }));
    expect(validateMoneyMarkets(data).rows[0]?.value).toBe(0);
    expect(moneyMarketRows(data, "rates")).toHaveLength(2);
    expect(moneyMarketNotices(data)).toContain("effr: metadata mismatch.");
    expect(moneyMarketRows(data, "liquidity").map((row) => row.id)).toEqual(["net-liquidity"]);
  });
  test("rejects impossible dates, nonfinite rates, incompatible units and undated curves", () => {
    for (const mutate of [
      (data: MoneyMarketsPayload) => { data.rows[0]!.asOf = "2026-02-30"; },
      (data: MoneyMarketsPayload) => { data.rows[0]!.value = NaN; },
      (data: MoneyMarketsPayload) => { data.rows[0]!.changeUnit = "usd-billions"; },
      (data: MoneyMarketsPayload) => { data.rows[0]!.percentile.value = 101; },
      (data: MoneyMarketsPayload) => { data.billsCurve.asOf = null; },
      (data: MoneyMarketsPayload) => { data.rows[0]!.percentile.windowStart = "2025-02-29"; },
    ]) { const data = payload(); mutate(data); expect(() => validateMoneyMarkets(data)).toThrow(); }
  });
  test("preserves distinct ghost dates and omits unavailable comparisons", () => {
    const curves = moneyMarketCurves(payload());
    expect(curves.map((curve) => [curve.id, curve.asOf])).toEqual([["today", "2026-09-21"], ["1W", "2026-09-11"]]);
    expect(curves[1]?.points[0]?.value).toBe(-0.1);
    expect(curves[1]?.points[0]?.asOf).toBe("2026-09-11");
  });
  test("history charts use the percentile window and run across holidays without a fixing", () => {
    const observation = row("sofr", { history: [
      { date: "2025-08-22", value: 9 }, { date: "2025-09-21", value: 4 },
      { date: "2026-09-18", value: null }, { date: "2026-09-21", value: 0 },
    ] });
    expect(moneyMarketHistory(observation)).toEqual(observation.history.slice(1));
    // A null is a holiday, not a break in the series; a zero rate is a fixing.
    expect(moneyMarketObservations(observation)).toEqual([{ date: "2025-09-21", value: 4 }, { date: "2026-09-21", value: 0 }]);
  });
  test("chart labels read in the board's units at the range's precision", () => {
    const domain = (min: number, max: number): CompositeAxisDomain => ({ side: "right", min, max, scale: "linear", unit: "", unitGroup: "", seriesIds: [] });
    expect(moneyMarketAxis("percent")(3.84, domain(3.45, 4.36))).toBe("3.84%");
    expect(moneyMarketAxis("usd-billions")(5800, domain(5559, 6021))).toBe("$5,800B");
    expect(moneyMarketAxis("usd-billions")(0.5, domain(0.2, 0.9))).toBe("$0.50B");
    expect(moneyMarketRateChange(0.11)).toBe("+11.0bp");
    expect(moneyMarketRateChange(-0.16)).toBe("-16.0bp");
  });
  test("missing endpoint gives an actionable unavailable state without hiding auth errors", async () => {
    await expect(fetchMoneyMarkets({ getCloudMoneyMarkets: async () => { throw new ApiRequestError("not found", 404); } })).rejects.toThrow("not available yet");
    const denied = new ApiRequestError("sign in", 401);
    await expect(fetchMoneyMarkets({ getCloudMoneyMarkets: async () => { throw denied; } })).rejects.toBe(denied);
  });
});

describe("Hong Kong's HIBOR board", () => {
  const hibor = (tenor: string, value: number, asOf: string) => row(`hibor-${tenor}`, { label: `HIBOR ${tenor}`, group: "hibor", seriesId: null,
    sourceSeriesIds: [], value, asOf, previousAsOf: "2026-10-29", history: [{ date: "2026-10-29", value: value - 0.1 }, { date: asOf, value }] });
  const hongKong = (): HongKongMoneyMarketsPayload => ({ generatedAt: "2026-11-09T12:00:00Z", status: "available", currency: "HKD",
    source: { name: "Hong Kong Monetary Authority", url: "https://api.hkma.gov.hk" },
    rows: [hibor("O/N", 2.77464, "2026-10-30"), hibor("1M", 2.56113, "2026-11-06"), hibor("3M", 3.21256, "2026-10-30")] });

  test("fn BTMM --tab hk reads Hong Kong's own payload, each fixing dated by its day, and says HKMA is its source", async () => {
    let asked = 0;
    const args = createTestHeadlessArgs({ options: { tab: "hk" } });
    const result = await moneyMarketsHeadless.load(args, createTestHeadlessContext({ apiClient: {
      getCloudHongKongMoneyMarkets: async () => hongKong(),
      getCloudMoneyMarkets: async () => { asked++; return payload(); } } as never }));
    expect(asked).toBe(0);
    expect(typeof moneyMarketsHeadless.describe === "function" && moneyMarketsHeadless.describe(args)).toBe("Hong Kong money markets");
    expect(result.freshness).toMatchObject({ source: "HKMA", status: "not-a-feed" });
    const section = (result as { sections: Array<{ title: string; rows: Array<Record<string, unknown>> }> }).sections[0]!;
    expect(section.title).toBe("HIBOR fixings");
    expect(section.rows.map((entry) => [entry.label, entry.value, entry.asOf])).toEqual([
      ["HIBOR O/N", 2.77464, "2026-10-30"], ["HIBOR 1M", 2.56113, "2026-11-06"], ["HIBOR 3M", 3.21256, "2026-10-30"]]);
  });

  test("a row that is not a HIBOR fixing, or a US row among them, refuses the payload; an older server says it is not available yet", async () => {
    expect(validateHongKongMoneyMarkets(hongKong()).rows).toHaveLength(3);
    expect(() => validateHongKongMoneyMarkets({ ...hongKong(), rows: [row()] })).toThrow("invalid money-market observations");
    expect(() => validateMoneyMarkets({ ...payload(), rows: [hibor("1M", 2.5, "2026-11-06")] })).toThrow("invalid money-market observations");
    const { fetchHongKongMoneyMarkets } = await import("./client");
    await expect(fetchHongKongMoneyMarkets({ getCloudHongKongMoneyMarkets: async () => { throw new ApiRequestError("not found", 404); } }))
      .rejects.toThrow("Hong Kong money markets are not available yet.");
  });
});
