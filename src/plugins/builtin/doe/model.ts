import type { DoeBoardPayload, DoeReport, DoeReportStatus, DoeSeriesRow, DoeTab, DoeUnit } from "../../../api-client/doe";
import { spanAxisFormatter } from "../../../components/chart-table/axis";
import type { ChartStripSpec } from "../../../components/chart-table/header";
import { staticSeries } from "../../../components/chart/static/series";
import { blendHex } from "../../../theme/color-utils";
import type { ResolvedSeries } from "../../../time-series/types";

export const DOE_TABS: ReadonlyArray<{ value: DoeTab; label: string }> = [
  { value: "crude", label: "Crude" },
  { value: "products", label: "Products" },
  { value: "gas", label: "Gas Storage" },
];

/**
 * The series Gloom Cloud serves, by the ids its board uses, so `DOE cushing`
 * or `NGS east` can open on one before the board has loaded.
 */
export const DOE_SERIES_OPTIONS: ReadonlyArray<{ value: string; label: string; tab: DoeTab }> = [
  { value: "crude-commercial", label: "Commercial crude", tab: "crude" },
  { value: "cushing", label: "Cushing", tab: "crude" },
  { value: "spr", label: "SPR", tab: "crude" },
  { value: "gasoline", label: "Gasoline", tab: "products" },
  { value: "distillate", label: "Distillates", tab: "products" },
  { value: "jet", label: "Jet fuel", tab: "products" },
  { value: "propane", label: "Propane/propylene", tab: "products" },
  { value: "refinery-utilization", label: "Refinery utilization", tab: "products" },
  { value: "crude-input", label: "Crude input", tab: "products" },
  { value: "crude-imports", label: "Crude imports", tab: "products" },
  { value: "crude-exports", label: "Crude exports", tab: "products" },
  { value: "product-supplied", label: "Product supplied", tab: "products" },
  { value: "gas-lower-48", label: "Lower 48", tab: "gas" },
  { value: "gas-east", label: "East", tab: "gas" },
  { value: "gas-midwest", label: "Midwest", tab: "gas" },
  { value: "gas-mountain", label: "Mountain", tab: "gas" },
  { value: "gas-pacific", label: "Pacific", tab: "gas" },
  { value: "gas-south-central", label: "South Central", tab: "gas" },
  { value: "gas-salt", label: "Salt", tab: "gas" },
  { value: "gas-nonsalt", label: "Nonsalt", tab: "gas" },
];

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A typed series: its id, its label, or a gas region without the prefix ("east", "south central"). */
export function doeSeriesOption(input: string | undefined) {
  const typed = squash(input ?? "");
  if (!typed) return null;
  return DOE_SERIES_OPTIONS.find((option) => [option.value, option.label, option.value.replace(/^gas-/, "")]
    .some((name) => squash(name) === typed)) ?? null;
}

export function doeTab(value: unknown): DoeTab {
  return value === "products" || value === "gas" ? value : "crude";
}

const doeReportOf = (tab: DoeTab): DoeReport => tab === "gas" ? "gas" : "petroleum";

/** The unit a row reads in: stocks in millions of barrels, flows as published. */
export const DOE_UNIT_LABEL: Record<DoeUnit, string> = { kb: "M bbl", kbd: "kb/d", pct: "%", bcf: "Bcf" };

/** Thousand barrels read as millions; the other units as published. */
const doeDisplayValue = (unit: DoeUnit, value: number) => unit === "kb" ? value / 1_000 : value;

const DECIMALS: Record<DoeUnit, number> = { kb: 1, kbd: 0, pct: 1, bcf: 0 };

function grouped(value: number, decimals: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** A change that rounds to zero reads 0, never -0. */
function signed(value: number, decimals: number, suffix = ""): string {
  const text = grouped(Math.abs(value), decimals);
  const zero = Number(text.replace(/,/g, "")) === 0;
  return `${zero ? "" : value > 0 ? "+" : "-"}${text}${suffix}`;
}

export function formatDoeLevel(unit: DoeUnit, value: number | null): string {
  return value == null ? "--" : grouped(doeDisplayValue(unit, value), DECIMALS[unit]);
}

export function formatDoeChange(unit: DoeUnit, value: number | null): string {
  return value == null ? "--" : signed(doeDisplayValue(unit, value), DECIMALS[unit]);
}

/** Against a year ago: a percentage, or points for a rate already in percent. */
export function formatDoeVsYear(row: DoeSeriesRow): string {
  const ago = row.yearAgo;
  if (!ago) return "--";
  if (row.unit === "pct") return signed(ago.change, 1, "pt");
  return ago.changePercent == null ? "--" : signed(ago.changePercent, 1, "%");
}

/** Against the five-year average for the week, the same way. */
export function formatDoeVsFive(row: DoeSeriesRow): string {
  const five = row.fiveYear;
  if (!five) return "--";
  if (row.unit === "pct") return signed(five.vsAverage, 1, "pt");
  return five.vsAveragePercent == null ? "--" : signed(five.vsAveragePercent, 1, "%");
}

/** The figure a range bar stands for, for its export and its title. */
export function formatDoePosition(row: DoeSeriesRow): string {
  const position = row.fiveYear?.position;
  if (position == null) return "--";
  if (position < 0) return "below range";
  if (position > 100) return "above range";
  return `${Math.round(position)}%`;
}

export function doeRows(payload: DoeBoardPayload, tab: DoeTab): DoeSeriesRow[] {
  return payload.series.filter((row) => row.tab === tab);
}

export function doeReport(payload: DoeBoardPayload, tab: DoeTab): DoeReportStatus | null {
  return payload.reports.find((report) => report.id === doeReportOf(tab)) ?? null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 25" from a calendar date. */
function doeDay(date: string): string {
  const [, month, day] = date.split("-").map(Number) as [number, number, number];
  return `${MONTHS[month - 1]} ${day}`;
}

/** A release instant on the EIA's own clock: "Wed Sep 30 10:30 ET". */
function doeReleaseTime(iso: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.weekday} ${parts.month} ${parts.day} ${parts.hour}:${parts.minute} ET`;
}

/**
 * The tab's report on one line: the data week, when it came out and when the
 * next one is due, with the holiday that moved it.
 */
export function doeHeaderLine(report: DoeReportStatus | null, now = Date.now()): string | undefined {
  if (!report?.weekEnding) return undefined;
  const parts = [`Week ending ${doeDay(report.weekEnding)}`];
  if (report.releasedAt) parts.push(`released ${doeReleaseTime(report.releasedAt)}`);
  if (report.nextReleaseAt) {
    const due = Date.parse(report.nextReleaseAt) <= now ? "due" : "next";
    parts.push(`${due} ${doeReleaseTime(report.nextReleaseAt)}${report.nextReleaseHoliday ? ` (${report.nextReleaseHoliday})` : ""}`);
  }
  return parts.join(" · ");
}

const DAY_MS = 86_400_000;
/** The chart's x axis is the week of the year, placed on a fixed calendar so every year overlays. */
const WEEK_ONE = Date.UTC(2001, 0, 5);
export const doeWeekDate = (week: number) => new Date(WEEK_ONE + (week - 1) * 7 * DAY_MS);

export interface DoeChartColors {
  bg: string;
  positive: string;
  warning: string;
  textDim: string;
}

/**
 * This year's line, last year's, and the five-year average inside the shaded
 * five-year range, every point on its week of the year.
 */
export function doeSeasonalSeries(row: DoeSeriesRow, colors: DoeChartColors): ResolvedSeries[] {
  const seasonal = row.seasonal;
  if (!seasonal) return [];
  const value = (raw: number) => doeDisplayValue(row.unit, raw);
  const unitGroup = `doe-${row.unit}`;
  const line = (id: string, label: string, color: string, points: Array<[number, number]>): ResolvedSeries => ({
    ...staticSeries(points.map(([week, raw]) => {
      const date = doeWeekDate(week);
      return { date, observedAt: date, value: value(raw) };
    }), { id, label, color, calendarSpaced: true }),
    unit: DOE_UNIT_LABEL[row.unit], unitGroup,
  });
  const years = row.fiveYear?.years ?? [];
  const bandLabel = years.length && years.length < 5 ? `${years.length}Y avg` : "5Y avg";
  const band: ResolvedSeries = {
    ...staticSeries(seasonal.band.flatMap(([week, min, average, max]) => {
      if (min == null || average == null || max == null) return [];
      const date = doeWeekDate(week);
      return [{ date, observedAt: date, value: value(average), low: value(min), high: value(max) }];
    }), { id: "five-year", label: bandLabel, color: colors.warning, style: "band", calendarSpaced: true }),
    unit: DOE_UNIT_LABEL[row.unit], unitGroup,
  };
  // The selected row's year leads, so the legend names the row and the cursor reads its level.
  return [
    line("current", `${row.label} ${seasonal.year}`, colors.positive, seasonal.current),
    line("previous", String(seasonal.year - 1), blendHex(colors.bg, colors.textDim, 0.8), seasonal.previous),
    band,
  ].filter((series) => series.points.length > 0);
}

/** One row for a short pane: this year's line and its latest level. */
export function doeSeasonalStrip(row: DoeSeriesRow, color: string): ChartStripSpec | null {
  const points = row.seasonal?.current ?? [];
  if (points.length < 2 || row.value == null) return null;
  return {
    label: `${row.label} ${row.seasonal!.year}`,
    values: points.map(([, raw]) => doeDisplayValue(row.unit, raw)),
    value: `${formatDoeLevel(row.unit, row.value)} ${DOE_UNIT_LABEL[row.unit]}`,
    color,
  };
}

export const doeAxisFormatter = (unit: DoeUnit) => spanAxisFormatter((value, digits) =>
  `${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit === "pct" ? "%" : ""}`);

/** Week ticks a quarter apart, so the axis reads the season. */
export function doeWeekTicks(weeks: number): Array<{ label: string; ratio: number }> {
  return [1, 13, 26, 39, 52].filter((week) => week <= weeks)
    .map((week) => ({ label: `W${week}`, ratio: (week - 1) / Math.max(1, weeks - 1) }));
}

