import type { PaneFooterSegment } from "../../../components";
import { observationFooterSegment, timestampFooterSegment } from "../../../components/layout/pane/footer/freshness";
import { shownPriceColor } from "../../../theme/colors";
import { formatPercentRaw } from "../../../utils/format";
import { formatUtcDayTime } from "../../../utils/utc-time";
import { shownSessionDay } from "../../../market-data/market/venue-session";
import { INDEX_SHORT } from "./model";
import type { MarketSummaryQuote } from "./screener";

/** The calendar the lists are of: the US listing venues share one. */
export const US_LIST_VENUE = "NYSE";
/** The part of the session a session list is of, named once that part is over. */
export const SESSION_PART: Partial<Record<string, "pre-market" | "after-hours">> = { premarket: "pre-market", afterhours: "after-hours" };

/**
 * `Fri 20 Nov close`, or `Fri 20 Nov pre-market` for a list of a part of the
 * session that has ended: the session a list read at `asOf` shows once the US
 * market has shut (`shownSessionDay`), as `fn MOST` dates it. Null while the
 * market trades, when the list's own time is its date.
 */
export function shownListSession(
  asOf: number | string | null | undefined,
  now: number,
  list: { session?: string | null; part?: "pre-market" | "after-hours" } = {},
): string | null {
  const at = typeof asOf === "number" ? asOf : typeof asOf === "string" ? Date.parse(asOf) : Number.NaN;
  const shown = shownSessionDay(US_LIST_VENUE, at, now);
  if (!shown) return null;
  const day = list.session && /^\d{4}-\d{2}-\d{2}$/.test(list.session) && list.session <= shown ? list.session : shown;
  return `${formatUtcDayTime({ time: Date.parse(`${day}T00:00:00Z`), dateOnly: true }, now)} ${list.part ?? "close"}`;
}

/** The list's date (`shownSession` once the market has shut, else when it was read) and when it was last checked. */
export function moverFreshnessFooter(asOf: number | string | null | undefined, checkedAt: number | null, shownSession: string | null = null): PaneFooterSegment[] {
  const observation = shownSession ? { id: "as-of", parts: [{ text: shownSession, tone: "muted" as const }] }
    : observationFooterSegment(asOf) ?? { id: "as-of", parts: [{ text: "observation time unavailable", tone: "muted" as const }] };
  const checked = timestampFooterSegment("checked-at", "checked", checkedAt);
  return [observation, ...(checked ? [checked] : [])];
}

/** The index summary every list's footer leads with. */
export function summaryFooterSegments(summaryQuotes: readonly MarketSummaryQuote[]): PaneFooterSegment[] {
  return summaryQuotes.map((idx) => {
    const short = INDEX_SHORT[idx.symbol] ?? idx.symbol;
    return {
      id: `summary:${idx.symbol}`,
      parts: [
        { text: short, tone: "label" as const },
        { text: formatPercentRaw(idx.changePercent), tone: "value" as const, color: shownPriceColor(idx.changePercent, 2), bold: true },
      ],
    };
  });
}
