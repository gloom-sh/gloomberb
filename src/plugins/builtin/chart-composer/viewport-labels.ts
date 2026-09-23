import type { ChartResolution } from "../../../components/chart/core/types";

const RESOLUTION_LABELS: Record<ChartResolution, string> = {
  auto: "Auto",
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "45m": "45m",
  "1h": "1h",
  "1d": "D",
  "1wk": "W",
  "1mo": "M",
};

const RESOLUTION_NAMES: Record<Exclude<ChartResolution, "auto">, string> = {
  "1m": "1-minute",
  "5m": "5-minute",
  "15m": "15-minute",
  "30m": "30-minute",
  "45m": "45-minute",
  "1h": "hourly",
  "1d": "daily",
  "1wk": "weekly",
  "1mo": "monthly",
};

/**
 * The one way chart intervals are labelled. Intraday reads in lowercase units
 * (1m, 1h) and daily and longer as D W M, so an interval never collides with
 * a range such as 1M (one month) in the same bar.
 */
export function formatChartResolution(resolution: ChartResolution): string {
  return RESOLUTION_LABELS[resolution] ?? resolution;
}

export function describeChartResolution(resolution: ChartResolution): string {
  return resolution === "auto"
    ? "Choose an interval automatically for the active range."
    : `Use ${RESOLUTION_NAMES[resolution] ?? resolution} observations.`;
}

function calendarParts(date: Date, timeZone: string): { key: string; year: number; label: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const year = Number(part("year"));
  return { key: `${part("year")}-${part("month")}-${part("day")}`, year, label: `${part("month")} ${part("day")}` };
}

/**
 * A fixed chart window as the bar states it: one exchange session reads as
 * "Sep 23 session", a longer window as "Sep 17 to Sep 23". Dates are taken in
 * the exchange's zone, so a session that crosses UTC midnight stays one day.
 */
export function formatChartDateWindow(
  window: { start: string; end: string },
  timeZone = "UTC",
  now = new Date(),
): string | undefined {
  const start = new Date(window.start);
  const end = new Date(window.end);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return undefined;
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const first = calendarParts(start, zone);
  const last = calendarParts(end, zone);
  const currentYear = calendarParts(now, zone).year;
  const withYear = first.year !== currentYear || last.year !== currentYear;
  const label = (entry: typeof first) => withYear ? `${entry.label} ${entry.year}` : entry.label;
  return first.key === last.key ? `${label(first)} session` : `${label(first)} to ${label(last)}`;
}
