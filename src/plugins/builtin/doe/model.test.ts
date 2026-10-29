import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import type { DoeBoardPayload, DoeSeriesRow } from "../../../api-client/doe";
import { ApiRequestError } from "../../../api-client/errors";
import type { HeadlessBundleResult, HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/headless";
import { DOE_NOT_AVAILABLE, fetchDoeBoard } from "./client";
import { doeHeadless } from "./headless";
import {
  doeComparisonBasis, doeHeaderLine, doeSeasonalSeries, doeSeriesOption, formatDoeChange, formatDoeVsFive, formatDoeVsYear,
} from "./model";

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

/**
 * Mountain gas storage for the week ending 2026-10-16, compared on the EIA's
 * published figures from wngsr.json: -8.9% on the year, +4.5% on 246 Bcf.
 */
function mountain(overrides: Partial<DoeSeriesRow> = {}): DoeSeriesRow {
  return {
    id: "gas-mountain", key: "NW2_EPG0_SWO_R33_BCF", report: "gas", tab: "gas", label: "Mountain", unit: "bcf",
    weekEnding: "2026-10-16", value: 257, previousWeekEnding: "2026-10-09", weekChange: 2,
    yearAgo: { weekEnding: "2025-10-16", value: 282, change: -25, changePercent: -8.9 },
    fiveYear: { years: [2021, 2022, 2023, 2024, 2025], min: 196, max: 290, average: 246,
      averageChange: 3, vsAverage: 11, vsAveragePercent: 4.5, position: 65 },
    read: "Build of 2 Bcf, smaller than the 5-year average build of 3 Bcf for this week. Storage 4.5% above the 5-year average.",
    seasonal: null, basis: "published",
    ...overrides,
  };
}

const gasReport = {
  id: "gas" as const, weekEnding: "2026-10-16", releasedAt: "2026-10-22T14:30:00.000Z", releaseHoliday: null,
  nextWeekEnding: "2026-10-23", nextReleaseAt: "2026-10-29T14:30:00.000Z", nextReleaseHoliday: null,
};

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

  test("the comparison basis and the next release's consensus are read when sent, and an older server without them still loads", async () => {
    const withExpected = board({ reports: [{ ...gasReport, nextConsensus: 80, nextPrior: 77 }], series: [mountain()] });
    const loaded = await fetchDoeBoard({ getCloudDoeBoard: async () => withExpected });
    expect(loaded.series[0]!.basis).toBe("published");
    expect(loaded.reports[0]).toMatchObject({ nextConsensus: 80, nextPrior: 77 });
    expect((await fetchDoeBoard({ getCloudDoeBoard: async () => board() })).series[0]!.basis).toBeUndefined();
    for (const broken of [
      board({ series: [mountain({ basis: "estimated" as never })] }),
      board({ reports: [{ ...gasReport, nextConsensus: Number.NaN }], series: [mountain()] }),
      board({ reports: [{ ...gasReport, nextPrior: "77" as never }], series: [mountain()] }),
    ]) {
      await expect(fetchDoeBoard({ getCloudDoeBoard: async () => broken })).rejects.toThrow("invalid EIA weekly board");
    }
  });
});

describe("DOE report dates", () => {
  afterEach(() => { (apiClient.getCloudDoeBoard as unknown as { mockRestore?: () => void }).mockRestore?.(); });

  const load = async (tab: string, argument = "") => {
    const args = { symbols: [], argument: argument ? [argument] : [], rawArgument: argument, options: { tab } } as unknown as HeadlessPaneLoadArgs;
    return await doeHeadless("all").load(args, {} as HeadlessPaneContext) as HeadlessBundleResult;
  };

  test("the footer names what Vs 1Y and Vs 5Y avg are measured against, and the next storage line its consensus and prior", async () => {
    const petroleum = { ...board().reports[0]!, weekEnding: "2026-10-16", releasedAt: "2026-10-21T14:30:00.000Z", nextReleaseAt: "2026-10-28T14:30:00.000Z" };
    spyOn(apiClient, "getCloudDoeBoard").mockResolvedValue(board({
      reports: [petroleum, { ...gasReport, nextConsensus: 80, nextPrior: 77 }],
      series: [crude({ basis: "computed" }), mountain()],
    }));
    // Before the next release, which the line calls due once its time has passed.
    setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const gas = await load("gas").finally(() => setSystemTime());
    expect(gas.freshness?.basis).toBe("weekly release; year-ago and 5-year average as EIA published");
    expect(gas.sections[0]!.title).toBe("Gas Storage: Week ending Oct 16 · released Thu Oct 22 10:30 ET · next Thu Oct 29 10:30 ET, consensus +80 Bcf, prior +77 Bcf");
    expect(gas.sections[0]!.rows?.[0]).toMatchObject({ vsYearAgo: "-8.9%", vsFiveYear: "+4.5%" });
    expect((await load("crude")).freshness?.basis).toBe("weekly release; year-ago and 5-year average from EIA weekly history");
    expect((await load("all")).freshness?.basis)
      .toBe("weekly release; gas storage year-ago and 5-year average as EIA published, crude from EIA weekly history");
    expect((await load("all", "mountain")).freshness?.basis).toBe("weekly release; year-ago and 5-year average as EIA published");
  });

  test("each tab is dated by its own release: Wednesday's petroleum for crude, Thursday's storage for gas", async () => {
    const gas = { id: "gas" as const, weekEnding: "2026-10-02", releasedAt: "2026-10-08T14:30:00.000Z", releaseHoliday: null,
      nextWeekEnding: "2026-10-09", nextReleaseAt: "2026-10-15T14:30:00.000Z", nextReleaseHoliday: null };
    const petroleum = { ...board().reports[0]!, weekEnding: "2026-10-02", releasedAt: "2026-10-07T14:30:00.000Z", nextReleaseAt: "2026-10-14T14:30:00.000Z" };
    spyOn(apiClient, "getCloudDoeBoard").mockResolvedValue(board({ reports: [petroleum, gas] }));
    const dated = async (tab: string, argument = "") => {
      const args = { symbols: [], argument: argument ? [argument] : [], rawArgument: argument, options: { tab } } as unknown as HeadlessPaneLoadArgs;
      const { freshness } = await doeHeadless("all").load(args, {} as HeadlessPaneContext) as HeadlessBundleResult;
      return [freshness?.asOf, freshness?.releasedOn, freshness?.nextExpectedAt];
    };
    // Each is the week the report covers and when it was released.
    expect(await dated("crude")).toEqual(["2026-10-02", petroleum.releasedAt, petroleum.nextReleaseAt]);
    expect(await dated("gas")).toEqual(["2026-10-02", gas.releasedAt, gas.nextReleaseAt]);
    // A series is dated by its tab's release; all three tabs by the newest, due by the soonest.
    expect(await dated("all", "crude-commercial")).toEqual(["2026-10-02", petroleum.releasedAt, petroleum.nextReleaseAt]);
    expect(await dated("all")).toEqual(["2026-10-02", gas.releasedAt, petroleum.nextReleaseAt]);
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

  test("the next storage release carries the calendar's consensus and prior as the 1W change reads them, each only when known", () => {
    const now = Date.parse("2026-10-23T08:00:00Z");
    const line = (nextConsensus: number | null, nextPrior: number | null) => doeHeaderLine({ ...gasReport, nextConsensus, nextPrior }, now);
    expect(line(80, 77)).toBe("Week ending Oct 16 · released Thu Oct 22 10:30 ET · next Thu Oct 29 10:30 ET, consensus +80 Bcf, prior +77 Bcf");
    expect(line(-12, null)).toBe("Week ending Oct 16 · released Thu Oct 22 10:30 ET · next Thu Oct 29 10:30 ET, consensus -12 Bcf");
    expect(line(null, null)).toBe("Week ending Oct 16 · released Thu Oct 22 10:30 ET · next Thu Oct 29 10:30 ET");
    // Petroleum has no storage consensus, and an older server sends none.
    expect(doeHeaderLine({ ...board().reports[0]!, nextConsensus: 80 }, now)).not.toContain("consensus");
    expect(doeHeaderLine(gasReport, now)).toBe("Week ending Oct 16 · released Thu Oct 22 10:30 ET · next Thu Oct 29 10:30 ET");
    // A narrow pane drops when the week came out before the next release or its consensus.
    const full = line(80, 77)!;
    expect(doeHeaderLine({ ...gasReport, nextConsensus: 80, nextPrior: 77 }, now, full.length)).toBe(full);
    expect(doeHeaderLine({ ...gasReport, nextConsensus: 80, nextPrior: 77 }, now, full.length - 1))
      .toBe("Week ending Oct 16 · next Thu Oct 29 10:30 ET, consensus +80 Bcf, prior +77 Bcf");
  });

  test("the comparison basis is named only when the server says it, and per tab where the rows mix", () => {
    expect(doeComparisonBasis([mountain()])).toBe("year-ago and 5-year average as EIA published");
    expect(doeComparisonBasis([crude({ basis: "computed" })])).toBe("year-ago and 5-year average from EIA weekly history");
    expect(doeComparisonBasis([crude()])).toBeNull();
    // A row with nothing to compare does not count either way.
    expect(doeComparisonBasis([mountain(), crude({ basis: "computed", yearAgo: null, fiveYear: null })]))
      .toBe("year-ago and 5-year average as EIA published");
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
