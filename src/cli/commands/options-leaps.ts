import type { OptionContract, OptionsChain, TickerFinancials } from "../../types/financials";
import type { CliCommandContext } from "../../types/plugin";
import type { MarketContext } from "../types";
import type { CliResultColumn } from "../result";
import { listingReadNotes, requireCliListing, loadListingQuote, type CliListing } from "../listing-arg";
import { rowsFreshness } from "../freshness";
import { formatCountCell } from "../helpers";
import { cliStyles, renderTable, type CliTableColumn } from "../../utils/cli-output";
import { errorMessage } from "../../utils/errors";
import { numberErrorMessage, rangeErrorMessage } from "../../utils/decimal-comma";
import { expirationHint, expiryIsoDate, OPTION_EXPIRATION_FORMAT, parseOptionExpiration } from "../../utils/option-expiry";
import { dateOptionError, readCalendarDate } from "../../utils/calendar-date";
import { isFundType } from "../../utils/sec";
import { daysToExpiryFrom, optionMid, type OptionSide } from "../../plugins/builtin/shared/volatility";
import { optionQuoteValuationTime } from "../../plugins/builtin/vol-surface/model";
import { optionBreakeven, optionCarry, optionCarryNet, optionSpreadPercent } from "../../plugins/builtin/options/carry";
import { parseDeltaBand } from "../../plugins/builtin/options/strike-window";
import { ivSymbol, loadIvScreen, type IvScreenRow } from "../../plugins/builtin/iv-history/client";
import { newYorkDay, resolveListingEvents, upcomingReportDate } from "../../plugins/builtin/shared/earnings-calendar";
import {
  chainWithModelFigures, loadOptionModelInputs, loadUnderlyingFinancials, OPTION_MODEL_RATE, type OptionModelInputs,
} from "./options-chain";
import { takeFlag, takeOption } from "./command-utils";

/**
 * `gloom options <symbol...> --leaps`: long-dated contracts ranked across
 * symbols for a stock replacement, by what the time value costs per year.
 * Delta, IV and carry come from the same solver and formulas as the options
 * pane (`carry.ts`, `analytics.ts`); IV rank and the ex-dividend date from
 * the same sources as OVDV and DES, and the next report as `earnings`, EE and
 * ERN resolve it.
 */
export const LEAPS_USAGE = "options <symbol...> --leaps [--side calls|puts] [--delta <low-high>] [--max-spread <percent>] "
  + "[--min-oi <contracts>] [--min-days <days>] [--max-days <days>] [--expiry-from <date>] [--expiry-to <date>] "
  + "[--columns <list>] [--sort <order>]";

export type LeapsSort = "carry" | "spread" | "oi" | "delta" | "expiry" | "symbol";
const LEAPS_SORTS: readonly LeapsSort[] = ["carry", "spread", "oi", "delta", "expiry", "symbol"];

/** What `--columns` adds, in the order the table and the exports show them. */
export const LEAPS_EXTRA_COLUMNS = ["iv", "ivr", "cost", "breakeven", "next-earnings", "ex-dividend", "carry-net"] as const;
type LeapsExtraColumn = (typeof LEAPS_EXTRA_COLUMNS)[number];

/** Which expiries the screen reads: every bound given, all at once. */
interface LeapsWindow {
  /** Fewest whole calendar days to expiry, as the Days column counts them; null with only a date for a lower bound. */
  minDays: number | null;
  maxDays: number | null;
  /** First and last expiry date kept, YYYY-MM-DD. */
  expiryFrom: string | null;
  expiryTo: string | null;
}

export interface LeapsCriteria extends LeapsWindow {
  side: OptionSide;
  minDelta: number;
  maxDelta: number;
  /** Widest bid/ask spread kept, in percent of the midpoint. */
  maxSpreadPercent: number;
  minOpenInterest: number;
  sort: LeapsSort;
  /** What `--columns` added; nothing beyond the screen's own figures is read without it. */
  columns: LeapsExtraColumn[];
}

/** A LEAPS expiry is at least a year out, unless the window says where it starts. */
const DEFAULT_MIN_DAYS = 365;

export const DEFAULT_LEAPS_CRITERIA: LeapsCriteria = {
  side: "call",
  minDelta: 0.7,
  maxDelta: 0.9,
  maxSpreadPercent: 5,
  minOpenInterest: 100,
  sort: "carry",
  minDays: DEFAULT_MIN_DAYS,
  maxDays: null,
  expiryFrom: null,
  expiryTo: null,
  columns: [],
};

/** Most symbols one run takes, and most expiries read per symbol, so a run stays a few dozen requests. */
const MAX_LEAPS_SYMBOLS = 20;
const MAX_LEAPS_EXPIRIES = 8;
/** Rows the text table shows unless --limit or --tail says otherwise; exports carry every row. */
const LEAPS_TEXT_ROWS = 40;
/** Chain requests in flight at once across every symbol. */
const LEAPS_CHAIN_CONCURRENCY = 4;
// Delta prints to three places; a contract that reads 0.700 is in a 0.70 band.
const DELTA_TOLERANCE = 5e-4;
/** Shares one listed equity option delivers. */
const SHARES_PER_CONTRACT = 100;

const LEAPS_FLAGS = [
  "--side", "--delta", "--max-spread", "--min-oi", "--min-days", "--max-days", "--expiry-from", "--expiry-to", "--columns", "--sort",
] as const;

/**
 * `--leaps` and the options that only mean something with it, taken out of
 * `args`. One given without a value reads as empty, which its parser refuses.
 */
export function takeLeapsOptions(args: string[]): { leaps: boolean; raw: Record<string, string | undefined>; given: string[] } {
  const given: string[] = [];
  const raw: Record<string, string | undefined> = {};
  for (const flag of LEAPS_FLAGS) {
    const present = args.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
    if (present) given.push(flag);
    const value = takeOption(args, flag);
    raw[flag] = present ? value ?? "" : undefined;
  }
  return { leaps: takeFlag(args, "--leaps"), raw, given };
}

/** A count typed as digits; a thousands comma (1,000) is named so it can be dropped. */
function parseWholeNumber(flag: string, value: string, unit: string, example: number): number | { error: string } {
  const text = value.trim();
  if (/^\d+$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  if (/^\d{1,3}(?:,\d{3})+$/.test(text)) {
    return { error: `Invalid ${flag} "${value}". Use a whole number of ${unit} without separators: ${flag} ${text.replace(/,/g, "")}.` };
  }
  return { error: `Invalid ${flag} "${value}". Use a whole number of ${unit}, such as ${flag} ${example}.` };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseExpiryDate(flag: string, value: string, example: string): string | { error: string } {
  return readCalendarDate(value) ?? { error: `Invalid ${flag} "${value}". ${dateOptionError(value, flag, { subject: "an expiry date", example })}` };
}

/** Whole calendar days to an expiry date's close, as the Days column counts them. */
function wholeDaysTo(date: string, now: number): number {
  return Math.floor(daysToExpiryFrom(parseOptionExpiration(date)!, now));
}

/** A lower bound to suggest under an upper one of `days`. */
const lowerBoundExample = (days: number) => (days >= 180 ? 180 : 0);

/**
 * The window from `--min-days`, `--max-days`, `--expiry-from`, `--expiry-to`
 * and `--expiration` (one expiry): every bound given applies. Without a lower
 * bound of its own it starts where LEAPS do, a year out. A window no expiry can
 * be in is refused with the option to change.
 */
function parseLeapsWindow(raw: Record<string, string | undefined>, now: number): LeapsWindow | { error: string } {
  const window: LeapsWindow = { minDays: null, maxDays: null, expiryFrom: null, expiryTo: null };
  for (const [flag, key] of [["--min-days", "minDays"], ["--max-days", "maxDays"]] as const) {
    const value = raw[flag];
    if (value == null) continue;
    const days = parseWholeNumber(flag, value, "calendar days to expiry", key === "minDays" ? 180 : 730);
    if (typeof days !== "number") return days;
    window[key] = days;
  }
  for (const [flag, key, example] of [["--expiry-from", "expiryFrom", "2027-06-18"], ["--expiry-to", "expiryTo", "2028-06-16"]] as const) {
    const value = raw[flag];
    if (value == null) continue;
    const date = parseExpiryDate(flag, value, example);
    if (typeof date !== "string") return date;
    window[key] = date;
  }
  const expiration = raw["--expiration"];
  if (expiration != null) {
    if (window.expiryFrom != null || window.expiryTo != null) {
      return { error: "--expiration reads one expiry; give it alone, or a range with --expiry-from and --expiry-to." };
    }
    const seconds = parseOptionExpiration(expiration);
    if (seconds == null) return { error: `Invalid --expiration "${expiration}". Use ${OPTION_EXPIRATION_FORMAT}.${expirationHint(expiration)}` };
    window.expiryFrom = window.expiryTo = expiryIsoDate(seconds);
  }
  const fromFlag = expiration != null ? "--expiration" : "--expiry-from";
  const toFlag = expiration != null ? "--expiration" : "--expiry-to";
  const { minDays, maxDays, expiryFrom: from, expiryTo: to } = window;
  if (minDays != null && maxDays != null && minDays > maxDays) {
    return { error: `--min-days ${minDays} is more than --max-days ${maxDays}. The window runs from the fewer days to the more, such as --min-days ${maxDays} --max-days ${minDays}.` };
  }
  if (from != null && to != null && from > to) {
    return { error: `--expiry-from ${from} is after --expiry-to ${to}. The window runs from the earlier date to the later, such as --expiry-from ${to} --expiry-to ${from}.` };
  }
  if (to != null && daysToExpiryFrom(parseOptionExpiration(to)!, now) <= 0) {
    return { error: `${toFlag} ${to} has passed. Use an expiry still ahead.` };
  }
  // With no lower bound of its own the window starts where LEAPS do.
  const floored = minDays == null && from == null;
  if (floored) window.minDays = DEFAULT_MIN_DAYS;
  if (floored && maxDays != null && maxDays < DEFAULT_MIN_DAYS) {
    return { error: `--max-days ${maxDays} is under the ${DEFAULT_MIN_DAYS} days --leaps starts from. Add a lower bound, such as --min-days ${lowerBoundExample(maxDays)} --max-days ${maxDays}.` };
  }
  if (to != null && window.minDays != null && wholeDaysTo(to, now) < window.minDays) {
    const days = wholeDaysTo(to, now);
    return { error: floored
      ? `${toFlag} ${to} is ${days} days out, under the ${DEFAULT_MIN_DAYS} days --leaps starts from. Add a lower bound, such as --min-days ${lowerBoundExample(days)}.`
      : `${toFlag} ${to} is ${days} days out, under --min-days ${window.minDays}. Lower --min-days or move ${toFlag} later.` };
  }
  if (from != null && maxDays != null && wholeDaysTo(from, now) > maxDays) {
    return { error: `${fromFlag} ${from} is ${wholeDaysTo(from, now)} days out, past --max-days ${maxDays}. Raise --max-days or move ${fromFlag} earlier.` };
  }
  return window;
}

/**
 * The screen's criteria from its options (and `--expiration`, which picks one
 * expiry); a message naming the option, with an example, when one cannot be read.
 */
export function parseLeapsCriteria(raw: Record<string, string | undefined>, now = Date.now()): LeapsCriteria | { error: string } {
  const criteria: LeapsCriteria = { ...DEFAULT_LEAPS_CRITERIA, columns: [] };
  const side = raw["--side"]?.trim().toLowerCase();
  if (side != null) {
    if (side === "call" || side === "calls") criteria.side = "call";
    else if (side === "put" || side === "puts") criteria.side = "put";
    else return { error: `Invalid --side "${raw["--side"]}". Use calls or puts.` };
  }
  const delta = raw["--delta"];
  if (delta != null) {
    const band = parseDeltaBand(delta);
    // 0,80-0,90 is a decimal comma at each end: the band to type is 0.80-0.90.
    if (!band) return { error: rangeErrorMessage(`Invalid --delta "${delta}". Use a band of absolute deltas such as 0.70-0.90.`, delta) };
    criteria.minDelta = band.min;
    criteria.maxDelta = band.max;
  }
  const spread = raw["--max-spread"];
  if (spread != null) {
    const text = spread.trim().replace(/%$/, "");
    const value = Number(text);
    if (!text || !Number.isFinite(value) || value <= 0) {
      return { error: numberErrorMessage(`Invalid --max-spread "${spread}". Use a percent of the midpoint above 0, such as 5.`, text) };
    }
    criteria.maxSpreadPercent = value;
  }
  const openInterest = raw["--min-oi"];
  if (openInterest != null) {
    const value = parseWholeNumber("--min-oi", openInterest, "contracts", 100);
    if (typeof value !== "number") return value;
    criteria.minOpenInterest = value;
  }
  const window = parseLeapsWindow(raw, now);
  if ("error" in window) return window;
  Object.assign(criteria, window);
  const columns = raw["--columns"];
  if (columns != null) {
    const names = columns.split(",").map((name) => name.trim().toLowerCase()).filter(Boolean);
    const unknown = names.find((name) => !(LEAPS_EXTRA_COLUMNS as readonly string[]).includes(name));
    if (names.length === 0 || unknown != null) {
      return { error: `${unknown == null ? "--columns needs a name" : `Unknown --columns name "${unknown}"`}. `
        + `Use any of ${LEAPS_EXTRA_COLUMNS.join(", ")}, comma-separated, such as --columns iv,cost,breakeven.` };
    }
    criteria.columns = LEAPS_EXTRA_COLUMNS.filter((name) => names.includes(name));
  }
  const sort = raw["--sort"]?.trim().toLowerCase();
  if (sort != null) {
    if (!LEAPS_SORTS.includes(sort as LeapsSort)) return { error: `Invalid --sort "${raw["--sort"]}". Use one of ${LEAPS_SORTS.join(", ")}.` };
    criteria.sort = sort as LeapsSort;
  }
  return criteria;
}

export type LeapsRow = {
  symbol: string;
  /** Expiry date, YYYY-MM-DD. */
  expiration: string;
  /** Calendar days to the expiry's close. */
  days: number;
  side: OptionSide;
  contract: string;
  strike: number;
  delta: number;
  bid: number;
  ask: number;
  /** Bid/ask width in percent of the midpoint. */
  spreadPercent: number;
  openInterest: number;
  /** Midpoint less intrinsic value, per share. */
  extrinsic: number;
  /** Extrinsic as a percent of spot per year to expiry. */
  extrinsicPerYearPercent: number;
  spot: number;
  currency: string;
  /** When the chain was observed. */
  asOf: string | null;
  dataSource: "live" | "delayed" | null;
  delayMinutes: number | null;
  // The fields below are on a row only when `--columns` asked for them.
  /** `iv`: the implied volatility the contract's delta is valued at, percent a year. */
  ivPercent?: number | null;
  /** `ivr`: the underlying's 30-day IV rank against its 52 weeks, 0 to 100, and the close it ranks. */
  ivRank?: number | null;
  ivRankAsOf?: string | null;
  /** `cost`: the midpoint times 100 shares, in the contract's currency. */
  costPerContract?: number;
  /** `breakeven`: the underlying's price at expiry that pays the midpoint back, and its distance from spot in percent. */
  breakeven?: number;
  breakevenFromSpotPercent?: number;
  /** `next-earnings`: the underlying's next report date, YYYY-MM-DD. */
  nextEarnings?: string | null;
  /** `ex-dividend`: the underlying's latest ex-dividend date, YYYY-MM-DD. */
  exDividend?: string | null;
  /** `carry-net`: extrinsic per year net of the rate on the strike and the dividends, percent of spot (`optionCarryNet`). */
  carryNetPerYearPercent?: number | null;
};

const round = (value: number, digits: number) => Number(value.toFixed(digits));

/** Whether an expiry is still ahead and inside the window: its Days figure and its date both. */
function inLeapsWindow(expiration: number, window: LeapsWindow, now: number): boolean {
  const remaining = daysToExpiryFrom(expiration, now);
  if (!(remaining > 0)) return false;
  const days = Math.floor(remaining);
  const date = expiryIsoDate(expiration);
  return (window.minDays == null || days >= window.minDays) && (window.maxDays == null || days <= window.maxDays)
    && (window.expiryFrom == null || date >= window.expiryFrom) && (window.expiryTo == null || date <= window.expiryTo);
}

/** The listed expiries inside the window, nearest first. */
function leapsExpirations(expirations: readonly number[], window: LeapsWindow, now: number): number[] {
  return [...new Set(expirations)]
    .filter((expiration) => inLeapsWindow(expiration, window, now))
    .sort((left, right) => left - right);
}

/**
 * The contracts of one chain that pass the screen: one side, inside the
 * window, delta in the band, a two-sided quote no wider than the cap, enough
 * open interest, and a carry that can be read. `chain` carries modeled IV and
 * deltas (`chainWithModelFigures`). The `--columns` figures that are the
 * contract's own are added here; the underlying's are added per symbol.
 */
function screenLeapsChain(
  symbol: string,
  chain: OptionsChain,
  criteria: LeapsCriteria,
  inputs: OptionModelInputs,
  now: number,
): { rows: LeapsRow[]; scanned: number } {
  const spot = inputs.spot;
  const contracts = (criteria.side === "call" ? chain.calls : chain.puts) as Array<OptionContract & { delta?: number | null; iv?: number | null }>;
  const valuationTime = optionQuoteValuationTime(chain, now);
  const wants = new Set(criteria.columns);
  const rows: LeapsRow[] = [];
  let scanned = 0;
  for (const contract of contracts) {
    if (!inLeapsWindow(contract.expiration, criteria, now)) continue;
    const days = daysToExpiryFrom(contract.expiration, now);
    scanned += 1;
    if (spot == null || contract.delta == null || !Number.isFinite(contract.delta)) continue;
    const delta = Math.abs(contract.delta);
    if (delta < criteria.minDelta - DELTA_TOLERANCE || delta > criteria.maxDelta + DELTA_TOLERANCE) continue;
    const spreadPercent = optionSpreadPercent(contract);
    if (spreadPercent == null || spreadPercent > criteria.maxSpreadPercent) continue;
    const openInterest = contract.openInterest;
    if (openInterest == null || !Number.isFinite(openInterest) || openInterest < criteria.minOpenInterest) continue;
    const carry = optionCarry(contract, criteria.side, spot, valuationTime);
    if (!carry || carry.extrinsicPerYear == null) continue;
    const row: LeapsRow = {
      symbol,
      expiration: expiryIsoDate(contract.expiration),
      days: Math.floor(days),
      side: criteria.side,
      contract: contract.contractSymbol,
      strike: contract.strike,
      delta: round(contract.delta, 4),
      bid: contract.bid,
      ask: contract.ask,
      spreadPercent: round(spreadPercent, 3),
      openInterest,
      extrinsic: round(carry.extrinsic, 4),
      extrinsicPerYearPercent: round(carry.extrinsicPerYear * 100, 3),
      spot,
      currency: contract.currency,
      asOf: chain.asOf ?? null,
      dataSource: chain.dataSource ?? null,
      delayMinutes: chain.delayMinutes ?? null,
    };
    if (wants.has("iv")) row.ivPercent = contract.iv != null && Number.isFinite(contract.iv) ? round(contract.iv * 100, 2) : null;
    // A two-sided quote passed the spread cap, so the midpoint is there.
    const mid = optionMid(contract)!;
    if (wants.has("cost")) row.costPerContract = round(mid * SHARES_PER_CONTRACT, 2);
    if (wants.has("breakeven")) {
      const breakeven = optionBreakeven(contract, criteria.side)!;
      row.breakeven = round(breakeven, 4);
      row.breakevenFromSpotPercent = round((breakeven / spot - 1) * 100, 3);
    }
    if (wants.has("carry-net")) {
      // An unknown dividend yield counts as none, as the delta beside it is valued.
      const net = optionCarryNet(carry, criteria.side, contract.strike, spot, OPTION_MODEL_RATE, inputs.dividendYield ?? 0);
      row.carryNetPerYearPercent = net == null ? null : round(net * 100, 3);
    }
    rows.push(row);
  }
  return { rows, scanned };
}

/** Rows in the screen's order; ties fall back to carry, then symbol, expiry and strike. */
export function sortLeapsRows(rows: readonly LeapsRow[], sort: LeapsSort): LeapsRow[] {
  const byCarry = (left: LeapsRow, right: LeapsRow) => left.extrinsicPerYearPercent - right.extrinsicPerYearPercent;
  const stable = (left: LeapsRow, right: LeapsRow) => left.symbol.localeCompare(right.symbol)
    || left.expiration.localeCompare(right.expiration) || left.strike - right.strike;
  const primary: Record<LeapsSort, (left: LeapsRow, right: LeapsRow) => number> = {
    carry: byCarry,
    spread: (left, right) => left.spreadPercent - right.spreadPercent,
    oi: (left, right) => right.openInterest - left.openInterest,
    delta: (left, right) => Math.abs(right.delta) - Math.abs(left.delta),
    expiry: (left, right) => left.expiration.localeCompare(right.expiration),
    symbol: (left, right) => left.symbol.localeCompare(right.symbol),
  };
  return [...rows].sort((left, right) => primary[sort](left, right) || byCarry(left, right) || stable(left, right));
}

const SORT_LABELS: Record<LeapsSort, string> = {
  carry: "extrinsic per year, lowest first",
  spread: "spread, tightest first",
  oi: "open interest, highest first",
  delta: "delta, highest first",
  expiry: "expiry, nearest first",
  symbol: "symbol",
};

function isDefaultWindow(window: LeapsWindow): boolean {
  return window.minDays === DEFAULT_MIN_DAYS && window.maxDays == null && window.expiryFrom == null && window.expiryTo == null;
}

/** The window in words: `more than a year out`, `365 to 730 days out`, `180 days or more out, expiring by 2027-12-31`. */
function describeWindow(window: LeapsWindow): string {
  if (isDefaultWindow(window)) return "more than a year out";
  const { maxDays, expiryFrom: from, expiryTo: to } = window;
  const minDays = window.minDays || null;
  const days = minDays != null && maxDays != null ? `${minDays} to ${maxDays} days out`
    : minDays != null ? `${minDays} days or more out`
      : maxDays != null ? `${maxDays} days out at most` : null;
  const dates = from != null && to != null ? (from === to ? `expiring ${from}` : `expiring ${from} to ${to}`)
    : from != null ? `expiring ${from} or later`
      : to != null ? `expiring by ${to}` : null;
  return [days, dates].filter((part): part is string => part != null).join(", ");
}

/** The criteria in one line above the table. */
function describeLeapsCriteria(criteria: LeapsCriteria): string {
  const side = criteria.side === "call" ? "Calls" : "Puts";
  return `${side} ${describeWindow(criteria)}, delta ${criteria.minDelta.toFixed(2)} to ${criteria.maxDelta.toFixed(2)}, `
    + `spread at most ${criteria.maxSpreadPercent}%, open interest at least ${criteria.minOpenInterest}; `
    + `sorted by ${SORT_LABELS[criteria.sort]}.`;
}

/** What `--columns` reads about an underlying rather than a contract. */
interface LeapsUnderlying {
  ivRank?: number | null;
  ivRankAsOf?: string | null;
  nextEarnings?: string | null;
  exDividend?: string | null;
  /** The dividend yield carry-net counts; null when unknown, which counts as none. */
  dividendYield?: number | null;
}

interface LeapsSymbolResult extends LeapsUnderlying {
  symbol: string;
  spot: number | null;
  /** The expiries read, YYYY-MM-DD. */
  expirations: string[];
  /** Expiries inside the window past the per-symbol cap, not read. */
  skippedExpirations?: string[];
  /** Contracts on the screened side inside the window. */
  scanned: number;
  matched: number;
  /** Why the symbol has no rows, when it is not just that none passed. */
  error?: string;
}

/** Runs at most `limit` tasks at once. */
function concurrencyLimit(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

async function loadChain(market: MarketContext, listing: CliListing, expiration: number | undefined, refresh: boolean): Promise<OptionsChain> {
  const { symbol, exchange } = listing.request;
  const cached = await market.dataProvider.getCachedQuery?.("getOptionsChain", [symbol, exchange, expiration, undefined])
    .load({ force: refresh });
  return cached?.value ?? await market.dataProvider.getOptionsChain(symbol, exchange, expiration, {
    cacheMode: refresh ? "refresh" : "default",
  });
}

/** IV rank for every symbol in one request, as VCA reads it; a failed request is one reason for all. */
type LeapsIvRanks = { rows: Map<string, IvScreenRow>; error: string | null };

/** The bare US symbol IV history is keyed by; null for a listing abroad, which has none. */
function ivKey(listing: CliListing): string | null {
  try {
    return ivSymbol(listing.key);
  } catch {
    // Intentional ignore: IV history supports US symbols only; unsupported listings have no IV key.
    return null;
  }
}

/** Why a symbol IV history covers has no rank yet, by where its history stands. */
const IV_COVERAGE_REASONS: Partial<Record<string, string>> = {
  queued: "IV history queued, try again in a few minutes",
  backfilling: "IV history still loading",
  unavailable: "no options history",
};

async function loadLeapsIvRanks(listings: readonly CliListing[]): Promise<LeapsIvRanks> {
  const symbols = listings.flatMap((listing) => ivKey(listing) ?? []);
  if (symbols.length === 0) return { rows: new Map(), error: null };
  try {
    const payload = await loadIvScreen(symbols);
    return { rows: new Map(payload.rows.map((row) => [row.symbol.toUpperCase(), row])), error: null };
  } catch (error) {
    return { rows: new Map(), error: errorMessage(error) ?? "no response" };
  }
}

/** Each symbol's next report date for every symbol in one calendar read, as `earnings` resolves it; a failed read is one reason for all. */
type LeapsNextReports = { dates: Map<string, string | null>; error: string | null };

async function loadLeapsNextReports(market: MarketContext, listings: readonly CliListing[], now: number): Promise<LeapsNextReports> {
  const keys = listings.map((listing) => listing.key);
  try {
    const events = await market.dataProvider.getEarningsCalendar?.(keys) ?? [];
    const resolved = await resolveListingEvents(market.dataProvider, listings.map((listing) => ({
      key: listing.key, symbol: listing.request.symbol, exchange: listing.request.exchange,
    })), events, newYorkDay(now));
    return { dates: new Map(keys.map((key) => [key.toUpperCase(), upcomingReportDate(resolved.get(key.toUpperCase()))])), error: null };
  } catch (error) {
    return { dates: new Map(), error: errorMessage(error) ?? "no response" };
  }
}

/**
 * The underlying's `--columns` figures and, in one phrase, what of them it
 * lacks: IV rank from Cloud IV history; the next report from the earnings
 * calendar, resolved as every earnings surface resolves it; the latest
 * ex-dividend date from the financials DES reads, which also give the dividend
 * yield delta is valued at. A fund reports no earnings, and a stock paying no
 * dividend has no ex-date, so neither is named as missing.
 */
function underlyingFigures(
  listing: CliListing,
  columns: ReadonlySet<LeapsExtraColumn>,
  financials: TickerFinancials | null,
  instrumentType: string | undefined,
  dividendYield: number | undefined,
  ivRanks: LeapsIvRanks | null,
  nextReports: LeapsNextReports | null,
): { figures: LeapsUnderlying; missing: string[] } {
  const figures: LeapsUnderlying = {};
  const missing: string[] = [];
  if (columns.has("ivr")) {
    const key = ivKey(listing);
    const row = key == null ? undefined : ivRanks?.rows.get(key);
    const rank = row?.iv30?.rank;
    figures.ivRank = rank != null && Number.isFinite(rank) ? round(rank, 1) : null;
    figures.ivRankAsOf = figures.ivRank != null ? row?.iv30?.date ?? null : null;
    // A failed request is said once for every symbol.
    if (figures.ivRank == null && !ivRanks?.error) {
      const reason = key == null ? "US listings only"
        : row?.iv30?.rankNote ?? row?.warnings?.[0] ?? (row ? IV_COVERAGE_REASONS[row.coverageStatus ?? row.status] ?? null : "no IV history");
      missing.push(`no IV rank${reason ? ` (${reason})` : ""}`);
    }
  }
  if (columns.has("next-earnings")) {
    figures.nextEarnings = nextReports?.dates.get(listing.key.toUpperCase()) ?? null;
    // A failed calendar read is said once for every symbol.
    if (figures.nextEarnings == null && !nextReports?.error && !isFundType(instrumentType)) missing.push("no upcoming earnings date");
  }
  if (columns.has("ex-dividend")) {
    const exDate = financials?.fundamentals?.exDividendDate;
    figures.exDividend = exDate && ISO_DATE.test(exDate) ? exDate : null;
  }
  if (columns.has("carry-net")) figures.dividendYield = dividendYield ?? null;
  if (financials == null && (columns.has("ex-dividend") || columns.has("carry-net"))) {
    missing.push(columns.has("carry-net") ? "no dividend data, so carry-net counts no dividends" : "no dividend data");
    return { figures, missing };
  }
  if (columns.has("ex-dividend") && figures.exDividend == null && dividendYield !== 0) missing.push("no ex-dividend date");
  if (columns.has("carry-net") && dividendYield == null) missing.push("dividend yield unknown, so carry-net counts no dividends");
  return { figures, missing };
}

async function screenSymbol(
  market: MarketContext,
  listing: CliListing,
  criteria: LeapsCriteria,
  refresh: boolean,
  limit: ReturnType<typeof concurrencyLimit>,
  ivRanks: Promise<LeapsIvRanks> | null,
  nextReports: Promise<LeapsNextReports> | null,
  now: number,
): Promise<{ result: LeapsSymbolResult; rows: LeapsRow[]; warning: string | null }> {
  const symbol = listing.key;
  const quote = loadListingQuote(market.dataProvider, listing);
  // One read of the financials gives delta its dividend yield and --columns the ex-dividend date.
  const financials = loadUnderlyingFinancials(market.dataProvider, listing, refresh);
  const inputsPromise = loadOptionModelInputs(market.dataProvider, listing, quote, refresh, financials);
  const fail = (error: string, spot: number | null = null) => ({
    result: { symbol, spot, expirations: [], scanned: 0, matched: 0, error },
    rows: [],
    warning: `${symbol}: ${error}`,
  });
  let catalogue: OptionsChain;
  try {
    catalogue = await limit(() => loadChain(market, listing, undefined, refresh));
  } catch (error) {
    return fail(`options chain unavailable (${errorMessage(error) ?? "no response"})`);
  }
  const inputs = await inputsPromise;
  const spot = inputs.spot ?? null;
  const listed = leapsExpirations(catalogue.expirationDates, criteria, now);
  if (listed.length === 0) {
    const all = [...catalogue.expirationDates].sort((left, right) => left - right);
    const last = all.at(-1);
    if (last == null) return fail("no listed options", spot);
    return fail(isDefaultWindow(criteria)
      ? `no expiry more than a year out (last ${expiryIsoDate(last)})`
      : `no expiry in the window, ${describeWindow(criteria)} (listed ${expiryIsoDate(all[0]!)} to ${expiryIsoDate(last)})`, spot);
  }
  if (spot == null) return fail("no current quote to value delta and carry", null);
  // A window holding more expiries than one run reads keeps those nearest its start, and says which it left.
  const expirations = listed.slice(0, MAX_LEAPS_EXPIRIES);
  const skipped = listed.slice(MAX_LEAPS_EXPIRIES).map(expiryIsoDate);
  const chains = await Promise.all(expirations.map((expiration) => limit(() => loadChain(market, listing, expiration, refresh))
    .then((chain) => ({ chain }), (error: unknown) => ({ error: errorMessage(error) ?? "no response", expiration }))));
  const rows: LeapsRow[] = [];
  let scanned = 0;
  const missed: string[] = [];
  for (const loaded of chains) {
    if ("error" in loaded) {
      missed.push(expiryIsoDate(loaded.expiration));
      continue;
    }
    const screened = screenLeapsChain(symbol, chainWithModelFigures(loaded.chain, { ...inputs, now }), criteria, inputs, now);
    rows.push(...screened.rows);
    scanned += screened.scanned;
  }
  if (missed.length === expirations.length) return fail(`options chain unavailable for ${missed.join(", ")}`, spot);
  const columns = new Set(criteria.columns);
  const underlying: { figures: LeapsUnderlying; missing: string[] } = columns.size === 0
    ? { figures: {}, missing: [] }
    : underlyingFigures(listing, columns, await financials, inputs.quote?.instrumentType ?? (await quote)?.instrumentType,
      inputs.dividendYield, ivRanks ? await ivRanks : null, nextReports ? await nextReports : null);
  // Each row carries the underlying's figures; the dividend yield behind carry-net is in `symbols`.
  const rowFigures: LeapsUnderlying = { ...underlying.figures };
  delete rowFigures.dividendYield;
  for (const row of rows) Object.assign(row, rowFigures);
  const notes = [
    missed.length > 0 ? `chain unavailable for ${missed.join(", ")}` : null,
    skipped.length > 0
      ? `read the ${expirations.length} expiries nearest the window's start, through ${expiryIsoDate(expirations.at(-1)!)}; `
        + `${skipped.length} later not read (${skipped.join(", ")}). Raise --min-days or --expiry-from to reach them`
      : null,
    ...underlying.missing,
  ].filter((note): note is string => note != null);
  return {
    result: {
      symbol, spot, expirations: expirations.map(expiryIsoDate), ...(skipped.length > 0 ? { skippedExpirations: skipped } : {}),
      scanned, matched: rows.length, ...underlying.figures,
    },
    rows,
    warning: notes.length > 0 ? `${symbol}: ${notes.join("; ")}` : null,
  };
}

const formatDelta = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "—";
const formatPrice = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
const formatPercent = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
const formatSignedPercent = (value: unknown) => typeof value === "number" && Number.isFinite(value)
  ? `${value > 0 ? "+" : ""}${value.toFixed(1)}%` : "—";
const formatWhole = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? formatCountCell(Math.round(value)) : "—";
const formatDate = (value: unknown) => typeof value === "string" && value ? value : "—";

/** Every exported column; the text table keeps those that fit 100 columns. */
const LEAPS_COLUMNS: CliResultColumn<LeapsRow>[] = [
  { key: "symbol", header: "Symbol", shrink: false },
  { key: "expiration", header: "Expiry" },
  { key: "days", header: "Days", align: "right" },
  { key: "side", header: "Side" },
  { key: "contract", header: "Contract", shrink: false },
  { key: "strike", header: "Strike", align: "right" },
  { key: "delta", header: "Delta", align: "right", format: formatDelta },
  { key: "bid", header: "Bid", align: "right", format: formatPrice },
  { key: "ask", header: "Ask", align: "right", format: formatPrice },
  { key: "spreadPercent", header: "Spread %", align: "right", format: formatPercent },
  { key: "openInterest", header: "OI", align: "right", format: formatCountCell },
  { key: "extrinsic", header: "Extrinsic", align: "right", format: formatPrice },
  { key: "extrinsicPerYearPercent", header: "Extrinsic/yr %", align: "right", format: formatPercent },
  { key: "spot", header: "Spot", align: "right", format: formatPrice },
  { key: "currency", header: "Currency" },
  { key: "asOf", header: "As Of" },
  { key: "dataSource", header: "Quotes" },
  { key: "delayMinutes", header: "Delay Min", align: "right" },
];

/** What each `--columns` name adds to the exports, after Extrinsic/yr %. */
const EXTRA_EXPORT_COLUMNS: Record<LeapsExtraColumn, CliResultColumn<LeapsRow>[]> = {
  iv: [{ key: "ivPercent", header: "IV %", align: "right", format: formatPercent }],
  ivr: [{ key: "ivRank", header: "IV Rank", align: "right" }, { key: "ivRankAsOf", header: "IV Rank As Of" }],
  cost: [{ key: "costPerContract", header: "Cost/Contract (mid x 100)", align: "right" }],
  breakeven: [
    { key: "breakeven", header: "Breakeven (at mid)", align: "right" },
    { key: "breakevenFromSpotPercent", header: "Breakeven vs Spot %", align: "right" },
  ],
  "next-earnings": [{ key: "nextEarnings", header: "Next Earnings" }],
  "ex-dividend": [{ key: "exDividend", header: "Ex-Dividend" }],
  "carry-net": [{ key: "carryNetPerYearPercent", header: "Carry Net/yr %", align: "right" }],
};

const TEXT_COLUMN_KEYS = ["symbol", "expiration", "days", "strike", "delta", "bid", "ask", "spreadPercent", "openInterest", "extrinsic", "extrinsicPerYearPercent"];
const LEAPS_TEXT_COLUMNS: CliResultColumn<LeapsRow>[] = TEXT_COLUMN_KEYS.map((key) => {
  const column = LEAPS_COLUMNS.find((candidate) => candidate.key === key)!;
  if (key === "spreadPercent") return { ...column, header: "Sprd" };
  if (key === "extrinsic") return { ...column, header: "Extr" };
  if (key === "extrinsicPerYearPercent") return { ...column, header: "Extr/yr" };
  return column;
});

/** The text table's columns for a contract's own `--columns` figures; the underlying's go in a table of their own above. */
const EXTRA_TEXT_COLUMNS: Partial<Record<LeapsExtraColumn, CliResultColumn<LeapsRow>[]>> = {
  iv: [{ key: "ivPercent", header: "IV", align: "right", format: formatPercent }],
  "carry-net": [{ key: "carryNetPerYearPercent", header: "Net/yr", align: "right", format: formatPercent }],
  cost: [{ key: "costPerContract", header: "Cost", align: "right", format: formatWhole }],
  breakeven: [
    // The distance from spot compares across symbols; the price goes first when the table is narrow.
    { key: "breakeven", header: "B/E", align: "right", format: formatPrice, optional: true, dropPriority: 3 },
    { key: "breakevenFromSpotPercent", header: "B/E%", align: "right", format: formatSignedPercent },
  ],
};

function exportColumns(columns: readonly LeapsExtraColumn[]): CliResultColumn<LeapsRow>[] {
  const extras = columns.flatMap((name) => EXTRA_EXPORT_COLUMNS[name]);
  const at = LEAPS_COLUMNS.findIndex((column) => column.key === "extrinsicPerYearPercent") + 1;
  return [...LEAPS_COLUMNS.slice(0, at), ...extras, ...LEAPS_COLUMNS.slice(at)];
}

/**
 * The text table with the contract's own `--columns` figures: IV beside delta,
 * the rest after Extr/yr. To stay inside 100 columns the break-even price goes
 * first, then the quote's bid and ask, then extrinsic per share; the exports
 * keep every one.
 */
function textColumns(columns: readonly LeapsExtraColumn[]): CliResultColumn<LeapsRow>[] {
  // Carry net of financing sits beside the carry it adjusts.
  const extras = (["carry-net", "cost", "breakeven"] as const).filter((name) => columns.includes(name))
    .flatMap((name) => EXTRA_TEXT_COLUMNS[name] ?? []);
  if (extras.length === 0 && !columns.includes("iv")) return LEAPS_TEXT_COLUMNS;
  return LEAPS_TEXT_COLUMNS.flatMap((column) => {
    if (column.key === "bid" || column.key === "ask") return [{ ...column, optional: true, dropPriority: 2 }];
    if (column.key === "extrinsic") return [{ ...column, optional: true, dropPriority: 1 }];
    if (column.key === "delta") return [column, ...columns.includes("iv") ? EXTRA_TEXT_COLUMNS.iv! : []];
    if (column.key === "extrinsicPerYearPercent") return [column, ...extras];
    return [column];
  });
}

/** The underlying's `--columns` figures, one row per symbol, above the contracts in text. */
function underlyingTable(symbols: readonly LeapsSymbolResult[], columns: readonly LeapsExtraColumn[]): string {
  const shown: Array<{ column: CliTableColumn; cell: (entry: LeapsSymbolResult) => string }> = [
    ...columns.includes("ivr") ? [{ column: { header: "IVR", align: "right" as const }, cell: (entry: LeapsSymbolResult) => formatWhole(entry.ivRank) }] : [],
    ...columns.includes("next-earnings") ? [{ column: { header: "Next earnings" }, cell: (entry: LeapsSymbolResult) => formatDate(entry.nextEarnings) }] : [],
    ...columns.includes("ex-dividend") ? [{ column: { header: "Ex-dividend" }, cell: (entry: LeapsSymbolResult) => formatDate(entry.exDividend) }] : [],
  ];
  const listed = symbols.filter((entry) => !entry.error);
  if (shown.length === 0 || listed.length === 0) return "";
  return renderTable(
    [{ header: "Symbol", shrink: false }, ...shown.map((entry) => entry.column)],
    listed.map((entry) => [entry.symbol, ...shown.map((column) => column.cell(entry))]),
  );
}

export async function runLeapsScreen(
  rawSymbols: readonly string[],
  exchangeOption: string | undefined,
  criteria: LeapsCriteria,
  market: MarketContext,
  ctx: Pick<CliCommandContext, "fail" | "printResult" | "cliOptions">,
  now = Date.now(),
): Promise<void> {
  if (rawSymbols.length > MAX_LEAPS_SYMBOLS) {
    ctx.fail(`--leaps screens at most ${MAX_LEAPS_SYMBOLS} symbols at once; ${rawSymbols.length} were given.`);
  }
  const listings = await Promise.all(rawSymbols.map((symbol) => requireCliListing(
    symbol, exchangeOption, market, ctx, { ownExchangeWins: rawSymbols.length > 1 },
  )));
  const refresh = ctx.cliOptions.refresh;
  const limit = concurrencyLimit(LEAPS_CHAIN_CONCURRENCY);
  // IV rank is one request for every symbol, read beside the chains and only when asked for.
  const ivRanks = criteria.columns.includes("ivr") ? loadLeapsIvRanks(listings) : null;
  // The next reports are one calendar read for every symbol, likewise.
  const nextReports = criteria.columns.includes("next-earnings") ? loadLeapsNextReports(market, listings, now) : null;
  const screened = await Promise.all(listings.map((listing) => screenSymbol(market, listing, criteria, refresh, limit, ivRanks, nextReports, now)));
  const symbols = screened.map((entry) => entry.result);
  // Nothing to rank only when no symbol's chain loaded at all; a symbol without LEAPS is an answer.
  if (symbols.every((entry) => entry.error?.startsWith("options chain unavailable"))) {
    ctx.fail(screened.map((entry) => entry.warning).filter(Boolean).join("\n"));
  }
  const rows = sortLeapsRows(screened.flatMap((entry) => entry.rows), criteria.sort);
  const ivRankError = ivRanks ? (await ivRanks).error : null;
  const nextReportsError = nextReports ? (await nextReports).error : null;
  const warnings = [
    ...listings.flatMap(listingReadNotes),
    ...screened.map((entry) => entry.warning).filter((warning): warning is string => warning != null),
    ...ivRankError ? [`IV rank unavailable (${ivRankError})`] : [],
    ...nextReportsError ? [`Next earnings unavailable (${nextReportsError})`] : [],
  ];
  const { format, limit: rowLimit, tail } = ctx.cliOptions;
  const capped = format === "text" && rowLimit == null && tail == null && rows.length > LEAPS_TEXT_ROWS;
  const describe = (data: readonly LeapsRow[]) => {
    const criteriaLine = describeLeapsCriteria(criteria);
    const underlying = underlyingTable(symbols, criteria.columns);
    const head = underlying ? `${criteriaLine}\n\n${underlying}` : criteriaLine;
    if (data.length === 0) {
      // With no rows the summary stands in for the empty message, so it carries both.
      const widen = isDefaultWindow(criteria) ? "--delta, --max-spread or --min-oi" : "--delta, --max-spread, --min-oi or the expiry window";
      return `${head}\n\n${cliStyles.muted(`No contract passed the screen. Widen ${widen}.`)}`;
    }
    const cap = `The best ${LEAPS_TEXT_ROWS} of ${data.length}; --limit ${data.length} shows them all, --csv and --json carry every row.`;
    if (!capped) return head;
    return underlying ? `${criteriaLine}\n${cliStyles.muted(cap)}\n\n${underlying}` : `${criteriaLine}\n${cliStyles.muted(cap)}`;
  };
  ctx.printResult({
    data: rows,
    metadata: {
      criteria,
      symbols,
      // What delta and carry are valued from; spot per symbol is on each row and in `symbols`.
      model: { rate: OPTION_MODEL_RATE },
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    freshness: rowsFreshness(rows),
  }, {
    rows: (data) => data,
    columns: exportColumns(criteria.columns),
    textColumns: textColumns(criteria.columns),
    layout: "table",
    ...(capped ? { defaultLimit: LEAPS_TEXT_ROWS } : {}),
    summary: describe,
  });
}
