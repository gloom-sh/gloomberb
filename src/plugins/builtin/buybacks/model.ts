import type { BuybackBlackoutWindow, BuybackDay, BuybacksPayload } from "../../../api-client/buybacks";
import type { DataTableColumn } from "../../../components";
import type { TimeSeriesPoint } from "../../../time-series/types";
import { MISSING_VALUE, formatCompact } from "../../../utils/format";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type BuybackColumnId = "date" | "shares" | "percentOfVolume" | "average" | "low" | "high" | "paid" | "elsewhere" | "destination" | "mandateUsed" | "note";
export type BuybackColumn = Omit<DataTableColumn, "id"> & { id: BuybackColumnId };
export const BUYBACK_COLUMNS: BuybackColumn[] = [
  { id: "date", label: "DATE", width: 12, align: "left" },
  { id: "shares", label: "HK BOUGHT", width: 10, align: "right" },
  { id: "percentOfVolume", label: "% VOL", width: 7, align: "right" },
  { id: "average", label: "AVG", width: 9, align: "right" },
  { id: "low", label: "LOW", width: 9, align: "right" },
  { id: "high", label: "HIGH", width: 9, align: "right" },
  { id: "paid", label: "PAID", width: 9, align: "right" },
  { id: "elsewhere", label: "ELSEWHERE", width: 16, align: "left" },
  { id: "destination", label: "TO", width: 9, align: "left" },
  { id: "mandateUsed", label: "MANDATE USED", width: 13, align: "right" },
  { id: "note", label: "NOTE", width: 14, flexGrow: 1, align: "left" },
];
export interface BuybackSort { column: BuybackColumnId; direction: "asc" | "desc" }

/** `24 Nov`, with the year when it is not `year`. */
export function shortDay(day: string, year?: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTHS[m! - 1]}${year === y ? "" : ` ${y}`}`;
}
export const shares = (value: number | null | undefined) => value == null ? MISSING_VALUE : formatCompact(value, { fixedDecimals: true });
export const percent = (value: number | null | undefined, decimals = 2) => value == null ? MISSING_VALUE : `${value.toFixed(decimals)}%`;
export const price = (value: number | null | undefined) => value == null ? MISSING_VALUE : value >= 1000 ? value.toFixed(0) : value >= 100 ? value.toFixed(1) : value.toFixed(2);
const DESTINATION = { cancel: "Cancel", treasury: "Treasury", mixed: "Both" } as const;

export function venuesText(day: BuybackDay): string {
  return day.venues.map((venue) => venue.venue).filter((name, index, all) => all.indexOf(name) === index).join(" + ");
}

/** Shares bought off the Exchange that day, and where: `1.45M LSE +2`. */
function elsewhereText(day: BuybackDay): string {
  const away = day.venues.filter((venue) => venue.venue !== "HKEX");
  if (!away.length) return "";
  const names = away.map((venue) => venue.venue).filter((name, index, all) => all.indexOf(name) === index);
  return `${shares(away.reduce((sum, venue) => sum + venue.shares, 0))} ${names[0]}${names.length > 1 ? ` +${names.length - 1}` : ""}`;
}

/** What a row says beyond its numbers: a blackout it fell in, a revised or multi-day return. */
export function dayNote(day: BuybackDay): string {
  return [
    day.inBlackout ? `In ${day.inBlackout} blackout` : null,
    day.filing.revised ? "Revised return" : null,
    day.filing.multiDay ? "Several days in one return" : null,
  ].filter(Boolean).join(" · ");
}

/** The mandate used after the row, as a percent of the most it authorises (not of the shares in issue). */
export function mandateUsedPercent(day: BuybackDay, data: BuybacksPayload): number | null {
  const authorised = data.mandate?.authorised;
  return day.mandateUsed != null && authorised ? day.mandateUsed / authorised * 100 : null;
}

/** "5.5% of 911.80M authorised": what a share of the mandate is a share of. */
export function ofAuthorised(percentUsed: number | null, authorised: number | null | undefined): string | null {
  return percentUsed == null || !authorised ? null : `${percent(percentUsed, 1)} of ${shares(authorised)} authorised`;
}

export function cellText(day: BuybackDay, column: BuybackColumnId): string {
  switch (column) {
    case "date": return day.date;
    case "shares": return day.sharesOnExchange ? shares(day.sharesOnExchange) : MISSING_VALUE;
    case "percentOfVolume": return percent(day.percentOfVolume);
    case "average": return price(day.average);
    case "low": return price(day.low);
    case "high": return price(day.high);
    case "paid": return shares(day.paidOnExchange);
    case "elsewhere": return elsewhereText(day);
    case "destination": return day.destination ? DESTINATION[day.destination] : MISSING_VALUE;
    // Shares, as the return states them: the header and the detail give the share of the authorised maximum.
    case "mandateUsed": return shares(day.mandateUsed);
    case "note": return dayNote(day);
  }
}

export function sortedDays(data: BuybacksPayload, sort: BuybackSort): BuybackDay[] {
  const value = (day: BuybackDay): number | string | null => sort.column === "date" ? day.date
    : sort.column === "shares" ? day.sharesOnExchange : sort.column === "percentOfVolume" ? day.percentOfVolume
      : sort.column === "average" ? day.average : sort.column === "low" ? day.low : sort.column === "high" ? day.high
        : sort.column === "paid" ? day.paidOnExchange : sort.column === "mandateUsed" ? day.mandateUsed
          : cellText(day, sort.column);
  return data.days.toSorted((a, b) => {
    const left = value(a), right = value(b);
    if (left == null || right == null) return left == null ? right == null ? b.date.localeCompare(a.date) : 1 : -1;
    return (left < right ? -1 : left > right ? 1 : 0) * (sort.direction === "asc" ? 1 : -1) || b.date.localeCompare(a.date);
  });
}

const point = (day: string, value: number | null): TimeSeriesPoint => {
  const date = new Date(`${day}T00:00:00.000Z`);
  return { date, observedAt: date, value };
};
/** The line's closes over the window. */
export const closePoints = (data: BuybacksPayload) => data.history.map((row) => point(row.date, row.close));
/**
 * The first session whose buying the payload states in full, when sessions
 * are withheld (the free preview sends the newest few): the oldest one sent,
 * since a withheld session can fall anywhere before it. Null when nothing is
 * withheld.
 */
export function boughtKnownFrom(data: BuybacksPayload): string | null {
  if (!data.lockedDays) return null;
  // Every session withheld: none of the history is known.
  return data.days.reduce((oldest, day) => day.date < oldest ? day.date : oldest, "9999-12-31");
}
/**
 * Shares bought each session on the Exchange (or elsewhere), zero on a
 * session without one so the columns keep their place, and blank (null)
 * before the sessions a preview withholds start, where buying is not known.
 */
export function boughtPoints(data: BuybacksPayload, where: "exchange" | "elsewhere"): TimeSeriesPoint[] {
  const bought = new Map(data.days.map((day) => [day.date, where === "exchange" ? day.sharesOnExchange : day.shares - day.sharesOnExchange]));
  const knownFrom = boughtKnownFrom(data);
  return data.history.map((row) => point(row.date, knownFrom && row.date < knownFrom ? null : bought.get(row.date) ?? 0));
}
export const boughtElsewhere = (data: BuybacksPayload) => data.days.some((day) => day.shares > day.sharesOnExchange);

/** "in 82 days", "from 15 Feb", "FY 2026 results, estimated". */
export function blackoutFigure(data: BuybacksPayload, today: string | null): { label: string; value: string; detail: string } {
  const { current, next, daysToNext } = data.blackout;
  if (current) return { label: "Blackout", value: `until ${shortDay(current.end)}`, detail: `${current.label} results ${basisWord(current)}`.trim() };
  if (!next || daysToNext == null) return { label: "Next blackout", value: MISSING_VALUE, detail: "no results date known" };
  const year = Number((today ?? next.start).slice(0, 4));
  return { label: "Next blackout", value: `in ${daysToNext} days`, detail: `from ${shortDay(next.start, year)} · ${next.label} ${basisWord(next)}` };
}
function basisWord(window: BuybackBlackoutWindow): string {
  return window.basis === "confirmed" ? "meeting set" : window.basis === "results" ? "" : window.basis === "deadline" ? "by deadline" : "estimated";
}

/** "Last bought 15 Oct 2026, 27 sessions ago", or none since the first session held. */
export function lastBoughtFigure(data: BuybacksPayload): { value: string; detail: string } {
  const last = data.summary.lastBuy;
  if (!last) return { value: "none", detail: data.heldFrom ? `since ${shortDay(data.heldFrom)}` : "" };
  const idle = sessionsSince(data, last);
  return { value: shortDay(last), detail: idle == null ? "" : `${idle} ${idle === 1 ? "session" : "sessions"} ago` };
}

/** Sessions since the last buy, for a figure that says the company stopped. */
function sessionsSince(data: BuybacksPayload, day: string | null): number | null {
  if (!day) return null;
  const index = data.history.findIndex((row) => row.date === day);
  return index < 0 ? null : data.history.length - 1 - index;
}
