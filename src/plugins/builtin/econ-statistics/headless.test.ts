import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HeadlessPaneContext, HeadlessPaneLoadArgs } from "../../../types/plugin";
import { statsCache } from "./cache";
import { loadStatsBundle } from "./client";
import { econStatisticsHeadless, projectStatsHeadlessBundle } from "./headless";
import { resolveStatArg } from "./stats";
import { projectStat } from "./view";
import { createTestHeadlessContext } from "../../../test-support/headless";
import { deriveHeadlessFreshness, formatFreshnessLine } from "../../../cli/pane-functions/freshness";
import { headlessReportTables, renderHeadlessPaneText } from "../../../cli/pane-functions/headless";
import { renderReportCsv, renderReportNdjson } from "../../../cli/report-tables";

beforeEach(() => statsCache.reset());
afterEach(() => statsCache.reset());

function monthlyCpi() {
  return Array.from({ length: 25 }, (_, index) => {
    const year = 2024 + Math.floor(index / 12);
    const month = (index % 12) + 1;
    return {
      date: `${year}-${String(month).padStart(2, "0")}-01`,
      value: 300 + index,
    };
  });
}

const args: HeadlessPaneLoadArgs = {
  rawArgument: "cpi",
  argument: "cpi",
  symbols: [],
  options: { range: "5Y" },
};

describe("economic statistics headless model", () => {
  test("loads through the injected cloud client and produces category sections", async () => {
    const requested: string[] = [];
    const apiClient = {
      getCloudFredSeries: async (seriesId: string) => {
        requested.push(seriesId);
        return { seriesId, observations: monthlyCpi() };
      },
    } as unknown as HeadlessPaneContext["apiClient"];
    const result = await econStatisticsHeadless.load(args, createTestHeadlessContext({ apiClient }));

    expect(requested).toEqual(["CPIAUCNS"]);
    expect(result.sections.map(({ title }) => title)).toEqual(["Inflation", "CPI"]);
    expect(result.sections[0]).toMatchObject({
      rows: [{ id: "cpi-yoy", indicator: "CPI y/y" }],
    });
    expect(result.metadata).toMatchObject({ range: "5Y", selected: "cpi-yoy" });
  });

  test("dates each reading by its period, keeps the raw date in the rows, and explains %ile once", async () => {
    const apiClient = {
      getCloudFredSeries: async () => ({ observations: monthlyCpi() }),
    } as unknown as HeadlessPaneContext["apiClient"];
    const result = await econStatisticsHeadless.load(args, createTestHeadlessContext({ apiClient }));
    const [table, detail] = result.sections as Array<{ columns?: Array<{ key: string; header: string; format?: (value: unknown, row: Record<string, unknown>) => string }>; rows?: Array<Record<string, unknown>>; entries?: Array<{ label: string; value: unknown; formatted?: string }> }>;
    const row = table!.rows![0]!;
    // Monthly data runs to Jan 2026 here: 2026-01-01 is January, not the first of the month.
    expect(row).toMatchObject({ asOf: "2026-01-01", reading: "Jan 2026" });
    const period = table!.columns!.find((column) => column.key === "asOf")!;
    expect(period.format!(row.asOf, row)).toBe("Jan 2026");
    expect(detail!.entries!.find((entry) => entry.label === "Period")).toMatchObject({ value: "2026-01-01", formatted: "Jan 2026" });
    expect(result.notes).toEqual(["%ile is the share of past readings at or below the latest one, over the last 5 years. Full history: --range ALL."]);
    const all = await econStatisticsHeadless.load({ ...args, options: { range: "ALL" } }, createTestHeadlessContext({ apiClient }));
    // On the full history there is nothing further back to point to.
    expect(all.notes).toEqual(["%ile is the share of past readings at or below the latest one, over the full history."]);
  });

  test("a reading says when it was released, and the report is as of that release", async () => {
    const permits = resolveStatArg("building-permits")!;
    const observations = ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"].map((date, index) => ({
      date, value: 1400 + index, ...(date === "2026-09-01" ? { releasedOn: "2026-10-20" } : {}),
    }));
    const bundle = await loadStatsBundle({ loader: async () => observations, stats: [permits] });
    const report = projectStatsHeadlessBundle(bundle, "ALL", permits.id);
    const [table, detail] = report.sections as Array<{ columns?: Array<{ key: string; header: string; format?: (value: unknown, row: Record<string, unknown>) => string }>; rows?: Array<Record<string, unknown>>; entries?: Array<{ label: string; value: unknown; formatted?: string }> }>;
    const row = table!.rows![0]!;
    // The row keeps the period it covers and says when it was published.
    expect(row).toMatchObject({ asOf: "2026-09-01", releasedOn: "2026-10-20", periodicity: "monthly", reading: "Sep 2026" });
    expect(table!.columns!.find((column) => column.key === "releasedOn")!.format!(row.releasedOn, row)).toBe("Tue 20 Oct");
    expect(detail!.entries!.find((entry) => entry.label === "Period")).toMatchObject({ value: "2026-09-01", formatted: "Sep 2026, released Tue 20 Oct" });
    const freshness = deriveHeadlessFreshness(econStatisticsHeadless, report, Date.parse("2026-10-23T15:00:00Z"));
    expect(freshness).toMatchObject({ asOf: "2026-10-20", referencePeriod: "2026-09-01" });
    expect(formatFreshnessLine(freshness)).toBe("Source: FRED · Sep 2026, released Tue 20 Oct · not a live feed (published statistics)");
    // Before Gloom Cloud sends the release, the report names the period, never its first day.
    const unreleased = projectStatsHeadlessBundle(
      await loadStatsBundle({ loader: async () => observations.map(({ date, value }) => ({ date, value })), stats: [permits] }), "ALL", permits.id);
    expect(formatFreshnessLine(deriveHeadlessFreshness(econStatisticsHeadless, unreleased, Date.parse("2026-10-23T15:00:00Z"))))
      .toBe("Source: FRED · Sep 2026 (monthly) · not a live feed (published statistics)");
  });

  test("prints a spread in basis points while its values stay in percentage points", async () => {
    const days = (value: number) => ["2026-09-18", "2026-09-21"].map((date, index) => ({ date, value: value + index * 0.03 }));
    const spread = resolveStatArg("curve-spread")!;
    const bundle = await loadStatsBundle({ loader: async () => days(0.2), stats: [spread] });
    const [table, detail] = projectStatsHeadlessBundle(bundle, "ALL", spread.id).sections as Array<{
      rows?: Array<Record<string, unknown>>; entries?: Array<{ label: string; value: unknown; formatted?: string }>;
    }>;
    expect(table!.rows![0]).toMatchObject({
      latest: 0.23, formattedLatest: "+23bp", latestBasisPoints: 23,
      previous: 0.2, formattedPrevious: "+20bp", previousBasisPoints: 20,
    });
    expect(detail!.entries!.find((entry) => entry.label === "Latest")).toMatchObject({ value: 0.23, formatted: "+23bp" });
    // An inverted curve keeps its sign.
    const inverted = await loadStatsBundle({ loader: async () => days(-0.31), stats: [spread] });
    expect((projectStatsHeadlessBundle(inverted, "ALL", spread.id).sections[0] as { rows: Array<Record<string, unknown>> }).rows[0])
      .toMatchObject({ formattedLatest: "-28bp" });
  });
});

test("an export says which period Previous is, dates each row by its release, and ends with period, released and retrieved", async () => {
  const permits = resolveStatArg("building-permits")!;
  const tenYear = resolveStatArg("ten-year")!;
  const months = ["2026-07-01", "2026-08-01", "2026-09-01"].map((date, index) => ({
    date, value: 1400 + index, ...(date === "2026-09-01" ? { releasedOn: "2026-10-20" } : {}),
  }));
  const days = ["2026-10-21", "2026-10-22", "2026-10-23"].map((date, index) => ({ date, value: 4.9 + index * 0.05 }));
  const bundle = await loadStatsBundle({
    stats: [permits, tenYear],
    loader: async (def) => def.id === permits.id ? months : days,
  });
  const report = projectStatsHeadlessBundle(bundle, "ALL", permits.id);
  const args = { rawArgument: "", argument: null, symbols: [], options: { range: "ALL" } } as HeadlessPaneLoadArgs;
  const freshness = deriveHeadlessFreshness(econStatisticsHeadless, report, Date.parse("2026-10-25T10:00:00Z"));
  const tables = headlessReportTables(econStatisticsHeadless, report, args, "Economic Statistics", freshness, { complete: true, unavailableSymbols: [] });
  const retrieved = freshness.retrievedAt;
  const csv = renderReportCsv(tables, freshness).split("\n");
  const fixed = "symbol_or_series,currency_or_unit,interval,source,as_of,period,released,retrieved";
  const housing = csv.indexOf("# section: Housing");
  const rates = csv.indexOf("# section: Rates & Money");
  // Previous names its period beside it; the table's own period and released stand in for the fixed columns of those names.
  expect(csv[housing + 1]).toBe("Indicator,Latest,Previous,Previous period,%ile,period,released,status,symbol_or_series,currency_or_unit,interval,source,as_of,retrieved");
  // The release is the row's as-of, never September's first day.
  expect(csv[housing + 2]).toBe(`Permits,1402000,1401000,2026-08-01,100,2026-09-01,2026-10-20,,,,,FRED,2026-10-20,${retrieved}`);
  // A daily yield has no release to state: it is as of its own day, and its release stays empty.
  expect(csv[rates + 2]).toBe(`10Y yield,5,4.95,2026-10-22,100,2026-10-23,,,,,,FRED,2026-10-23,${retrieved}`);
  // The selected statistic's lines are dated the same way.
  const permitsLines = csv.slice(csv.indexOf("# section: Building Permits") + 1);
  expect(permitsLines[0]).toBe(`Metric,Value,${fixed}`);
  expect(permitsLines.find((line) => line.startsWith("Previous period,"))).toBe(`Previous period,2026-08-01,,,,FRED,2026-10-20,2026-09-01,2026-10-20,${retrieved}`);
  expect(permitsLines.find((line) => line.startsWith("Latest,"))).toMatch(/^Latest,1402000,,,,FRED,2026-10-20,2026-09-01,2026-10-20,/);
  // A month whose release the server does not say yet is as of nothing, never the first day of the month.
  const unreleased = projectStatsHeadlessBundle(
    await loadStatsBundle({ loader: async () => months.map(({ date, value }) => ({ date, value })), stats: [permits] }), "ALL", permits.id);
  const unreleasedFreshness = deriveHeadlessFreshness(econStatisticsHeadless, unreleased, Date.parse("2026-10-25T10:00:00Z"));
  const unreleasedCsv = renderReportCsv(headlessReportTables(econStatisticsHeadless, unreleased, args, "Economic Statistics", unreleasedFreshness, { complete: true, unavailableSymbols: [] }), unreleasedFreshness).split("\n");
  expect(unreleasedCsv.find((line) => line.startsWith("Permits,"))).toBe(`Permits,1402000,1401000,2026-08-01,100,2026-09-01,,,,,,FRED,,${unreleasedFreshness.retrievedAt}`);
  expect(unreleasedCsv.find((line) => line.startsWith("Latest,"))).toMatch(/^Latest,1402000,,,,FRED,,2026-09-01,,/);
  // NDJSON rows say the same.
  const [first] = renderReportNdjson(tables, freshness).split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(first).toMatchObject({ section: "Housing", Indicator: "Permits", "Previous period": "2026-08-01", period: "2026-09-01", released: "2026-10-20", as_of: "2026-10-20", retrieved });
  // The text report keeps its table, and its detail says the period Previous is of.
  const text = renderHeadlessPaneText(econStatisticsHeadless, report, args, "Economic Statistics", freshness);
  expect(text).toMatch(/Indicator\s+Latest\s+Previous\s+%ile\s+Period\s+Released/);
  expect(text).not.toContain("Previous period");
  expect(text).toMatch(/Previous\s+1\.40M \(Aug 2026\)/);
});

test("nowcasts retain published rates and signed indexes, ranked against their own history", async () => {
  const cases = [
    { id: "gdpnow", dates: ["2025-10-01", "2026-01-01", "2026-04-01"], values: [-1, 4, 2], formatted: "2.0%", reading: "Q2 2026", staleOn: "2026-08-15" },
    { id: "nfci", dates: ["2026-06-05", "2026-06-12", "2026-06-19"], values: [-0.7, 0.4, -0.2], formatted: "-0.20", reading: "week ending 2026-06-19", staleOn: "2026-07-11" },
    { id: "financial-stress", dates: ["2026-06-05", "2026-06-12", "2026-06-19"], values: [-1.5, 1, -0.5], formatted: "-0.50", reading: "week ending 2026-06-19", staleOn: "2026-07-11" },
    { id: "median-cpi", dates: ["2026-04-01", "2026-05-01", "2026-06-01"], values: [3, 6, 4], formatted: "4.0%", reading: "Jun 2026", staleOn: "2026-08-31" },
  ];
  const bundle = await loadStatsBundle({
    stats: cases.map(({ id }) => resolveStatArg(id)!),
    loader: async (def) => {
      const item = cases.find(({ id }) => id === def.id)!;
      return item.dates.map((date, index) => ({ date, value: item.values[index]! }));
    },
  });
  const report = projectStatsHeadlessBundle(bundle, "ALL", "gdpnow");
  const table = report.sections[0]!;
  expect(table.title).toBe("Nowcasts & conditions");
  for (const item of cases) {
    const build = bundle.builds.find(({ stat }) => stat.id === item.id)!;
    const view = projectStat(build, "ALL", { nowMs: Date.parse(item.dates[2]!) + 20 * 86_400_000 });
    // The negative readings and annualized rates must not be treated as index
    // levels for a second percentage-change transform or pooled across series.
    expect(view.latest.value).toBe(item.values[2]!);
    expect(view.percentile).toBeCloseTo(200 / 3);
    expect(view.observationStale).toBe(false);
    expect(projectStat(build, "ALL", { nowMs: Date.parse(item.staleOn) }).observationStale).toBe(true);
    expect(table.rows!.find((row) => row.id === item.id)).toMatchObject({
      latest: item.values[2], formattedLatest: item.formatted, reading: item.reading,
    });
  }
});
