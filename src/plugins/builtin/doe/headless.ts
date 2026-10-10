import type { DoeSeriesRow, DoeTab } from "../../../api-client/doe";
import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchDoeBoard } from "./client";
import {
  DOE_TABS,
  DOE_UNIT_LABEL,
  doeHeaderLine,
  doeReport,
  doeRows,
  doeSeriesOption,
  doeTab,
  formatDoeChange,
  formatDoeLevel,
  formatDoePosition,
  formatDoeVsFive,
  formatDoeVsYear,
} from "./model";
import { newestReportTime, oldestReportTime } from "../../../utils/utc-time";

const text = (value: unknown) => typeof value === "string" ? value : "--";

/** One row per series, in the pane's words and units; numbers keep their published precision. */
function reportRow(row: DoeSeriesRow) {
  return {
    id: row.id, series: row.label, unit: DOE_UNIT_LABEL[row.unit], weekEnding: row.weekEnding,
    level: formatDoeLevel(row.unit, row.value), weekChange: formatDoeChange(row.unit, row.weekChange),
    vsYearAgo: formatDoeVsYear(row), vsFiveYear: formatDoeVsFive(row),
    fiveYearLow: formatDoeLevel(row.unit, row.fiveYear?.min ?? null), fiveYearHigh: formatDoeLevel(row.unit, row.fiveYear?.max ?? null),
    position: formatDoePosition(row), read: row.read,
  };
}

const SUMMARY_COLUMNS = [
  { key: "series", header: "Series" }, { key: "unit", header: "Unit" },
  { key: "level", header: "Level", align: "right" as const }, { key: "weekChange", header: "1W change", align: "right" as const },
  { key: "vsYearAgo", header: "Vs 1Y", align: "right" as const }, { key: "vsFiveYear", header: "Vs 5Y avg", align: "right" as const },
  { key: "fiveYearLow", header: "5Y low", align: "right" as const }, { key: "fiveYearHigh", header: "5Y high", align: "right" as const },
  { key: "position", header: "In 5Y range", align: "right" as const }, { key: "read", header: "Read", format: text },
];

/** The selected series' year, week by week, against last year and the five-year band: the chart as a table. */
function seasonalRows(row: DoeSeriesRow) {
  const seasonal = row.seasonal;
  if (!seasonal) return [];
  const current = new Map(seasonal.current), previous = new Map(seasonal.previous);
  const level = (value: number | null | undefined) => formatDoeLevel(row.unit, value ?? null);
  return seasonal.band.map(([week, min, average, max]) => ({ week, thisYear: level(current.get(week)), lastYear: level(previous.get(week)),
    fiveYearLow: level(min), fiveYearAverage: level(average), fiveYearHigh: level(max) }));
}

/** `DOE` reads every tab unless one is named; `NGS` starts on gas storage; a series argument adds its year. */
export function doeHeadless(defaultTab: DoeTab | "all"): HeadlessPaneDefinition<"bundle"> {
  return {
    shape: "bundle",
    argument: { kind: "free-text", optional: true, placeholder: "series", description: "A series such as cushing, gasoline or east; omit for the tables." },
    options: [{ key: "tab", type: "enum", values: [{ value: "all" }, ...DOE_TABS.map(({ value }) => ({ value }))], defaultValue: defaultTab,
      description: "Crude, products, gas storage, or all three." }],
    discovery: { aliases: ["DOE", "NGS"], dataRequirements: ["Gloom Cloud EIA weekly history"],
      limitations: ["Weekly data, published Wednesday (petroleum) and Thursday (gas) at 10:30 ET, moved by holidays",
        "Five-year ranges read earlier years on the same calendar day", "A range holds fewer than five years where a series is younger"] },
    describe: "EIA weekly petroleum and natural gas storage",
    async load(args) {
      const data = await fetchDoeBoard();
      // EIA's weekly reports; once the next one is a day overdue the tables have missed it.
      const freshness = { source: "EIA", status: "not-a-feed" as const, basis: "weekly release",
        asOf: newestReportTime(data.reports.map((report) => report.releasedAt)),
        nextExpectedAt: oldestReportTime(data.reports.map((report) => report.nextReleaseAt)) };
      const argument = Array.isArray(args.argument) ? args.argument.join(" ") : args.argument;
      if (argument) {
        const option = doeSeriesOption(argument);
        const row = option ? data.series.find((entry) => entry.id === option.value) : null;
        if (!row) throw new Error("Use a series such as cushing, gasoline, distillate or east");
        return {
          sections: [
            { title: doeHeaderLine(doeReport(data, row.tab)) ?? row.label, columns: SUMMARY_COLUMNS, rows: [reportRow(row)] },
            { title: `${row.label} ${row.seasonal?.year ?? ""} by week, ${DOE_UNIT_LABEL[row.unit]}`.trim(),
              columns: [{ key: "week", header: "Week", align: "right" as const }, { key: "thisYear", header: "This year", align: "right" as const },
                { key: "lastYear", header: "Last year", align: "right" as const }, { key: "fiveYearLow", header: "5Y low", align: "right" as const },
                { key: "fiveYearAverage", header: "5Y avg", align: "right" as const }, { key: "fiveYearHigh", header: "5Y high", align: "right" as const }],
              rows: seasonalRows(row) },
          ],
          errors: data.gaps,
          freshness,
          metadata: { ...data, series: [row], complete: data.status === "available" },
        };
      }
      const tabs = args.options.tab === "all" || args.options.tab == null ? DOE_TABS.map(({ value }) => value) : [doeTab(args.options.tab)];
      return {
        sections: tabs.map((tab) => ({
          title: `${DOE_TABS.find((entry) => entry.value === tab)!.label}${doeHeaderLine(doeReport(data, tab)) ? `: ${doeHeaderLine(doeReport(data, tab))}` : ""}`,
          columns: SUMMARY_COLUMNS,
          rows: doeRows(data, tab).map(reportRow),
        })),
        errors: data.gaps,
        freshness,
        metadata: { ...data, complete: data.status === "available" },
      };
    },
  };
}
