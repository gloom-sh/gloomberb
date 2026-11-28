import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import { colors } from "../../../theme/colors";

const DAY_MS = 86_400_000;

/**
 * One slot per bar, oldest first, with an empty slot at each end so the outer
 * bars sit inside the plot, as ERN's report bars do.
 */
export function slotPoints<T extends { date: string }>(bars: readonly T[], value: (bar: T) => number | null | undefined): TimeSeriesPoint[] {
  if (!bars.length) return [];
  const at = (date: string, days = 0) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS);
  return [
    scalarPoint(at(bars[0]!.date, -1), null),
    ...bars.map((bar) => scalarPoint(at(bar.date), value(bar) ?? null)),
    scalarPoint(at(bars.at(-1)!.date, 1), null),
  ];
}

/** A tick under each bar; where they are too close the axis drops some rather than run them together. */
export function slotAxis<T>(bars: readonly T[], label: (bar: T) => string, cursor: (bar: T) => string) {
  const slots = bars.length + 1;
  return {
    ticks: bars.map((bar, index) => ({ label: label(bar), ratio: (index + 1) / slots })),
    formatCursor: (ratio: number) => {
      const bar = bars[Math.max(0, Math.min(bars.length - 1, Math.round(ratio * slots) - 1))];
      return bar ? cursor(bar) : "";
    },
  };
}

/** How a report's EPS reads against its estimate; "eps" with no estimate to measure against, or exactly on it. */
function outcome(actual: number | null | undefined, estimate: number | null | undefined): "beat" | "miss" | "eps" | null {
  if (actual == null) return null;
  return estimate == null || actual === estimate ? "eps" : actual > estimate ? "beat" : "miss";
}

/**
 * The beat or miss chart EVT's Earnings view and EM's Surprises draw over
 * their reports, oldest first: each report's estimate as a muted column
 * beside what was reported, the reported column in the beat or miss colour,
 * so a quarter reads at a glance. A report with no estimate to measure
 * against (or exactly on it) is the plain EPS column; one not out yet is its
 * estimate alone. Fewer than two reports draw nothing.
 */
export function beatMissSeries<T extends { date: string }>(
  bars: readonly T[],
  read: { actual: (bar: T) => number | null | undefined; estimate: (bar: T) => number | null | undefined; comparable?: (bar: T) => boolean },
  unit = "",
): ResolvedSeries[] {
  if (bars.length < 2) return [];
  const result = (bar: T) => outcome(read.actual(bar), read.comparable?.(bar) === false ? null : read.estimate(bar));
  const reported = (id: "beat" | "miss" | "eps", label: string, color: string): ResolvedSeries => ({
    ...staticSeries(slotPoints(bars, (bar) => (result(bar) === id ? read.actual(bar) : null)),
      { id, label, color, style: "columns" }),
    unit, unitGroup: "eps",
  });
  return [
    { ...staticSeries(slotPoints(bars, read.estimate), { id: "estimate", label: "Estimate", color: colors.textMuted, style: "columns" }),
      unit, unitGroup: "eps" },
    reported("beat", "Beat", colors.positive),
    reported("miss", "Miss", colors.negative),
    ...(bars.some((bar) => result(bar) === "eps") ? [reported("eps", "EPS", colors.textBright)] : []),
  ];
}
