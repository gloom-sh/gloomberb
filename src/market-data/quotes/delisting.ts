import type { ListingDelisting, ListingWithdrawal } from "../../types/financials";
import { t, tf } from "../../i18n";
import { formatShortDate } from "../../utils/datetime-format";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A listing's delisting as Gloom Cloud sends it, or undefined for anything
 * else: the service's answer is untrusted, and a malformed one must not mark
 * a listing that trades.
 */
export function parseListingDelisting(value: unknown): ListingDelisting | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { status, lastTradeDate, historyStart } = value as Record<string, unknown>;
  if (status !== "delisted" && status !== "inactive") return undefined;
  if (typeof lastTradeDate !== "string" || !DATE.test(lastTradeDate)) return undefined;
  if (typeof historyStart !== "string" || !DATE.test(historyStart) || historyStart > lastTradeDate) return undefined;
  return { status, lastTradeDate, historyStart };
}

/**
 * What a listing that no longer trades reads as beside its symbol, always with
 * its last session: "Delisted Oct 27, 2022" when the exchange's removal is on
 * record, "Last traded Apr 28, 2023" when only the last trade is known.
 */
export function delistingLabel(delisting: ListingDelisting): string {
  const date = formatShortDate(delisting.lastTradeDate, { utc: true });
  return delisting.status === "delisted" ? tf("Delisted {date}", { date }) : tf("Last traded {date}", { date });
}

/** The state alone, for a cell that names a session in a word (OPEN, CLOSED): DELISTED or INACTIVE. */
export function delistingStateLabel(delisting: ListingDelisting): "DELISTED" | "INACTIVE" {
  return delisting.status === "delisted" ? "DELISTED" : "INACTIVE";
}

/**
 * A listing's withdrawal as Gloom Cloud sends it on a search row, or
 * undefined for anything else: a malformed one must not mark a listing gone.
 */
export function parseListingWithdrawal(value: unknown): ListingWithdrawal | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { on, reason } = value as Record<string, unknown>;
  if (on !== null && (typeof on !== "string" || !DATE.test(on))) return undefined;
  if (reason !== null && (typeof reason !== "string" || !reason.trim())) return undefined;
  return { on, reason: reason?.trim() ?? null };
}

/**
 * What a withdrawn listing reads as beside its name: "Delisted Jan 27, 2026
 * (Privatised by The Hongkong and Shanghai Banking Corporation Limited)",
 * "Delisted" when its notice gives no day.
 */
export function withdrawalLabel(withdrawal: ListingWithdrawal): string {
  const label = withdrawal.on
    ? tf("Delisted {date}", { date: formatShortDate(withdrawal.on, { utc: true }) })
    : t("Delisted");
  return withdrawal.reason ? `${label} (${withdrawal.reason})` : label;
}
