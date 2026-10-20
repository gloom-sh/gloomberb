import type { ListingDelisting } from "../../types/financials";
import { tf } from "../../i18n";
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
