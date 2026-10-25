import { logFailure } from "../../utils/log-failure";
import type { OptionContract, OptionsChain, Quote, TickerFinancials } from "../../types/financials";
import type { DataProvider } from "../../types/data-provider";
import type { CliListing } from "../listing-arg";
import { cliStyles, cliTerminalWidth, wrapText } from "../../utils/cli-output";
import { isFiniteNumber } from "../../utils/guards";
import { calculateOptionGreeks, ivSolvedNote, solveChainVolatilities } from "../../plugins/builtin/options/analytics";
import { optionQuoteSide } from "../../plugins/builtin/options/market-reference";
import {
  formatModelSpotPrice, modelSpotLabel, optionModelSpot, type OptionModelSpot,
} from "../../plugins/builtin/options/model-spot";
import {
  chainOpenInterestAsOf, loadListedOpenInterest, openInterestAsOfLabel, type OpenInterestAsOf, statedOpenInterestAsOf,
} from "../../plugins/builtin/options/open-interest-as-of";
import { DEFAULT_OPTION_CALC_DRAFT } from "../../plugins/builtin/options-calculator/model";
import { expiryIsoDate, OPTION_EXPIRATION_PLACEHOLDER, parseOptionExpiration, settlementStampTime } from "../../utils/option-expiry";
import { loadModelDividendYield } from "../../market-data/model-dividend-yield";
import { formatUtcTime } from "../../utils/utc-time";

export const OPTIONS_USAGE = `options <symbol> [--expiration <${OPTION_EXPIRATION_PLACEHOLDER}>]`;

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
  /** The quote `spot` is read from, for the spot the chain is valued at (`optionModelSpot`). */
  quote?: Quote;
  dividendYield?: number;
  now?: number;
}

interface OptionModelFigures {
  /** Annualized volatility as a fraction, solved from the chain's quotes. */
  iv: number | null;
  /** `iv` was read off the neighbouring strikes: this strike has no two-sided out-of-the-money quote to solve from. */
  ivFilled?: boolean;
  delta: number | null;
}

/** The risk-free rate every options valuation in the app assumes. */
export const OPTION_MODEL_RATE = DEFAULT_OPTION_CALC_DRAFT.rate;

/** The venue's own marks a chain carries (Deribit's), stated in its JSON metadata in place of OPTION_VOLATILITY_FIELDS. */
export const MARKED_OPTION_FIELDS = {
  iv: "The venue's mark implied volatility (decimal), one per contract. Delta and the other greeks under mark are the venue's too: "
    + "Black-76 at the expiry's forward with no discounting, to its settlement.",
  ivSource: "mark: iv is the venue's own, never solved or filled here.",
  bid: "Prices in USD are the coin prices (coin) at the expiry's forward (mark.forward), the venue's own model price.",
  mark: "price in USD; iv; delta and gamma per 1.00 move in the underlying; vega per volatility point and theta per calendar day, in USD.",
} as const;

/** Whether a venue marks the chain's contracts itself (Deribit): its IV and greeks are then used as they are. */
export function isMarkedChain(chain: OptionsChain): boolean {
  return [...chain.calls, ...chain.puts].some((contract) => contract.mark != null);
}

/** The coin a chain's premiums are quoted in (BTC), when a venue quotes them in one. */
export function chainCoinCurrency(chain: OptionsChain): string | null {
  return [...chain.calls, ...chain.puts].find((contract) => contract.coin)?.coin?.currency ?? null;
}

/** What each contract's two volatilities are, stated in the chain's JSON metadata so neither is read as the other. */
export const OPTION_VOLATILITY_FIELDS = {
  iv: "Annualized volatility (decimal) solved from the quote midpoint, one per strike from its out-of-the-money side, at the "
    + "spot, valuation time and rate in metadata.model. Delta here and dealer gamma (GEX) are valued with it.",
  ivSource: "solved: iv comes from the strike's out-of-the-money quote midpoint. filled: that side has no two-sided quote, so iv is read off the "
    + "nearest solved strikes (flat beyond the last one); it is no market's volatility, and delta is valued with it all the same.",
  impliedVolatility: "The data provider's own reported implied volatility, passed through unchanged. Delta does not use it; "
    + "GEX falls back to it only at a strike with no two-sided quote on either side.",
} as const;

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
        const iv = volatility != null && Number.isFinite(volatility) && volatility > 0 ? volatility : null;
        figures.set(contract, {
          iv, ivFilled: iv != null && volatilities.filled.has(contract.strike),
          delta: delta != null && Number.isFinite(delta) ? delta : null,
        });
      }
    }
  }
  return figures;
}

/** The underlying's financials, as DES reads them: its dividend yield, ex-dividend date and next report. Null when they cannot be read. */
export function loadUnderlyingFinancials(
  dataProvider: Pick<DataProvider, "getTickerFinancials">,
  listing: CliListing,
  refresh: boolean,
): Promise<TickerFinancials | null> {
  return Promise.resolve().then(() => dataProvider.getTickerFinancials(
    listing.request.symbol, listing.request.exchange, { cacheMode: refresh ? "refresh" : "default" },
  )).catch(logFailure("cli.commands-options-chain", "Read option underlying financials failed", null));
}

/**
 * Spot and dividend yield for IV and delta, read from the underlying the way the
 * options pane does; missing ones stay missing. The dividend yield is any the
 * fundamentals state, stale or not, else, as OSA reads it
 * (`loadModelDividendYield`), 0 for a history with no dividend paid, and 0
 * for a dividend that stopped.
 * `financials` shares one read of them with a caller that needs more of them.
 */
export async function loadOptionModelInputs(
  dataProvider: Pick<DataProvider, "getTickerFinancials" | "getCorporateActions">,
  listing: CliListing,
  quote: Promise<Quote | null>,
  refresh: boolean,
  underlying: Promise<TickerFinancials | null> = loadUnderlyingFinancials(dataProvider, listing, refresh),
): Promise<OptionModelInputs> {
  const financials = await underlying;
  const current = [await quote, financials?.quote]
    .find((candidate) => candidate && candidate.stale !== true && isFiniteNumber(candidate.price) && candidate.price > 0);
  const { symbol, exchange } = listing.request;
  const dividend = await loadModelDividendYield(financials?.fundamentals, symbol,
    dataProvider.getCorporateActions ? () => dataProvider.getCorporateActions!(symbol, exchange) : null);
  return {
    ...(current ? { spot: current.price, quote: current } : {}),
    ...(dividend ? { dividendYield: dividend.value } : {}),
  };
}

/** The chain with each contract's modeled `iv` and `delta` added; every provider field is kept. */
export function chainWithModelFigures(chain: OptionsChain, inputs: OptionModelInputs): OptionsChain {
  const figures = optionModelFigures(chain, inputs);
  const add = (contract: OptionContract) => ({ ...contract, iv: figures.get(contract)?.iv ?? null, ivFilled: figures.get(contract)?.ivFilled ?? false,
    delta: figures.get(contract)?.delta ?? null });
  return { ...chain, calls: chain.calls.map(add), puts: chain.puts.map(add) };
}

/**
 * What a chain's IV, delta and open interest are as of: the spot and instant
 * they are valued at, and the session the open interest counts. The rows and
 * the closing lines of every format say it.
 */
export interface OptionsChainBasis {
  spot: OptionModelSpot | null;
  dividendYield: number | null;
  openInterest: OpenInterestAsOf | null;
  /** A strike's IV is filled from its neighbours (`chainHasFilledIv`), which the closing line says. */
  ivFilled?: boolean;
}

/** Whether any contract's IV was read off the neighbouring strikes (see `ChainVolatilities.filled`). */
export function chainHasFilledIv(chain: OptionsChain): boolean {
  return [...chain.calls, ...chain.puts].some((contract) => (contract as OptionContract & OptionModelFigures).ivFilled === true);
}

/** The chain with `iv` and `delta` valued at the spot `optionModelSpot` picks for it, and that spot. */
export function valueChainAtModelSpot(
  chain: OptionsChain, inputs: OptionModelInputs, now: number, exchange?: string,
): { chain: OptionsChain; spot: OptionModelSpot | null } {
  const spot = optionModelSpot(inputs.quote, chain, now, exchange);
  return {
    chain: chainWithModelFigures(chain, spot ? { spot: spot.price, dividendYield: inputs.dividendYield, now: spot.valuationTime } : inputs),
    spot,
  };
}

/**
 * The open-interest date of the chain's expiry: the chain's own, else (a chain
 * that does not say) from OPX's listing of it; null when the listing cannot be read.
 */
export async function loadOptionsChainOpenInterest(symbol: string, chain: OptionsChain): Promise<OpenInterestAsOf | null> {
  const stated = statedOpenInterestAsOf(chain);
  if (stated) return stated;
  const expiration = [...chain.calls, ...chain.puts][0]?.expiration;
  if (expiration == null) return null;
  const payload = await loadListedOpenInterest(symbol, expiryIsoDate(expiration));
  return payload ? chainOpenInterestAsOf(chain, payload) : null;
}

/**
 * The line under the chain: `Greeks at spot 89.79 (close Mon 12 Oct 20:00 UTC), dividend yield 2.34%, rate 4% · IV solved from quote mids ·
 * OI as of Fri 9 Oct`, with `, ~ filled from neighbouring strikes` after the IV when a strike has no quote to solve from.
 * An open interest whose date cannot be established says why. A chain its
 * venue marks says whose marks they are: `Deribit marks: IV and greeks at
 * each expiry's forward, rate 0%; $ is the BTC price at the forward · OI live, Thu 22 Oct 22:42 UTC`.
 */
export function optionsBasisFootnote(basis: OptionsChainBasis, chain?: OptionsChain): string {
  const parts: string[] = [];
  if (chain && isMarkedChain(chain)) {
    const coin = chainCoinCurrency(chain);
    parts.push(`${chain.venue ?? "Venue"} marks: IV and greeks at each expiry's forward, rate ${Number(((chain.rate ?? 0) * 100).toFixed(2))}%`
      + (coin ? `; $ is the ${coin} price at the forward` : ""));
    // Its expiries settle at a stated time (08:00 UTC), which the expiration stamps carry.
    const settles = [...chain.calls, ...chain.puts].map((contract) => settlementStampTime(contract.expiration)).find(Boolean);
    if (settles) parts.push(`expiries settle ${settles}`);
    const asOf = chain.asOf ? Date.parse(chain.asOf) : Number.NaN;
    parts.push(Number.isFinite(asOf) ? `OI live, ${formatUtcTime(new Date(asOf).toISOString())}` : openInterestAsOfLabel(basis.openInterest));
    return parts.join(" · ");
  }
  if (basis.spot) {
    parts.push(`Greeks at spot ${formatModelSpotPrice(basis.spot.price)} (${modelSpotLabel(basis.spot)}), `
      // An unknown yield is valued as none, and says so rather than read as a stated 0%.
      + `dividend yield ${basis.dividendYield == null ? "unknown (valued at 0%)" : `${Number((basis.dividendYield * 100).toFixed(2))}%`}, `
      + `rate ${Number((OPTION_MODEL_RATE * 100).toFixed(2))}%`);
    parts.push(ivSolvedNote(basis.ivFilled === true));
  }
  const oi = basis.openInterest;
  parts.push(oi?.date ? openInterestAsOfLabel(oi)
    : oi?.listedDate && oi.compared > 0
      ? `OI date not published: the counts differ from OPX's ${oi.listedDate} counts on ${oi.compared - oi.matched} of ${oi.compared} contracts`
      : openInterestAsOfLabel(null));
  return parts.join(" · ");
}

/** The spot and open-interest fields every exported row carries. */
export function optionsBasisFields(basis: OptionsChainBasis) {
  return {
    spot: basis.spot?.price ?? null,
    spotBasis: basis.spot ? basis.spot.basis === "close" ? "close" : basis.spot.session ?? "last" : null,
    spotAsOf: basis.spot ? new Date(basis.spot.observedAt).toISOString() : null,
    openInterestAsOf: basis.openInterest?.date ?? null,
  };
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
      // Solved from the strike's quote, or filled from its neighbours when it has none to solve from; a venue's own mark is neither.
      ivSource: modeled.iv == null ? null : contract.mark ? "mark" : modeled.ivFilled ? "filled" : "solved",
      delta: modeled.delta ?? null,
      expiration: expiryIsoDate(contract.expiration),
      // A venue's marks and coin prices (Deribit), beside the dollar ones.
      ...(contract.mark ? {
        mark: contract.mark.price, gamma: contract.mark.gamma, vega: contract.mark.vega, theta: contract.mark.theta,
        forward: contract.mark.forward, expiresAt: new Date(contract.expiration * 1000).toISOString(),
      } : {}),
      ...(contract.coin ? {
        coinCurrency: contract.coin.currency, coinBid: contract.coin.bid, coinAsk: contract.coin.ask,
        coinMark: contract.coin.mark, coinLast: contract.coin.last,
      } : {}),
    };
  });
}

/** A premium in a coin, to the venue's tick (0.0001 BTC); a dash for none. */
export function formatCoinPremiumCell(value: unknown): string {
  return isFiniteNumber(value) && value > 0 ? value.toFixed(4) : "—";
}

/** A dollar greek or mark (vega, theta, mark) to cents; a dash for none. */
export function formatOptionDollarCell(value: unknown): string {
  return isFiniteNumber(value) ? value.toFixed(2) : "—";
}

/** Gamma per 1.00 move, tiny for a coin worth 80,000 dollars: to six places, as the venue shows it to five. */
export function formatOptionGammaCell(value: unknown): string {
  return isFiniteNumber(value) ? value.toFixed(6) : "—";
}

export function formatOptionQuoteCell(row: Record<string, unknown>, side: "bid" | "ask"): string {
  const quote = optionQuoteSide({ bid: Number(row.bid), ask: Number(row.ask) }, side);
  return quote == null ? "—" : String(quote);
}

/** Implied volatility as a percent; a dash when it could not be solved, never 0.0%, and a leading "~" when it was filled from neighbouring strikes. */
export function formatOptionIvCell(value: unknown, row?: Record<string, unknown>): string {
  if (!isFiniteNumber(value) || !(value > 0)) return "—";
  const text = `${(value * 100).toFixed(1)}%`;
  return row?.ivSource === "filled" ? `~${text}` : text;
}

/** Delta to two places, signed for puts; a dash when it could not be valued, and no "-0.00" for a far wing. */
export function formatOptionDeltaCell(value: unknown): string {
  if (!isFiniteNumber(value)) return "—";
  const text = value.toFixed(2);
  return text === "-0.00" ? "0.00" : text;
}
