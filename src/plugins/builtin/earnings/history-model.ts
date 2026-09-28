import type { EarningsHistoryPayload, EarningsTiming } from "../../../api-client/earnings";
import type { StatItem } from "../../../components";
import { scalarPoint } from "../../../components/chart/static/series";
import type { TimeSeriesPoint } from "../../../time-series/types";
import type { EarningsEvent } from "../../../types/data-provider";
import { addDays, MIN_AVERAGE_REPORTS } from "./board-model";
import { coherentEarningsValue } from "./estimate-basis";
import { datedYear, impliedText, moveSize, shortDate, surprise, TIMING_LABEL } from "./format";

export interface HistoryRow {
  key: string;
  date: string;
  timing: EarningsTiming | null;
  expectedTiming: boolean;
  fiscalPeriod: string | null;
  upcoming: boolean;
  epsEstimate: number | null;
  epsActual: number | null;
  epsSurprise: number | null;
  revenueEstimate: number | null;
  revenueActual: number | null;
  revenueSurprise: number | null;
  implied: number | null;
  impliedMethod: "quote-mid" | "trade-close" | null;
  impliedExpiry: string | null;
  /** Signed close-to-close move across the report. */
  move: number | null;
  /** The move's size over the implied move: above 1 moved more than priced. */
  moveRatio: number | null;
}

/** Past quarters shown, beside the upcoming report. */
export const HISTORY_QUARTERS = 12;
const AVERAGE_OVER = 8;

/**
 * Newest first, the upcoming report leading. A report today stays upcoming
 * until its first close after the report prices a move.
 */
export function historyRows(payload: EarningsHistoryPayload | null, today: string, upcoming: EarningsEvent | null): HistoryRow[] {
  const rows: HistoryRow[] = (payload?.reports ?? []).map((report) => {
    const move = report.realized?.move ?? null;
    const implied = report.implied?.move ?? null;
    return {
      key: report.date,
      date: report.date,
      timing: report.timing,
      expectedTiming: report.timingSource === "history",
      fiscalPeriod: report.fiscalPeriod,
      upcoming: report.date >= today && move == null,
      epsEstimate: report.epsEstimate,
      epsActual: report.epsActual,
      epsSurprise: surprise(report.epsActual, report.epsEstimate),
      revenueEstimate: report.revenueEstimate,
      revenueActual: report.revenueActual,
      revenueSurprise: surprise(report.revenueActual, report.revenueEstimate),
      implied,
      impliedMethod: report.implied?.method ?? null,
      impliedExpiry: report.implied?.expiry ?? null,
      move,
      moveRatio: move != null && implied ? Math.abs(move) / implied : null,
    };
  });
  // Past the stored calendar's horizon the per-ticker calendar still knows the next date.
  if (upcoming && !rows.some((row) => row.upcoming)) {
    const date = upcoming.earningsDate.toISOString().slice(0, 10);
    if (date >= today) {
      rows.unshift({
        key: date,
        date,
        timing: upcoming.timing === "BMO" ? "bmo" : upcoming.timing === "AMC" ? "amc" : null,
        expectedTiming: false,
        fiscalPeriod: null,
        upcoming: true,
        epsEstimate: coherentEarningsValue(upcoming, "epsEstimate"),
        epsActual: null,
        epsSurprise: null,
        revenueEstimate: coherentEarningsValue(upcoming, "revenueEstimate"),
        revenueActual: null,
        revenueSurprise: null,
        implied: null,
        impliedMethod: null,
        impliedExpiry: null,
        move: null,
        moveRatio: null,
      });
    }
  }
  const upcomingRows = rows.filter((row) => row.upcoming).slice(-1);
  return [...upcomingRows, ...rows.filter((row) => !row.upcoming).slice(0, HISTORY_QUARTERS)];
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function daysUntil(date: string, today: string): string {
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

/** Most important first: the chart-table layout drops figures from the end. */
export function historyFigures(rows: readonly HistoryRow[], today: string): StatItem[] {
  const next = rows.find((row) => row.upcoming);
  const past = rows.filter((row) => !row.upcoming).slice(0, AVERAGE_OVER);
  const moves = past.flatMap((row) => (row.move == null ? [] : [Math.abs(row.move)]));
  const implied = past.flatMap((row) => (row.implied == null ? [] : [row.implied]));
  const beats = past.filter((row) => row.epsSurprise != null);
  const figures: StatItem[] = [];
  if (next) {
    figures.push({
      id: "next",
      label: "Next report",
      value: `${shortDate(next.date)}${next.timing ? ` ${TIMING_LABEL[next.timing]}` : ""}`,
      detail: daysUntil(next.date, today),
    });
    if (next.implied != null) {
      figures.push({
        id: "implied",
        label: "Implied",
        value: impliedText(next.implied),
        detail: next.impliedExpiry ? `${shortDate(next.impliedExpiry)} expiry` : undefined,
      });
    }
  }
  if (moves.length >= MIN_AVERAGE_REPORTS) {
    figures.push({ id: "average", label: "Avg move", value: moveSize(mean(moves)), detail: `last ${moves.length}` });
  }
  if (implied.length >= MIN_AVERAGE_REPORTS) {
    const tradeCloses = past.some((row) => row.impliedMethod === "trade-close");
    figures.push({
      id: "average-implied",
      label: "Avg implied",
      value: impliedText(mean(implied)),
      detail: tradeCloses ? `last ${implied.length}, trade closes` : `last ${implied.length}`,
    });
  }
  if (beats.length >= MIN_AVERAGE_REPORTS) {
    figures.push({
      id: "beats",
      label: "EPS beats",
      value: `${beats.filter((row) => row.epsSurprise! > 0).length} of ${beats.length}`,
    });
  }
  return figures;
}

/** Oldest first, the order the bars read. */
export function chartRows(rows: readonly HistoryRow[]): HistoryRow[] {
  return rows.filter((row) => row.implied != null || row.move != null).toReversed();
}

/**
 * One slot per report, with an empty slot at each end so the outer bars sit
 * inside the plot. The moves are sizes: the table carries their direction.
 */
export function chartPoints(bars: readonly HistoryRow[], value: (row: HistoryRow) => number | null): TimeSeriesPoint[] {
  if (!bars.length) return [];
  const pad = (date: string, days: number) => scalarPoint(new Date(`${addDays(date, days)}T00:00:00Z`), null);
  return [
    pad(bars[0]!.date, -1),
    ...bars.map((row) => {
      const point = value(row);
      return scalarPoint(new Date(`${row.date}T00:00:00Z`), point == null ? null : point * 100);
    }),
    pad(bars.at(-1)!.date, 1),
  ];
}

/** Each report's month under its bar; reports fall in any month, so calendar ticks would miss them. */
export function chartAxis(bars: readonly HistoryRow[]) {
  const slots = bars.length + 1;
  return {
    ticks: bars.map((row, index) => ({ label: `${shortDate(row.date).slice(0, 3)} ${row.date.slice(2, 4)}`, ratio: (index + 1) / slots })),
    formatCursor: (ratio: number) => {
      const row = bars[Math.max(0, Math.min(bars.length - 1, Math.round(ratio * slots) - 1))];
      return row ? datedYear(row.date) : "";
    },
  };
}
