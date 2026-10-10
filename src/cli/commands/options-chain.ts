import type { OptionContract, OptionsChain } from "../../types/financials";
import { cliStyles, cliTerminalWidth, wrapText } from "../../utils/cli-output";
import { isFiniteNumber } from "../../utils/guards";
import { calculateOptionGreeks, solveChainVolatilities } from "../../plugins/builtin/options/analytics";
import { optionQuoteSide } from "../../plugins/builtin/options/market-reference";
import { DEFAULT_OPTION_CALC_DRAFT } from "../../plugins/builtin/options-calculator/model";

export const OPTIONS_USAGE = "options <symbol> [--expiration <YYYY-MM-DD|unix>]";

// 9999-12-31 in Unix seconds; a longer number is milliseconds or a typo.
const MAX_UNIX_SECONDS = 253_402_300_799;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UNIX_SECONDS = /^\d{1,12}$/;

/** Chain timestamps encode an expiry calendar date in UTC, so a date is its UTC midnight. */
function utcDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/**
 * `--expiration` as the Unix seconds a chain request takes: `2028-01-21` is that
 * date at 00:00 UTC, a bare integer is already Unix seconds. Anything else,
 * including a date the calendar does not have, is null.
 */
export function parseOptionExpiration(raw: string): number | null {
  const text = raw.trim();
  const date = ISO_DATE.exec(text);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    const at = new Date(Date.UTC(year, month - 1, day));
    const real = at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
    return real && at.getTime() > 0 ? at.getTime() / 1000 : null;
  }
  if (!UNIX_SECONDS.test(text)) return null;
  const seconds = Number(text);
  return seconds > 0 && seconds <= MAX_UNIX_SECONDS ? seconds : null;
}

/** Whether the chain holds contracts of the requested expiry, matched by UTC calendar date as the chain stamps them. */
export function chainHasExpiry(chain: OptionsChain, requested: number): boolean {
  const date = utcDate(requested);
  return [...chain.calls, ...chain.puts].some((contract) => utcDate(contract.expiration) === date);
}

/** Every listed expiry as a unique, ascending UTC date. */
function listedDates(expirations: readonly number[]): string[] {
  return [...new Set(expirations.map((expiration) => utcDate(expiration)).filter(Boolean))].sort();
}

const NEAREST_EXPIRIES = 4;

/**
 * Why a chain request for one expiry came back without contracts, and which
 * expiries it could have been: the few nearest the requested date, so a typo or
 * an unlisted LEAPS date points at the neighbours to pick.
 */
export function missingExpiryMessage(
  symbol: string,
  requested: number,
  expirations: readonly number[],
): { message: string; details?: string } {
  const date = utcDate(requested);
  const dates = listedDates(expirations);
  if (dates.length === 0) return { message: `no expiry ${date} for ${symbol}; the chain lists no expiries` };
  const others = dates.filter((listed) => listed !== date);
  const distance = (listed: string) => Math.abs(Date.parse(listed) - Date.parse(date));
  const nearest = [...others].sort((left, right) => distance(left) - distance(right) || left.localeCompare(right))
    .slice(0, NEAREST_EXPIRIES).sort();
  const more = others.length > nearest.length ? ` (+${others.length - nearest.length} more)` : "";
  const message = dates.includes(date)
    ? `no option contracts returned for ${symbol} expiry ${date}; nearest others: ${nearest.join(", ")}${more}`
    : `no expiry ${date} for ${symbol}; available: ${nearest.join(", ")}${more}`;
  return { message, details: `Run gloomberb options ${symbol} to list every expiry (--json carries them too).` };
}

const EXPIRY_LIST_LIMIT = 40;
const EXPIRY_LIST_WIDTH = 100;
const EXPIRY_GAP = 2;

/** The chain's expiries as compact date lines, nearest first, for picking an `--expiration`. */
export function formatExpiryList(expirations: readonly number[], width = cliTerminalWidth() ?? EXPIRY_LIST_WIDTH): string {
  const dates = listedDates(expirations);
  if (dates.length === 0) return "";
  const shown = dates.slice(0, EXPIRY_LIST_LIMIT);
  const room = Math.max(24, width - 2);
  const hidden = dates.length - shown.length;
  const count = hidden > 0 ? `${dates.length}, nearest ${shown.length} shown, last ${dates.at(-1)}` : String(dates.length);
  return [
    ...wrapText(cliStyles.muted(`Expiries (${count}); pick one with --expiration <date>`), room),
    ...wrapText(shown.join(" ".repeat(EXPIRY_GAP)), room).map((line) => `  ${line}`),
  ].join("\n");
}

/** What a contract's implied volatility and delta are valued from. */
export interface OptionModelInputs {
  /** The underlying's current price; absent when the quote is missing or stale. */
  spot?: number;
  dividendYield?: number;
  now?: number;
}

interface OptionModelFigures {
  /** Annualized volatility as a fraction, solved from the chain's quotes. */
  iv: number | null;
  delta: number | null;
}

/** The risk-free rate every options valuation in the app assumes. */
export const OPTION_MODEL_RATE = DEFAULT_OPTION_CALC_DRAFT.rate;

/**
 * IV and delta per contract, from the same solver and Greeks as the options
 * pane (put-call parity forward, one volatility per strike, the pane's rate).
 * The provider's own IV is not used: it is a placeholder on many contracts.
 * Each expiry is valued on its own, as the pane does. A contract that cannot be
 * valued (no current spot, expired, no two-sided market) has nulls, never zeros.
 */
function optionModelFigures(chain: OptionsChain, inputs: OptionModelInputs): Map<OptionContract, OptionModelFigures> {
  const figures = new Map<OptionContract, OptionModelFigures>();
  const expirations = new Set([...chain.calls, ...chain.puts].map((contract) => contract.expiration));
  for (const expiration of expirations) {
    const slice: OptionsChain = {
      ...chain,
      calls: chain.calls.filter((contract) => contract.expiration === expiration),
      puts: chain.puts.filter((contract) => contract.expiration === expiration),
    };
    const volatilities = solveChainVolatilities(slice, inputs.spot, inputs.dividendYield, inputs.now);
    for (const [side, contracts] of [["call", slice.calls], ["put", slice.puts]] as const) {
      for (const contract of contracts) {
        const volatility = volatilities.byStrike.get(contract.strike);
        const delta = calculateOptionGreeks(contract, side, inputs.spot, inputs.dividendYield, volatilities)?.delta;
        figures.set(contract, {
          iv: volatility != null && Number.isFinite(volatility) && volatility > 0 ? volatility : null,
          delta: delta != null && Number.isFinite(delta) ? delta : null,
        });
      }
    }
  }
  return figures;
}

/** The chain with each contract's modeled `iv` and `delta` added; every provider field is kept. */
export function chainWithModelFigures(chain: OptionsChain, inputs: OptionModelInputs): OptionsChain {
  const figures = optionModelFigures(chain, inputs);
  const add = (contract: OptionContract) => ({ ...contract, iv: figures.get(contract)?.iv ?? null, delta: figures.get(contract)?.delta ?? null });
  return { ...chain, calls: chain.calls.map(add), puts: chain.puts.map(add) };
}

export function optionRows(chain: OptionsChain) {
  const contracts = [
    ...chain.calls.map((contract) => ({ side: "call", contract })),
    ...chain.puts.map((contract) => ({ side: "put", contract })),
  ];
  return contracts.map(({ side, contract }) => {
    const modeled = contract as OptionContract & Partial<OptionModelFigures>;
    return {
      side,
      contract: contract.contractSymbol,
      strike: contract.strike,
      last: contract.lastPrice,
      bid: contract.bid,
      ask: contract.ask,
      volume: contract.volume,
      openInterest: contract.openInterest,
      iv: modeled.iv ?? null,
      delta: modeled.delta ?? null,
      expiration: utcDate(contract.expiration),
    };
  });
}

export function formatOptionQuoteCell(row: Record<string, unknown>, side: "bid" | "ask"): string {
  const quote = optionQuoteSide({ bid: Number(row.bid), ask: Number(row.ask) }, side);
  return quote == null ? "—" : String(quote);
}

/** Implied volatility as a percent; a dash when it could not be solved, never 0.0%. */
export function formatOptionIvCell(value: unknown): string {
  return isFiniteNumber(value) && value > 0 ? `${(value * 100).toFixed(1)}%` : "—";
}

/** Delta to two places, signed for puts; a dash when it could not be valued, and no "-0.00" for a far wing. */
export function formatOptionDeltaCell(value: unknown): string {
  if (!isFiniteNumber(value)) return "—";
  const text = value.toFixed(2);
  return text === "-0.00" ? "0.00" : text;
}
