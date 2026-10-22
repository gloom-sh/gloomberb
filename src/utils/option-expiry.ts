/**
 * Option expiries as people type and read them. A chain stamps each expiry as
 * Unix seconds at that calendar date's UTC midnight, so a date and its stamp
 * convert both ways, and two stamps on the same UTC date are the same expiry.
 */

import type { OptionsChain } from "../types/financials";
import { hasRegularCloseHour, latestRegularSessionClose, sessionCalendarTimeZone } from "../market-data/market/freshness";
import { dateOptionHint, readCalendarDate } from "./calendar-date";
import { canonicalExchange, isUsListingExchange } from "./exchanges";
import { zonedWallClockToUtcMs } from "./zoned-date-time";

// 9999-12-31 in Unix seconds; a longer number is milliseconds or a typo.
const MAX_UNIX_SECONDS = 253_402_300_799;
const UNIX_SECONDS = /^\d{1,12}$/;
const DAY_MS = 86_400_000;

/** How `--expiration` is written, for usage lines and errors. */
export const OPTION_EXPIRATION_FORMAT = "YYYY-MM-DD (2028-01-21), DD.MM.YYYY, Jan 21 2028, 21 January 2028 or Unix seconds (1832025600)";
/** The value's name in a catalog flag, `--expiration <date|unix>`. */
export const OPTION_EXPIRATION_PLACEHOLDER = "date|unix";

/** Seconds into its UTC day that Deribit stamps each expiry at: its 08:00 UTC settlement. */
const UTC_SETTLEMENT_SECONDS = 8 * 3600;

/**
 * Whether an expiry stamp is the settlement instant itself, as Deribit stamps
 * its BTC and ETH expiries (08:00 UTC), rather than a listed option's date. No
 * US listing is stamped at that hour: they carry the date's midnight or its close.
 */
export function isSettlementStamp(seconds: number): boolean {
  return Number.isFinite(seconds) && ((seconds % 86_400) + 86_400) % 86_400 === UTC_SETTLEMENT_SECONDS;
}

/** `08:00 UTC` for a settlement stamp (`isSettlementStamp`); null for a dated one. */
export function settlementStampTime(seconds: number): string | null {
  return isSettlementStamp(seconds) ? `${new Date(seconds * 1000).toISOString().slice(11, 16)} UTC` : null;
}

/** The expiry's calendar date, `2028-01-21`; empty for a stamp that is not a time. */
export function expiryIsoDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * `--expiration` as the Unix seconds a chain request takes: a date, as a date
 * option reads it (`2028-01-21`, `21.01.2028`, `Jan 21 2028`), is that date at
 * 00:00 UTC, a bare integer is already Unix seconds. Anything else, including a
 * date the calendar does not have, is null.
 */
export function parseOptionExpiration(raw: string): number | null {
  const text = raw.trim();
  const date = readCalendarDate(text);
  if (date) {
    const at = Date.parse(`${date}T00:00:00Z`);
    return at > 0 ? at / 1000 : null;
  }
  if (!UNIX_SECONDS.test(text)) return null;
  const seconds = Number(text);
  return seconds > 0 && seconds <= MAX_UNIX_SECONDS ? seconds : null;
}

/**
 * The sentence that follows an unreadable expiry: the date to type for one
 * written another way that plainly names it (`Type --expiration 2026-10-22 for
 * 22/10/2026.`), led by a space, or nothing for anything else.
 */
export function expirationHint(value: string, flag = "expiration"): string {
  const hint = dateOptionHint(value, `--${flag}`);
  return hint ? ` ${hint[0]!.toUpperCase()}${hint.slice(1)}.` : "";
}

/**
 * A pane function's typed expiry flag as the Unix seconds `parseOptionExpiration`
 * reads; throws an Error naming both accepted forms.
 */
export function expirationOptionSeconds(value: string, flag = "expiration"): number {
  const expiration = parseOptionExpiration(value);
  if (expiration == null) throw new Error(`Invalid --${flag} "${value}". Use ${OPTION_EXPIRATION_FORMAT}.${expirationHint(value, flag)}`);
  return expiration;
}

/** A stored or typed expiry setting (seconds, or text `parseOptionExpiration` reads) as Unix seconds; null when it is neither. */
export function readOptionExpiration(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 && value <= MAX_UNIX_SECONDS ? value : null;
  return typeof value === "string" ? parseOptionExpiration(value) : null;
}

/** The listed stamp for the requested expiry's date, which may differ from the requested stamp in time of day. */
export function findListedExpiry(requested: number, expirations: readonly number[]): number | undefined {
  if (expirations.includes(requested)) return requested;
  const date = expiryIsoDate(requested);
  return date ? expirations.find((expiration) => expiryIsoDate(expiration) === date) : undefined;
}

/** Whole calendar days from the as-of date to the expiry, both read as UTC dates; negative once it has passed. */
export function daysToExpiry(expiration: number, asOfMs: number): number {
  const expiry = Date.parse(expiryIsoDate(expiration));
  const asOf = Date.parse(new Date(asOfMs).toISOString().slice(0, 10));
  return Math.round((expiry - asOf) / DAY_MS);
}

/** `469d` to expiry from the as-of date; `expired` once its last session has closed (`isLiveOptionExpiry`). */
export function formatDaysToExpiry(expiration: number, asOfMs: number, exchange?: string): string {
  return isLiveOptionExpiry(expiration, asOfMs, exchange) ? `${Math.max(0, daysToExpiry(expiration, asOfMs))}d` : "expired";
}

/** Listed US options trade on the US equity calendar, NYSE's published one. */
const US_OPTIONS_CALENDAR = "NYSE";
const lastSessions = new Map<string, { date: string; close: number } | null>();

/**
 * The venue whose calendar an expiry's last session is read on: a listing's
 * own venue abroad when its zone and close hour are known (XETRA, JPX), else
 * the US one listed options trade on, which also stands for a chain read
 * without a venue.
 */
function expiryCalendarVenue(exchange: string | undefined): string {
  const venue = canonicalExchange(exchange);
  return venue && !isUsListingExchange(venue) && hasRegularCloseHour(venue) && sessionCalendarTimeZone(venue)
    ? venue : US_OPTIONS_CALENDAR;
}

/** The expiry's last trading session, on or before its date, on its venue's calendar: the date and when it closed. */
function expiryLastSession(expiration: number, exchange: string | undefined): { date: string; close: number } | null {
  const date = expiryIsoDate(expiration);
  if (!date) return null;
  const venue = expiryCalendarVenue(exchange);
  const key = `${venue}:${date}`;
  const known = lastSessions.get(key);
  if (known !== undefined) return known;
  const timeZone = sessionCalendarTimeZone(venue)!;
  // Midnight ending the expiry's date on the venue's clock: its session that day, else the latest before it.
  const dayEnd = zonedWallClockToUtcMs(timeZone, Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)) + 1, 0, 0, 0);
  const session = latestRegularSessionClose(venue, dayEnd);
  const last = session ? { date: session.date, close: session.close } : null;
  // The calendar is static, and every list and picker asks about the same few dates.
  if (lastSessions.size < 4096) lastSessions.set(key, last);
  return last;
}

/**
 * When an expiry stops trading: the regular close of its last session, the
 * listing venue's last trading day on or before the expiry's date, on that
 * venue's clock and calendar. A US expiry closes at 16:00 New York, at 13:00
 * on a published early close, and one dated on a holiday or a weekend closed
 * with the session before it. Null for a stamp that is not a date.
 */
export function optionExpiryCloseMs(expiration: number, exchange?: string): number | null {
  return expiryLastSession(expiration, exchange)?.close ?? null;
}

/**
 * The rule every expiry list, picker and default chain follows: an expiry is
 * live until its last session has closed (`optionExpiryCloseMs`). After
 * Friday's close Friday's expiry is gone, over the weekend and on Monday
 * before the open too, while on its own day it stays until the close.
 */
export function isLiveOptionExpiry(expiration: number, now: number, exchange?: string): boolean {
  if (!Number.isFinite(expiration) || expiration <= 0) return false;
  const close = optionExpiryCloseMs(expiration, exchange);
  return close != null && now < close;
}

/** The listed expiries still live (`isLiveOptionExpiry`), once each, in date order. */
export function liveOptionExpiries(expirations: readonly number[], now: number, exchange?: string): number[] {
  return [...new Set(expirations)].filter((expiration) => isLiveOptionExpiry(expiration, now, exchange)).sort((a, b) => a - b);
}

/** The chain with only its live expiries listed; the contracts are left as they are. */
export function withLiveExpiryList<T extends Pick<OptionsChain, "expirationDates">>(chain: T, now: number, exchange?: string): T {
  const live = liveOptionExpiries(chain.expirationDates, now, exchange);
  return live.length === chain.expirationDates.length && live.every((expiration, index) => expiration === chain.expirationDates[index])
    ? chain : { ...chain, expirationDates: live };
}

/**
 * The expiry a chain asked for without a date shows instead of the one its
 * source sent, by the same rule: undefined when the source's default is live
 * or has no contracts, else the nearest live expiry it lists, to ask for by
 * date, or null when none of them is live. A source can still answer with
 * Friday's chain after Friday's close, all weekend.
 */
export function liveDefaultExpiry(
  chain: Pick<OptionsChain, "calls" | "puts" | "expirationDates">, now: number, exchange?: string,
): number | null | undefined {
  const contracts = [...chain.calls, ...chain.puts];
  if (contracts.length === 0 || contracts.some((contract) => isLiveOptionExpiry(contract.expiration, now, exchange))) return undefined;
  return liveOptionExpiries(chain.expirationDates, now, exchange)[0] ?? null;
}

/** The first live listed expiry dated after `expiration`, for a chain that had nothing to offer. */
export function nextLiveExpiry(expiration: number, expirations: readonly number[], now: number, exchange?: string): number | undefined {
  const date = expiryIsoDate(expiration);
  return liveOptionExpiries(expirations, now, exchange).find((listed) => expiryIsoDate(listed) > date);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An expiry's date as a sentence names it: `23 Oct`, with the year when it is not the current one (`21 Jan 2028`). */
export function expiryDayLabel(expiration: number | string, now: number): string {
  const date = typeof expiration === "string" ? expiration : expiryIsoDate(expiration);
  if (!date) return "";
  const label = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;
  return date.slice(0, 4) === new Date(now).toISOString().slice(0, 4) ? label : `${label} ${date.slice(0, 4)}`;
}

/** An expiry to pick, and with a flag how to ask for it: `30 Oct (--expiration 2026-10-30)`. */
export function expiryChoiceText(expiration: number, now: number, flag?: string): string {
  return `${expiryDayLabel(expiration, now)}${flag ? ` (--${flag} ${expiryIsoDate(expiration)})` : ""}`;
}

/**
 * Why an expired date shows no chain, naming the day its last session closed
 * and the nearest live expiry, with the flag that asks for it when given:
 * `expired on 23 Oct; nearest live: 30 Oct (--expiration 2026-10-30)`.
 */
export function expiredExpiryText(
  requested: number, expirations: readonly number[], now: number, { exchange, flag }: { exchange?: string; flag?: string } = {},
): string {
  const last = expiryLastSession(requested, exchange);
  const nearest = liveOptionExpiries(expirations, now, exchange)[0];
  return `expired on ${expiryDayLabel(last?.date ?? requested, now)}; `
    + (nearest == null ? "the chain lists no live expiry" : `nearest live: ${expiryChoiceText(nearest, now, flag)}`);
}

const NEAREST_EXPIRIES = 4;

/**
 * The listed expiries nearest a requested date, in date order, so a typo or an
 * unlisted LEAPS date points at the neighbours to pick. `listed` says the date
 * itself is listed (its chain came back empty); `more` counts the rest.
 */
function expiryChoices(requested: number, expirations: readonly number[]) {
  const { nearest, more, ...rest } = nearestListedExpiries(requested, expirations);
  return { ...rest, choices: `${nearest.join(", ")}${more > 0 ? ` (+${more} more)` : ""}` };
}

/**
 * Why a requested expiry is not in a catalogue, for a line that already names
 * the date: `not listed; nearest: 2027-12-17, 2028-01-21, … (+20 more)`.
 */
export function unlistedExpiryText(requested: number, expirations: readonly number[]): string {
  const { total, choices } = expiryChoices(requested, expirations);
  return total === 0 ? "not listed; the chain lists no expiries" : `not listed; nearest: ${choices}`;
}

function nearestListedExpiries(
  requested: number,
  expirations: readonly number[],
  count = NEAREST_EXPIRIES,
): { date: string; listed: boolean; nearest: string[]; more: number; total: number } {
  const date = expiryIsoDate(requested);
  const dates = [...new Set(expirations.map(expiryIsoDate).filter(Boolean))].sort();
  const others = dates.filter((listed) => listed !== date);
  const distance = (listed: string) => Math.abs(Date.parse(listed) - Date.parse(date));
  const nearest = [...others].sort((left, right) => distance(left) - distance(right) || left.localeCompare(right))
    .slice(0, count).sort();
  return { date, listed: dates.includes(date), nearest, more: others.length - nearest.length, total: dates.length };
}

/**
 * Why an expiry has no contracts, naming the nearest listed ones:
 * `no expiry 2028-01-22; available: 2027-12-17, 2028-01-21, … (+20 more)`.
 * `subject` names the underlying where nothing else on screen does.
 */
export function missingExpiryText(requested: number, expirations: readonly number[], subject?: string): string {
  const { date, listed, total, choices } = expiryChoices(requested, expirations);
  const of = subject ? ` for ${subject}` : "";
  if (total === 0) return `no expiry ${date}${of}; the chain lists no expiries`;
  return listed
    ? `no option contracts returned for${subject ? ` ${subject}` : ""} expiry ${date}; nearest others: ${choices}`
    : `no expiry ${date}${of}; available: ${choices}`;
}

/**
 * How a command fails on an expiry the chain cannot show: `options --expiration`
 * and `fn OMON --expiration` print the same error, with the command that lists
 * every expiry as its advice line.
 */
export function missingExpiryMessage(
  symbol: string,
  requested: number,
  expirations: readonly number[],
): { message: string; details: string } {
  return {
    message: missingExpiryText(requested, expirations, symbol),
    details: `Run gloom options ${symbol} to list every expiry (--json carries them too).`,
  };
}
