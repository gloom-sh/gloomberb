import type { CloudEarningsCallPayload } from "../../../api-client";
import { formatShortDate } from "../../../utils/datetime-format";

/** "FQ4 26" — fiscal period, compact enough for a table column. */
function formatPeriod(
  fiscalYear: number | null,
  fiscalQuarter: number | null,
): string {
  if (!fiscalQuarter && !fiscalYear) return "—";
  const quarter = fiscalQuarter ? `FQ${fiscalQuarter}` : "FY";
  const year = fiscalYear ? ` ${String(fiscalYear).slice(-2)}` : "";
  return `${quarter}${year}`;
}

export function formatCallDate(value: string | null): string {
  return formatShortDate(value, { day: "2-digit", year: "2-digit", fallback: "\u2014" });
}

export function formatDuration(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

export function formatSentiment(sentiment: number | null): string {
  if (sentiment === null || !Number.isFinite(sentiment)) return "—";
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
  "ticker" | "fiscalYear" | "fiscalQuarter" | "eventKind" | "eventLabel"
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
  return formatPeriod(call.fiscalYear, call.fiscalQuarter);
}

/** Title for the detail stack: names the call so the body need not repeat it. */
export function callTitle(call: NamedCall): string {
  const label = eventLabelOf(call);
  if (label) return `${call.ticker} ${label}`;
  const period = formatPeriod(call.fiscalYear, call.fiscalQuarter);
  return period === "—" ? call.ticker : `${call.ticker} ${period}`;
}
