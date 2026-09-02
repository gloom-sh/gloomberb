import type { CloudEarningsCallPayload } from "../../../api-client";

/** "FQ4 26" — fiscal period, compact enough for a table column. */
export function formatPeriod(
  fiscalYear: number | null,
  fiscalQuarter: number | null,
): string {
  if (!fiscalQuarter && !fiscalYear) return "—";
  const quarter = fiscalQuarter ? `FQ${fiscalQuarter}` : "FY";
  const year = fiscalYear ? ` ${String(fiscalYear).slice(-2)}` : "";
  return `${quarter}${year}`;
}

export function formatCallDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "2-digit",
  });
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

/** Title for the detail stack: names the call so the body need not repeat it. */
export function callTitle(call: CloudEarningsCallPayload): string {
  const period = formatPeriod(call.fiscalYear, call.fiscalQuarter);
  return period === "—" ? call.ticker : `${call.ticker} ${period}`;
}
