const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The typical spacing of a series of bar times: the median gap between
 * consecutive distinct times, so the long gap a holiday leaves (Golden Week
 * closes Shanghai from 30 Sep to 8 Oct) does not read as the bar size. Null
 * with fewer than two distinct times.
 */
export function medianBarGap(times: readonly number[]): number | null {
  const finite = times.filter(Number.isFinite).sort((left, right) => left - right);
  const gaps = finite.slice(1).map((time, index) => time - finite[index]!).filter((gap) => gap > 0).sort((left, right) => left - right);
  return gaps.length > 0 ? gaps[Math.floor((gaps.length - 1) / 2)]! : null;
}

/** A bar size of a day or more read from the typical spacing of its bars (medianBarGap). */
export function barSizeFromGap(gapMs: number): "1d" | "1wk" | "1mo" {
  const days = gapMs / DAY_MS;
  return days >= 25 ? "1mo" : days >= 6 ? "1wk" : "1d";
}

const BAR_SIZE_ORDER = { "1d": 0, "1wk": 1, "1mo": 2 } as const;

/** Whether bars are each the start of a week, all on one weekday, or of a month, in its first week. */
function startPeriods(times: readonly number[], size: "1wk" | "1mo"): boolean {
  const dates = times.filter(Number.isFinite).map((time) => new Date(time));
  return size === "1wk" ? new Set(dates.map((date) => date.getUTCDay())).size === 1 : dates.every((date) => date.getUTCDate() <= 7);
}

/**
 * The size of bars asked for as `requested`: the request, not the spacing.
 * A thinly traded listing's daily bars sit a week or two apart (B95 on SGX
 * traded on 13 Oct, 22 Oct and 6 Nov), which the spacing reads as weekly.
 * Bars the source served finer than asked show it in their spacing; coarser
 * ones only when each starts its period, as weekly and monthly bars do.
 */
export function requestedBarSize(times: readonly number[], requested: "1d" | "1wk" | "1mo"): "1d" | "1wk" | "1mo" {
  const gap = medianBarGap(times);
  if (gap == null) return requested;
  const read = barSizeFromGap(gap);
  if (BAR_SIZE_ORDER[read] < BAR_SIZE_ORDER[requested]) return read;
  return BAR_SIZE_ORDER[read] > BAR_SIZE_ORDER[requested] && startPeriods(times, read as "1wk" | "1mo") ? read : requested;
}
