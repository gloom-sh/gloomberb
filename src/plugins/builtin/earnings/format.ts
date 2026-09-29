import type { EarningsTiming } from "../../../api-client/earnings";
import { formatCompact, formatNumber } from "../../../utils/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const utcDate = (date: string) => new Date(`${date}T00:00:00Z`);

export const TIMING_LABEL: Record<EarningsTiming, string> = { bmo: "BMO", dmh: "DMH", amc: "AMC" };

/** "Oct 29" */
export function shortDate(date: string): string {
  const day = utcDate(date);
  return `${MONTHS[day.getUTCMonth()]} ${day.getUTCDate()}`;
}

/** "Oct 29 '26" */
export function datedYear(date: string): string {
  return `${shortDate(date)} '${date.slice(2, 4)}`;
}

/** "Wed" */
export function weekday(date: string): string {
  return WEEKDAYS[utcDate(date).getUTCDay()]!;
}

/** Fiscal quarter end month: "Sep '26". */
export function fiscalMonth(period: string | null): string {
  if (!period) return "--";
  return `${MONTHS[Number(period.slice(5, 7)) - 1]} '${period.slice(2, 4)}`;
}

/** An implied move, priced in either direction: "±6.1%". */
export function impliedText(move: number | null | undefined): string {
  return move == null ? "--" : `±${(move * 100).toFixed(1)}%`;
}

/** A size of move without a sign: "4.1%". */
export function moveSize(move: number | null | undefined): string {
  return move == null ? "--" : `${(Math.abs(move) * 100).toFixed(1)}%`;
}

/** A signed move or surprise: "+3.2%", "-7.4%". */
export function signedPercent(value: number | null | undefined): string {
  if (value == null) return "--";
  const shown = Number((value * 100).toFixed(1));
  return `${shown > 0 ? "+" : ""}${shown.toFixed(1)}%`;
}

export function epsText(value: number | null | undefined): string {
  return value == null ? "--" : formatNumber(value, 2);
}

export function moneyText(value: number | null | undefined): string {
  return value == null ? "--" : formatCompact(value, { fixedDecimals: true });
}

/** Actual over estimate minus one, against the estimate's size so a negative estimate reads the right way. */
export function surprise(actual: number | null | undefined, estimate: number | null | undefined): number | null {
  if (actual == null || estimate == null || estimate === 0) return null;
  return (actual - estimate) / Math.abs(estimate);
}
