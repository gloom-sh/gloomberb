import type { StatItem } from "../../../components/ui";

/**
 * The dates a range of a dated history shows. A range that reaches back past
 * the history's first date (ALL always does) shows the whole history, which
 * is said with those dates: 10Y and ALL of a series that starts in 1946 are
 * told apart by 1946.
 */
export interface HistorySpan {
  /** The first and last dates the range shows. */
  start: string;
  end: string;
  /** The range reaches before the history starts, so it shows all of it. */
  whole: boolean;
}

/**
 * The span of `shown`, the points a range keeps of a history whose first
 * date is `historyStart`; null when the range shows nothing. `windowMs` is
 * the range's length, null for the whole history.
 */
export function historySpan(
  historyStart: string,
  shown: readonly { date: string }[],
  windowMs: number | null,
): HistorySpan | null {
  const start = shown[0]?.date;
  const end = shown.at(-1)?.date;
  if (!start || !end) return null;
  const whole = windowMs == null || Date.parse(historyStart) > Date.parse(end) - windowMs;
  return { start, end, whole };
}

/**
 * The label of a figure taken over the whole history whatever the range, so
 * a shorter range does not read as having changed it: "Mean (since 1947)".
 */
export function sinceLabel(label: string, historyStart: string | null): string {
  return historyStart ? `${label} (since ${historyStart.slice(0, 4)})` : label;
}

/**
 * Where a series' history starts, said when the range asked for reaches past
 * it: "Buffett Indicator history starts 1946-10-01." A shorter range than the
 * history has needs no word.
 */
export function historyStartNotice(name: string, range: string, span: HistorySpan | null): string | null {
  if (!span?.whole) return null;
  return range === "ALL" ? `${name} history starts ${span.start}.` : `${name} history starts ${span.start}, short of ${range}.`;
}

/** The same in a pane's detail figures: the history's dates, beside the range figures they bound. */
export function historySpanStat(span: HistorySpan | null): StatItem | null {
  return span?.whole ? { id: "history", label: "History", value: span.start, detail: `to ${span.end}` } : null;
}
