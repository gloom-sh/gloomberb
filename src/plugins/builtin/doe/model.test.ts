import { describe, expect, test } from "bun:test";
import type { DoeBoardPayload, DoeSeriesRow } from "../../../api-client/doe";
import { ApiRequestError } from "../../../api-client/errors";
import { DOE_NOT_AVAILABLE, fetchDoeBoard } from "./client";
import { doeHeaderLine, doeSeasonalSeries, doeSeriesOption, formatDoeChange, formatDoeVsFive, formatDoeVsYear } from "./model";

/** Commercial crude as the board served it for the week ending 2026-09-25. */
function crude(overrides: Partial<DoeSeriesRow> = {}): DoeSeriesRow {
  return {
    id: "crude-commercial", key: "WCESTUS1", report: "petroleum", tab: "crude", label: "Commercial crude", unit: "kb",
    weekEnding: "2026-09-25", value: 427_320, previousWeekEnding: "2026-09-18", weekChange: 922,
    yearAgo: { weekEnding: "2025-09-26", value: 416_546, change: 10_774, changePercent: 2.59 },
    fiveYear: { years: [2021, 2022, 2023, 2024, 2025], min: 415_333.86, max: 430_171.57, average: 419_298.46,
      averageChange: 895.03, vsAverage: 8_021.54, vsAveragePercent: 1.91, position: 80.78 },
    read: "Build of 922k bbl, in line with the 5-year average build of 895k bbl for this week.",
    seasonal: { year: 2026, weeks: 52, current: [[38, 426_398], [39, 427_320]], previous: [[39, 416_546]],
      band: [[38, 414_000, 418_400, 429_000], [39, 415_333.86, 419_298.46, 430_171.57], [40, null, null, null]] },
    ...overrides,
  };
}

function board(overrides: Partial<DoeBoardPayload> = {}): DoeBoardPayload {
  return {
    source: "EIA", generatedAt: "2026-10-03T08:00:00.000Z", status: "available", gaps: [],
    reports: [{ id: "petroleum", weekEnding: "2026-09-25", releasedAt: "2026-09-30T14:30:00.000Z", releaseHoliday: null,
      nextWeekEnding: "2026-10-02", nextReleaseAt: "2026-10-07T14:30:00.000Z", nextReleaseHoliday: null }],
    series: [crude()],
    ...overrides,
  };
}

describe("DOE board boundary", () => {
  test("a server without the route, or without its weeks, is not available yet rather than an error", async () => {
    for (const status of [404, 503]) {
      const client = { getCloudDoeBoard: async () => { throw new ApiRequestError("Not Found", status); } };
      await expect(fetchDoeBoard(client)).rejects.toThrow(DOE_NOT_AVAILABLE);
    }
    const empty = board({ status: "unavailable", series: [crude({ weekEnding: null, value: null, weekChange: null, yearAgo: null, fiveYear: null, read: null, seasonal: null })] });
    await expect(fetchDoeBoard({ getCloudDoeBoard: async () => empty })).rejects.toThrow(DOE_NOT_AVAILABLE);
    const outage = { getCloudDoeBoard: async () => { throw new ApiRequestError("Bad gateway", 502); } };
    await expect(fetchDoeBoard(outage)).rejects.toThrow("Bad gateway");
  });

  test("a board that breaks the contract is refused whole", async () => {
    expect((await fetchDoeBoard({ getCloudDoeBoard: async () => board() })).series).toHaveLength(1);
    for (const broken of [
      crude({ weekEnding: "2026-02-30" }),
      crude({ value: Number.NaN }),
      crude({ fiveYear: { ...crude().fiveYear!, min: 440_000 } }),
      crude({ seasonal: { ...crude().seasonal!, weeks: 54 } }),
    ]) {
      await expect(fetchDoeBoard({ getCloudDoeBoard: async () => board({ series: [broken] }) })).rejects.toThrow("invalid EIA weekly board");
    }
  });
});

describe("DOE figures", () => {
  test("stocks read in millions of barrels; a rate compares in points; nothing reads -0", () => {
    expect(formatDoeChange("kb", 922)).toBe("+0.9");
    expect(formatDoeChange("kb", -40)).toBe("0.0");
    expect(formatDoeChange("kbd", -554)).toBe("-554");
    expect(formatDoeVsYear(crude())).toBe("+2.6%");
    expect(formatDoeVsFive(crude())).toBe("+1.9%");
    const utilization = crude({ unit: "pct", value: 92.5, yearAgo: { weekEnding: "2025-09-26", value: 91.4, change: 1.1, changePercent: 1.2 },
      fiveYear: { ...crude().fiveYear!, vsAverage: 2.93 } });
    expect(formatDoeVsYear(utilization)).toBe("+1.1pt");
    expect(formatDoeVsFive(utilization)).toBe("+2.9pt");
  });

  test("the header names the week, the release and the next one on the EIA's clock, holidays included", () => {
    const report = board().reports[0]!;
    expect(doeHeaderLine(report, Date.parse("2026-10-03T08:00:00Z")))
      .toBe("Week ending Sep 25 · released Wed Sep 30 10:30 ET · next Wed Oct 7 10:30 ET");
    // Past its time and not in yet: due, not next. Standard time from November.
    expect(doeHeaderLine({ ...report, nextReleaseAt: "2026-12-29T22:00:00.000Z", nextReleaseHoliday: "Christmas" }, Date.parse("2026-12-30T00:00:00Z")))
      .toBe("Week ending Sep 25 · released Wed Sep 30 10:30 ET · due Tue Dec 29 17:00 ET (Christmas)");
    expect(doeHeaderLine({ ...report, weekEnding: null })).toBeUndefined();
  });

  test("a typed series opens by id, label or region name", () => {
    expect(doeSeriesOption("cushing")?.value).toBe("cushing");
    expect(doeSeriesOption("South Central")).toMatchObject({ value: "gas-south-central", tab: "gas" });
    expect(doeSeriesOption("east")?.value).toBe("gas-east");
    expect(doeSeriesOption("crude-commercial")?.tab).toBe("crude");
    expect(doeSeriesOption("brent")).toBeNull();
  });

  test("the seasonal chart leads with the row's year and bands the range in the row's units", () => {
    const series = doeSeasonalSeries(crude(), { bg: "#000000", positive: "#00ff00", warning: "#ffaa00", textDim: "#888888" });
    expect(series.map((entry) => entry.label)).toEqual(["Commercial crude 2026", "2025", "5Y avg"]);
    const band = series[2]!;
    expect(band.style).toBe("band");
    // Week 40 has no band years yet: no point rather than a zero.
    expect(band.points).toHaveLength(2);
    const week39 = band.points[1]!;
    expect([week39.low, week39.value, week39.high].map((value) => value!.toFixed(3))).toEqual(["415.334", "419.298", "430.172"]);
    expect(series[0]!.points.at(-1)?.value).toBe(427.32);
  });
});
