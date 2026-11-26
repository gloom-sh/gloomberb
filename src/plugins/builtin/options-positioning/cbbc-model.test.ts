import { describe, expect, test } from "bun:test";
import { hkCbbcUnderlying, type HkCbbcSummary, type HkCbbcZoneBucket } from "../../../api-client/hk-cbbc";
import {
  buildCbbcChartModel,
  cbbcContractColumns,
  cbbcOverviewColumns,
  cbbcZoneColumns,
  fmtCbbcEquiv,
  fmtCbbcLevel,
  fmtDistPct,
  fmtHkd,
} from "./cbbc-model";

const summary: HkCbbcSummary = {
  atDate: "2026-11-25",
  underlyingCode: "HSI",
  displaySymbol: "HSI",
  underlyingName: "Hang Seng Index",
  isIndex: true,
  spotLevel: 25_700,
  contractsCount: 2690,
  bullContracts: 1400,
  bearContracts: 1290,
  bullEquivUnits: 380_000,
  bearEquivUnits: 290_000,
  bullEquivFutures: 7600,
  bearEquivFutures: 5800,
  bullRatioPct: 56.7,
  heavyBullCallLow: 25_200,
  heavyBullCallHigh: 25_300,
  heavyBullEquiv: 1450,
  heavyBearCallLow: 26_100,
  heavyBearCallHigh: 26_200,
  heavyBearEquiv: 1120,
  totalTurnoverHkd: 4_500_000_000,
  mceCount: 18,
};

const bullZone: HkCbbcZoneBucket = {
  zoneLow: 25_200,
  zoneHigh: 25_300,
  label: "25,200-25,299",
  direction: "bull",
  contractsCount: 42,
  streetUnits: 725_000_000,
  equivUnits: 72_500,
  equivFutures: 1450,
  distancePct: -1.75,
  turnoverHkd: 410_000_000,
  topIssuer: "UBS",
  isHeavyZone: true,
};

const bearZone: HkCbbcZoneBucket = {
  zoneLow: 26_100,
  zoneHigh: 26_200,
  label: "26,100-26,199",
  direction: "bear",
  contractsCount: 38,
  streetUnits: 560_000_000,
  equivUnits: 56_000,
  equivFutures: 1120,
  distancePct: 1.75,
  turnoverHkd: 325_000_000,
  topIssuer: "J.P. Morgan",
  isHeavyZone: true,
};

describe("HKEX CBBC positioning model", () => {
  test("normalizes HK index and stock underlying tickers", () => {
    expect(hkCbbcUnderlying("HSI")).toBe("HSI");
    expect(hkCbbcUnderlying("^HSI")).toBe("HSI");
    expect(hkCbbcUnderlying("HSTECH")).toBe("HSTEC");
    expect(hkCbbcUnderlying("0700.HK")).toBe("00700");
    expect(hkCbbcUnderlying("9988:HKEX")).toBe("09988");
    expect(hkCbbcUnderlying("AAPL")).toBeNull();
    expect(hkCbbcUnderlying("SPY")).toBeNull();
  });

  test("builds mirrored Bull/Bear chart series with spot marker ratio", () => {
    const chart = buildCbbcChartModel(summary, [bullZone], [bearZone], {
      bull: "positive",
      bear: "negative",
    });
    expect(chart.series).toHaveLength(1);
    expect(chart.orderedZones).toHaveLength(2);
    expect(chart.spotRatio).toBe(0.5);
    expect(chart.series[0]!.points[0]!.value).toBe(1450);
    expect(chart.series[0]!.points[1]!.value).toBe(-1120);
  });

  test("formats levels, equivalent futures/shares, turnover, and responsive columns", () => {
    expect(fmtCbbcLevel(25_700, true)).toBe("25,700");
    expect(fmtCbbcEquiv(1450, true)).toBe("1,450 fut");
    expect(fmtCbbcEquiv(937_660, false)).toBe("937.7K sh");
    expect(fmtHkd(4_500_000_000)).toBe("HK$4.50B");
    expect(fmtDistPct(-1.75)).toBe("-1.8%");
    expect(cbbcZoneColumns(105).length).toBe(8);
    expect(cbbcContractColumns(90).length).toBe(8);
    expect(cbbcOverviewColumns(100).length).toBe(7);
  });
});
