import { formatMonthYear, formatShortDate } from "../../../utils/datetime-format";
import type { EarningsTiming } from "../../../api-client/earnings";
import { MISSING_VALUE, formatCompact, formatNumber } from "../../../utils/format";
import { isNotMeaningful, NOT_MEANINGFUL_TEXT, type NotMeaningful } from "../../../utils/growth";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const utcDate = (date: string) => new Date(`${date}T00:00:00Z`);

export const TIMING_LABEL: Record<EarningsTiming, string> = { bmo: "BMO", dmh: "DMH", amc: "AMC" };

/** "29 Oct" */
export function shortDate(date: string): string {
  return formatShortDate(utcDate(date), { year: false, utc: true });
}

/** "29 Oct '26" */
export function datedYear(date: string): string {
  return formatShortDate(utcDate(date), { year: "2-digit", utc: true });
}

/** "Wed" */
export function weekday(date: string): string {
  return WEEKDAYS[utcDate(date).getUTCDay()]!;
}

/** Fiscal quarter end month: "Sep '26". */
export function fiscalMonth(period: string | null): string {
  return formatMonthYear(period);
}

/** An implied move, priced in either direction: "±6.1%". */
export function impliedText(move: number | null | undefined): string {
  return move == null ? MISSING_VALUE : `±${(move * 100).toFixed(1)}%`;
}

/** A size of move without a sign: "4.1%". */
export function moveSize(move: number | null | undefined): string {
  return move == null ? MISSING_VALUE : `${(Math.abs(move) * 100).toFixed(1)}%`;
}

/** A signed move or surprise: "+3.2%", "-7.4%"; N/M for a surprise against a loss or zero estimate. */
export function signedPercent(value: number | NotMeaningful | null | undefined): string {
  if (isNotMeaningful(value)) return NOT_MEANINGFUL_TEXT;
  if (value == null) return MISSING_VALUE;
  const shown = Number((value * 100).toFixed(1));
  return `${shown > 0 ? "+" : ""}${shown.toFixed(1)}%`;
}

export function epsText(value: number | null | undefined): string {
  return value == null ? MISSING_VALUE : formatNumber(value, 2);
}

export function moneyText(value: number | null | undefined): string {
  return value == null ? MISSING_VALUE : formatCompact(value, { fixedDecimals: true });
}

export { epsSurprise as surprise, type Surprise } from "../shared/earnings-report";
