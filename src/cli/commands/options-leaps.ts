import type { OptionContract, OptionsChain } from "../../types/financials";
import type { CliCommandContext } from "../../types/plugin";
import type { MarketContext } from "../types";
import type { CliResultColumn } from "../result";
import { requireCliListing, loadListingQuote, type CliListing } from "../listing-arg";
import { rowsFreshness } from "../freshness";
import { formatCountCell } from "../helpers";
import { cliStyles } from "../../utils/cli-output";
import { errorMessage } from "../../utils/errors";
import { daysToExpiryFrom, type OptionSide } from "../../plugins/builtin/shared/volatility";
import { optionQuoteValuationTime } from "../../plugins/builtin/vol-surface/model";
import { optionCarry, optionSpreadPercent } from "../../plugins/builtin/options/carry";
import { parseDeltaBand } from "../../plugins/builtin/options/strike-window";
import { chainWithModelFigures, loadOptionModelInputs, OPTION_MODEL_RATE, type OptionModelInputs } from "./options-chain";
import { takeFlag, takeOption } from "./command-utils";

/**
 * `gloomberb options <symbol...> --leaps`: contracts more than a year out
 * ranked across symbols for a stock replacement, by what the time value costs
 * per year. Delta, IV and carry come from the same solver and formulas as the
 * options pane (`carry.ts`, `analytics.ts`).
 */
export const LEAPS_USAGE = "options <symbol...> --leaps [--side calls|puts] [--delta <low-high>] [--max-spread <percent>] [--min-oi <contracts>] [--sort <order>]";

export type LeapsSort = "carry" | "spread" | "oi" | "delta" | "expiry" | "symbol";
const LEAPS_SORTS: readonly LeapsSort[] = ["carry", "spread", "oi", "delta", "expiry", "symbol"];

export interface LeapsCriteria {
  side: OptionSide;
  minDelta: number;
  maxDelta: number;
  /** Widest bid/ask spread kept, in percent of the midpoint. */
  maxSpreadPercent: number;
  minOpenInterest: number;
  sort: LeapsSort;
}

export const DEFAULT_LEAPS_CRITERIA: LeapsCriteria = {
  side: "call",
  minDelta: 0.7,
  maxDelta: 0.9,
  maxSpreadPercent: 5,
  minOpenInterest: 100,
  sort: "carry",
};

/** A LEAPS expiry is more than this many calendar days out. */
const LEAPS_MIN_DAYS = 365;
/** Most symbols one run takes, and most expiries read per symbol, so a run stays a few dozen requests. */
const MAX_LEAPS_SYMBOLS = 20;
const MAX_LEAPS_EXPIRIES = 8;
/** Rows the text table shows unless --limit or --tail says otherwise; exports carry every row. */
const LEAPS_TEXT_ROWS = 40;
/** Chain requests in flight at once across every symbol. */
const LEAPS_CHAIN_CONCURRENCY = 4;
// Delta prints to three places; a contract that reads 0.700 is in a 0.70 band.
const DELTA_TOLERANCE = 5e-4;

/** `--leaps` and the options that only mean something with it, taken out of `args`. */
export function takeLeapsOptions(args: string[]): { leaps: boolean; raw: Record<string, string | undefined>; given: string[] } {
  const given: string[] = [];
  const raw: Record<string, string | undefined> = {};
  for (const flag of ["--side", "--delta", "--max-spread", "--min-oi", "--sort"]) {
    if (args.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) given.push(flag);
    raw[flag] = takeOption(args, flag);
  }
  return { leaps: takeFlag(args, "--leaps"), raw, given };
}

/** The screen's criteria from its options; a message naming the option when one cannot be read. */
export function parseLeapsCriteria(raw: Record<string, string | undefined>): LeapsCriteria | { error: string } {
  const criteria = { ...DEFAULT_LEAPS_CRITERIA };
  const side = raw["--side"]?.trim().toLowerCase();
  if (side != null) {
    if (side === "call" || side === "calls") criteria.side = "call";
    else if (side === "put" || side === "puts") criteria.side = "put";
    else return { error: `Invalid --side "${raw["--side"]}". Use calls or puts.` };
  }
  const delta = raw["--delta"];
  if (delta != null) {
    const band = parseDeltaBand(delta);
    if (!band) return { error: `Invalid --delta "${delta}". Use a band of absolute deltas such as 0.70-0.90.` };
    criteria.minDelta = band.min;
    criteria.maxDelta = band.max;
  }
  const spread = raw["--max-spread"];
  if (spread != null) {
    const value = Number(spread.trim().replace(/%$/, ""));
    if (!spread.trim() || !Number.isFinite(value) || value <= 0) {
      return { error: `Invalid --max-spread "${spread}". Use a percent of the midpoint above 0, such as 5.` };
    }
    criteria.maxSpreadPercent = value;
  }
  const openInterest = raw["--min-oi"];
  if (openInterest != null) {
    const value = Number(openInterest.trim());
    if (!/^\d+$/.test(openInterest.trim()) || !Number.isSafeInteger(value)) {
      return { error: `Invalid --min-oi "${openInterest}". Use a whole number of contracts, such as 100.` };
    }
    criteria.minOpenInterest = value;
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
};

const round = (value: number, digits: number) => Number(value.toFixed(digits));

function utcDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** The listed expiries more than a year out, nearest first. */
function leapsExpirations(expirations: readonly number[], now: number): number[] {
  return [...new Set(expirations)]
    .filter((expiration) => daysToExpiryFrom(expiration, now) > LEAPS_MIN_DAYS)
    .sort((left, right) => left - right);
}

/**
 * The contracts of one chain that pass the screen: one side, more than a year
 * out, delta in the band, a two-sided quote no wider than the cap, enough open
 * interest, and a carry that can be read. `chain` carries modeled deltas
 * (`chainWithModelFigures`).
 */
function screenLeapsChain(
  symbol: string,
  chain: OptionsChain,
  criteria: LeapsCriteria,
  inputs: OptionModelInputs,
  now: number,
): { rows: LeapsRow[]; scanned: number } {
  const spot = inputs.spot;
  const contracts = (criteria.side === "call" ? chain.calls : chain.puts) as Array<OptionContract & { delta?: number | null }>;
  const valuationTime = optionQuoteValuationTime(chain, now);
  const rows: LeapsRow[] = [];
  let scanned = 0;
  for (const contract of contracts) {
    const days = daysToExpiryFrom(contract.expiration, now);
    if (!(days > LEAPS_MIN_DAYS)) continue;
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
    rows.push({
      symbol,
      expiration: utcDate(contract.expiration),
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
    });
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

/** The criteria in one line above the table. */
function describeLeapsCriteria(criteria: LeapsCriteria): string {
  const side = criteria.side === "call" ? "Calls" : "Puts";
  return `${side} more than a year out, delta ${criteria.minDelta.toFixed(2)} to ${criteria.maxDelta.toFixed(2)}, `
    + `spread at most ${criteria.maxSpreadPercent}%, open interest at least ${criteria.minOpenInterest}; `
    + `sorted by ${SORT_LABELS[criteria.sort]}.`;
}

interface LeapsSymbolResult {
  symbol: string;
  spot: number | null;
  /** The LEAPS expiries read, YYYY-MM-DD. */
  expirations: string[];
  /** Contracts on the screened side more than a year out. */
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

async function screenSymbol(
  market: MarketContext,
  listing: CliListing,
  criteria: LeapsCriteria,
  refresh: boolean,
  limit: ReturnType<typeof concurrencyLimit>,
  now: number,
): Promise<{ result: LeapsSymbolResult; rows: LeapsRow[]; warning: string | null }> {
  const symbol = listing.key;
  const quote = loadListingQuote(market.dataProvider, listing);
  const inputsPromise = loadOptionModelInputs(market.dataProvider, listing, quote, refresh);
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
  const listed = leapsExpirations(catalogue.expirationDates, now);
  if (listed.length === 0) {
    const last = [...catalogue.expirationDates].sort((left, right) => left - right).at(-1);
    return fail(last == null ? "no listed options" : `no expiry more than a year out (last ${utcDate(last)})`, spot);
  }
  if (spot == null) return fail("no current quote to value delta and carry", null);
  const expirations = listed.slice(0, MAX_LEAPS_EXPIRIES);
  const chains = await Promise.all(expirations.map((expiration) => limit(() => loadChain(market, listing, expiration, refresh))
    .then((chain) => ({ chain }), (error: unknown) => ({ error: errorMessage(error) ?? "no response", expiration }))));
  const rows: LeapsRow[] = [];
  let scanned = 0;
  const missed: string[] = [];
  for (const loaded of chains) {
    if ("error" in loaded) {
      missed.push(utcDate(loaded.expiration));
      continue;
    }
    const screened = screenLeapsChain(symbol, chainWithModelFigures(loaded.chain, { ...inputs, now }), criteria, inputs, now);
    rows.push(...screened.rows);
    scanned += screened.scanned;
  }
  const notes = [
    missed.length > 0 ? `chain unavailable for ${missed.join(", ")}` : null,
    listed.length > expirations.length ? `read the nearest ${expirations.length} of ${listed.length} LEAPS expiries` : null,
  ].filter((note): note is string => note != null);
  if (missed.length === expirations.length) return fail(`options chain unavailable for ${missed.join(", ")}`, spot);
  return {
    result: { symbol, spot, expirations: expirations.map(utcDate), scanned, matched: rows.length },
    rows,
    warning: notes.length > 0 ? `${symbol}: ${notes.join("; ")}` : null,
  };
}

const formatDelta = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(3) : "—";
const formatPrice = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
const formatPercent = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";

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

const TEXT_COLUMN_KEYS = ["symbol", "expiration", "days", "strike", "delta", "bid", "ask", "spreadPercent", "openInterest", "extrinsic", "extrinsicPerYearPercent"];
const LEAPS_TEXT_COLUMNS: CliResultColumn<LeapsRow>[] = TEXT_COLUMN_KEYS.map((key) => {
  const column = LEAPS_COLUMNS.find((candidate) => candidate.key === key)!;
  if (key === "spreadPercent") return { ...column, header: "Sprd" };
  if (key === "extrinsic") return { ...column, header: "Extr" };
  if (key === "extrinsicPerYearPercent") return { ...column, header: "Extr/yr" };
  return column;
});

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
  const screened = await Promise.all(listings.map((listing) => screenSymbol(market, listing, criteria, refresh, limit, now)));
  const symbols = screened.map((entry) => entry.result);
  // Nothing to rank only when no symbol's chain loaded at all; a symbol without LEAPS is an answer.
  if (symbols.every((entry) => entry.error?.startsWith("options chain unavailable"))) {
    ctx.fail(screened.map((entry) => entry.warning).filter(Boolean).join("\n"));
  }
  const rows = sortLeapsRows(screened.flatMap((entry) => entry.rows), criteria.sort);
  const warnings = screened.map((entry) => entry.warning).filter((warning): warning is string => warning != null);
  const { format, limit: rowLimit, tail } = ctx.cliOptions;
  const capped = format === "text" && rowLimit == null && tail == null && rows.length > LEAPS_TEXT_ROWS;
  const describe = (data: readonly LeapsRow[]) => {
    const criteriaLine = describeLeapsCriteria(criteria);
    if (data.length === 0) {
      // With no rows the summary stands in for the empty message, so it carries both.
      return `${criteriaLine}\n\n${cliStyles.muted("No contract passed the screen. Widen --delta, --max-spread or --min-oi.")}`;
    }
    return capped
      ? `${criteriaLine}\n${cliStyles.muted(`The best ${LEAPS_TEXT_ROWS} of ${data.length}; --limit ${data.length} shows them all, --csv and --json carry every row.`)}`
      : criteriaLine;
  };
  ctx.printResult({
    data: rows,
    metadata: {
      criteria: { ...criteria, minDays: LEAPS_MIN_DAYS },
      symbols,
      // What delta and carry are valued from; spot per symbol is on each row and in `symbols`.
      model: { rate: OPTION_MODEL_RATE },
    },
    ...(warnings.length > 0 ? { warnings } : {}),
    freshness: rowsFreshness(rows),
  }, {
    rows: (data) => data,
    columns: LEAPS_COLUMNS,
    textColumns: LEAPS_TEXT_COLUMNS,
    layout: "table",
    ...(capped ? { defaultLimit: LEAPS_TEXT_ROWS } : {}),
    summary: describe,
  });
}
