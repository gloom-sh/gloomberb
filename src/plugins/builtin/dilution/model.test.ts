import { describe, expect, test } from "bun:test";
import type { DilutionMetrics } from "../../../api-client/dilution";
import { getTableWidth } from "../../../components/ui/table-layout";
import {
  buildCapacityBar,
  fmtPct,
  fmtShares,
  fmtUsd,
  form144Columns,
  offeringColumns,
  offeringTypeShort,
  riskTierLabel,
  shelfCapacitySummary,
  shelfColumns,
} from "./model";

const sampleMetrics: DilutionMetrics = {
  marketCapUsd: 60_000_000,
  activeShelfCount: 1,
  hasWksiShelf: false,
  registeredShelfUsd: 100_000_000,
  drawnLast12mUsd: 5_000_000,
  remainingShelfHeadroomUsd: 15_000_000,
  babyShelfRestricted: true,
  babyShelfCapUsd: 20_000_000,
  babyShelfRemainingUsd: 15_000_000,
  activeAtmCount: 1,
  atmCapacityUsd: 10_000_000,
  offerings12mCount: 1,
  offerings12mUsd: 5_000_000,
  form144Count90d: 2,
  form144Shares90d: 120_000,
  form144Value90dUsd: 2_400_000,
  nextLockupExpiryDate: "2027-01-15",
  nextLockupDays: 50,
  hkDepositCount90d: 0,
  hkDepositMaxPct: null,
  overhangPctOfMarketCap: 29.0,
  riskTier: "high",
  signals: ["Baby-shelf I.B.6 cap active"],
};

describe("dilution model", () => {
  test("formats USD, shares, percentages, risk tiers, and offering labels", () => {
    expect(fmtUsd(21_000_000_000)).toBe("$21.00B");
    expect(fmtUsd(15_500_000)).toBe("$15.5M");
    expect(fmtUsd(null)).toBe("—");
    expect(fmtShares(1_500_000)).toContain("1.5");
    expect(fmtPct(12.345)).toBe("12.35%");
    expect(offeringTypeShort("atm")).toBe("ATM");
    expect(offeringTypeShort("secondary")).toBe("Secondary");
    expect(riskTierLabel("high")).toBe("HIGH");
  });

  test("summarizes baby-shelf I.B.6 capacity and builds progress bar", () => {
    const summary = shelfCapacitySummary(sampleMetrics);
    expect(summary).toContain("I.B.6 1/3 cap");
    expect(summary).toContain("$20.0M");
    expect(summary).toContain("$15.0M");

    const bar = buildCapacityBar(sampleMetrics, 20);
    expect(bar).toContain("25% drawn");
  });

  test("adapts columns cleanly for narrow and wide widths", () => {
    expect(shelfColumns(60).length).toBe(5);
    expect(shelfColumns(100).length).toBe(6);
    expect(offeringColumns(60).length).toBe(5);
    expect(offeringColumns(95).length).toBe(6);
    expect(form144Columns(70, false).length).toBe(4);
    expect(form144Columns(110, true).length).toBe(7);
  });

  // A last column sized without the gaps between columns made each table wider than its pane at every
  // width, so the column a wide pane had room for was the one cut, or left out by the table's fit.
  test("the last text column takes exactly what the pane has left", () => {
    for (const width of [104, 128, 160, 220]) {
      for (const columns of [shelfColumns(width), offeringColumns(width), form144Columns(width, false), form144Columns(width, true)]) {
        expect(getTableWidth(columns)).toBe(width);
      }
    }
  });
});
