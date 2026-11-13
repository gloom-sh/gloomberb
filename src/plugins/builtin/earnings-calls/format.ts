import { MISSING_VALUE } from "../../../utils/format";
import type { CloudEarningsCallPayload } from "../../../api-client";
import { formatShortDate } from "../../../utils/datetime-format";

/**
 * "FQ4 26", "H1 26" or "FY 26": the fiscal period, compact enough for a table
 * column. A half year's results have no quarter, as a year's do, and are told
 * apart by `fiscalHalf` (SHKP's interim and annual results calls of FY2026).
 */
function formatPeriod(
  fiscalYear: number | null,
  fiscalQuarter: number | null,
  fiscalHalf?: number | null,
): string {
  if (!fiscalQuarter && !fiscalYear) return MISSING_VALUE;
  const quarter = fiscalQuarter ? `FQ${fiscalQuarter}` : fiscalHalf ? `H${fiscalHalf}` : "FY";
  const year = fiscalYear ? ` ${String(fiscalYear).slice(-2)}` : "";
  return `${quarter}${year}`;
}

/** The FQ column of `fn CALLS`: the quarter, or `H1` for a half year's results. */
export function fiscalQuarterText(call: { fiscalQuarter: number | null; fiscalHalf?: number | null }): string | number | null {
  return call.fiscalQuarter ?? (call.fiscalHalf ? `H${call.fiscalHalf}` : null);
}

/**
 * What a company with no call yet reads, in the pane and `fn CALLS`: not yet
 * available, never an error or a gap in coverage.
 */
export function noCallsText(ticker: string): { title: string; message: string } {
  return { title: `Earnings calls for ${ticker} are not yet available.`, message: "Calls appear once the company's investor site or filings list a webcast." };
}

export function formatCallDate(value: string | null): string {
  return formatShortDate(value, { day: "2-digit", year: "2-digit", fallback: MISSING_VALUE });
}

export function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return MISSING_VALUE;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

export function formatSentiment(sentiment: number | null): string {
  if (sentiment === null || !Number.isFinite(sentiment)) return MISSING_VALUE;
  const rounded = sentiment.toFixed(2);
  return sentiment > 0 ? `+${rounded}` : rounded;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

type NamedCall = Pick<
  CloudEarningsCallPayload,
  "ticker" | "fiscalYear" | "fiscalQuarter" | "fiscalHalf" | "eventKind" | "eventLabel"
>;

/** An event that is not an earnings call (a deal call, an investor day), shown by its label and never as a quarter. */
export function eventLabelOf(call: Omit<NamedCall, "ticker">): string | null {
  return call.eventKind === "other" && call.eventLabel ? call.eventLabel : null;
}

// Fits the period column; the full label is in the detail title.
const SHORT_EVENT_LABELS: Record<string, string> = {
  "M&A call": "M&A",
  conference: "Conf",
  "investor day": "Inv day",
  "business update": "Update",
  "trial results": "Trial",
  "shareholder call": "Holders",
};

/** The period column: "FQ4 26", or a short event label ("M&A", "Inv day"). */
export function callPeriod(call: Omit<NamedCall, "ticker">): string {
  const label = eventLabelOf(call);
  if (label) return SHORT_EVENT_LABELS[label] ?? label;
  return formatPeriod(call.fiscalYear, call.fiscalQuarter, call.fiscalHalf);
}

/** Title for the detail stack: names the call so the body need not repeat it. */
export function callTitle(call: NamedCall): string {
  const label = eventLabelOf(call);
  if (label) return `${call.ticker} ${label}`;
  const period = formatPeriod(call.fiscalYear, call.fiscalQuarter, call.fiscalHalf);
  return period === MISSING_VALUE ? call.ticker : `${call.ticker} ${period}`;
}
