import type { OptionContract, OptionsChain, Quote } from "../../types/financials";
import type { DataProvider } from "../../types/data-provider";
import type { CliListing } from "../listing-arg";
import { cliStyles, cliTerminalWidth, wrapText } from "../../utils/cli-output";
import { isFiniteNumber } from "../../utils/guards";
import { calculateOptionGreeks, solveChainVolatilities } from "../../plugins/builtin/options/analytics";
import { optionQuoteSide } from "../../plugins/builtin/options/market-reference";
import { DEFAULT_OPTION_CALC_DRAFT } from "../../plugins/builtin/options-calculator/model";
import { expiryIsoDate, missingExpiryText, parseOptionExpiration } from "../../utils/option-expiry";

export const OPTIONS_USAGE = "options <symbol> [--expiration <YYYY-MM-DD|unix>]";

export { parseOptionExpiration };

/** Whether the chain holds contracts of the requested expiry, matched by UTC calendar date as the chain stamps them. */
export function chainHasExpiry(chain: OptionsChain, requested: number): boolean {
  const date = expiryIsoDate(requested);
  return [...chain.calls, ...chain.puts].some((contract) => expiryIsoDate(contract.expiration) === date);
}

/** Every listed expiry as a unique, ascending UTC date. */
function listedDates(expirations: readonly number[]): string[] {
  return [...new Set(expirations.map((expiration) => expiryIsoDate(expiration)).filter(Boolean))].sort();
}

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
  return {
    message: missingExpiryText(requested, expirations, symbol),
    details: `Run gloomberb options ${symbol} to list every expiry (--json carries them too).`,
  };
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

/** Spot and dividend yield for IV and delta, read from the underlying the way the options pane does; missing ones stay missing. */
export async function loadOptionModelInputs(
  dataProvider: Pick<DataProvider, "getTickerFinancials">,
  listing: CliListing,
  quote: Promise<Quote | null>,
  refresh: boolean,
): Promise<OptionModelInputs> {
  const financials = await Promise.resolve().then(() => dataProvider.getTickerFinancials(
    listing.request.symbol, listing.request.exchange, { cacheMode: refresh ? "refresh" : "default" },
  )).catch(() => null);
  const current = [await quote, financials?.quote]
    .find((candidate) => candidate && candidate.stale !== true && isFiniteNumber(candidate.price) && candidate.price > 0);
  const dividendYield = financials?.fundamentals?.dividendYield;
  return {
    ...(current ? { spot: current.price } : {}),
    ...(isFiniteNumber(dividendYield) && dividendYield >= 0 ? { dividendYield } : {}),
  };
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
      expiration: expiryIsoDate(contract.expiration),
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
