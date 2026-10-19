import type { Quote } from "../../../types/financials";
import type { BrokerContractRef } from "../../../types/instrument";
import type { BrokerOrderLeg, BrokerOrderRequest } from "../../../types/trading";
import { chainOptionContract, formatExpDate, optionContractIdentity } from "../../../utils/options";

type Side = "BUY" | "SELL";

/** A strategy leg as a builder holds it: an OCC contract, signed contracts, and a premium per share to tell debit from credit. */
export interface StrategyLegInput { contractSymbol: string; quantity: number; price?: number }

/** A leg a ticket opens with, before it is bound to a broker profile. */
export interface StrategyIntentLeg { contractSymbol: string; action: Side; ratio: number }

export interface StrategyIntent { action: Side; quantity: number; legs: StrategyIntentLeg[] }

/** The most legs any broker's multi-leg order takes. */
export const MAX_STRATEGY_LEGS = 4;

const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
const flip = (action: Side): Side => action === "BUY" ? "SELL" : "BUY";

/**
 * A builder's legs as one order: each leg keeps its side, the common factor of
 * the contract counts becomes the spread quantity, and the entry premiums say
 * whether opening it pays a debit (BUY) or receives a credit (SELL). Null when
 * a quantity is not a whole number of contracts.
 */
export function strategyFromLegs(inputs: readonly StrategyLegInput[]): StrategyIntent | null {
  const legs = inputs.filter((leg) => leg.quantity !== 0);
  if (!legs.length || legs.some((leg) => !Number.isSafeInteger(leg.quantity) || !leg.contractSymbol.trim())) return null;
  const quantity = legs.map((leg) => Math.abs(leg.quantity)).reduce(gcd);
  const net = legs.every((leg) => Number.isFinite(leg.price)) ? legs.reduce((sum, leg) => sum + leg.quantity * leg.price!, 0) : 0;
  return {
    action: net < 0 ? "SELL" : "BUY", quantity,
    legs: legs.map((leg) => ({ contractSymbol: leg.contractSymbol.trim().toUpperCase(), action: leg.quantity > 0 ? "BUY" : "SELL", ratio: Math.abs(leg.quantity) / quantity })),
  };
}

/** The opposite trade: every leg the other way, and a debit becomes a credit. */
export function reverseStrategy<T extends { action: Side; legs?: readonly { action: Side }[] }>(order: T): T {
  return { ...order, action: flip(order.action), ...(order.legs ? { legs: order.legs.map((leg) => ({ ...leg, action: flip(leg.action) })) } : {}) };
}

/** The order's contract: the underlying's symbol on the same profile, as a combo. */
export function strategyContract(underlying: BrokerContractRef, currency?: string): BrokerContractRef {
  return { brokerId: underlying.brokerId, ...(underlying.brokerInstanceId ? { brokerInstanceId: underlying.brokerInstanceId } : {}),
    symbol: underlying.symbol.trim().toUpperCase(), secType: "BAG", exchange: "SMART", currency: currency || underlying.currency || "USD", multiplier: "100" };
}

/** Binds a strategy's legs to the underlying's broker profile; null when one is not a listed contract of that underlying. */
export function strategyOrderLegs(legs: readonly StrategyIntentLeg[], underlying: BrokerContractRef, currency?: string): BrokerOrderLeg[] | null {
  const bound = legs.map((leg) => {
    const contract = chainOptionContract(leg.contractSymbol, underlying, currency || underlying.currency || "USD");
    return contract && contract.symbol === underlying.symbol.trim().toUpperCase() ? { contract, action: leg.action, ratio: leg.ratio } : null;
  });
  return bound.every((leg): leg is BrokerOrderLeg => leg !== null) ? bound : null;
}

export function isStrategyOrder(order: { contract: BrokerContractRef; legs?: readonly unknown[] }): boolean {
  return !!order.legs?.length || order.contract.secType?.toUpperCase() === "BAG";
}

/**
 * The spread's quote from its legs' quotes, as the debit side reads it: bid is
 * what selling one spread receives at once, ask what buying one pays. A credit
 * order sells that debit spread, so it reads the bid, as a sell does.
 */
export function strategyQuote(request: Pick<BrokerOrderRequest, "action" | "legs" | "contract">, quotes: readonly (Quote | undefined)[]): Quote | null {
  const legs = request.legs ?? [];
  if (!legs.length || quotes.length !== legs.length) return null;
  let bid = 0, ask = 0;
  for (const [index, leg] of legs.entries()) {
    const quote = quotes[index];
    if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) return null;
    // The debit side buys what a BUY order buys, and buys back what a SELL order sells.
    const buys = (leg.action === "BUY") === (request.action === "BUY");
    bid += buys ? leg.ratio * quote.bid! : -leg.ratio * quote.ask!;
    ask += buys ? leg.ratio * quote.ask! : -leg.ratio * quote.bid!;
  }
  const round = (value: number) => Math.round(value * 1e6) / 1e6;
  const present = quotes as Quote[];
  return {
    symbol: request.contract.symbol, name: strategyName(legs), price: round((bid + ask) / 2), bid: round(bid), ask: round(ask),
    change: NaN, changePercent: NaN, currency: request.contract.currency ?? present[0]!.currency,
    lastUpdated: Math.min(...present.map((quote) => quote.lastUpdated)),
    dataSource: present.every((quote) => quote.dataSource === "live") ? "live" : "delayed",
    stale: present.some((quote) => quote.stale === true), marketState: present[0]!.marketState,
  };
}

interface ParsedLeg { underlying: string; expiry: string; right: "C" | "P"; strike: number; action: Side; ratio: number }

function parseLeg(leg: { contract?: BrokerContractRef; contractSymbol?: string; action: Side; ratio: number }): ParsedLeg | null {
  const identity = leg.contract ? optionContractIdentity(leg.contract) : optionContractIdentity({ brokerId: "", symbol: leg.contractSymbol ?? "", secType: "OPT" });
  const [underlying, expiry, right, strike] = identity?.split("|") ?? [];
  return underlying && expiry && (right === "C" || right === "P") ? { underlying, expiry, right, strike: Number(strike), action: leg.action, ratio: leg.ratio } : null;
}

type NamedLeg = { contract?: BrokerContractRef; contractSymbol?: string; action: Side; ratio: number };

/** "AAPL call vertical", "SPY iron condor", or "AAPL 3-leg spread" when the shape has no common name. */
export function strategyName(legs: readonly NamedLeg[]): string {
  const underlying = parseLeg(legs[0] ?? { action: "BUY", ratio: 1 })?.underlying;
  return [underlying, strategyShape(legs)].filter(Boolean).join(" ");
}

/** The shape alone, for a list already on its underlying: "call vertical". */
export function strategyShape(legs: readonly NamedLeg[]): string {
  const parsed = legs.map(parseLeg);
  const named = (shape: string) => shape;
  if (parsed.some((leg) => !leg) || new Set(parsed.map((leg) => leg!.underlying)).size > 1) return named(`${legs.length}-leg spread`);
  const all = parsed as ParsedLeg[];
  const same = <K extends keyof ParsedLeg>(key: K, set = all) => new Set(set.map((leg) => leg[key])).size === 1;
  const right = (leg: ParsedLeg) => leg.right === "C" ? "call" : "put";
  const [a, b] = all;
  if (all.length === 2 && a && b) {
    const opposite = a.action !== b.action;
    if (same("right") && opposite && a.ratio !== b.ratio && same("expiry")) return named(`${right(a)} ratio spread`);
    if (same("right") && opposite && same("expiry")) return named(`${right(a)} vertical`);
    if (same("right") && opposite && same("strike")) return named(`${right(a)} calendar`);
    if (same("right") && opposite) return named(`${right(a)} diagonal`);
    if (!same("right") && !opposite && same("expiry")) return named(same("strike") ? "straddle" : "strangle");
  }
  if (all.length === 3 && same("right") && same("expiry")) {
    const [low, middle, high] = all.toSorted((x, y) => x.strike - y.strike);
    if (low && middle && high && low.action === high.action && middle.action !== low.action && middle.ratio === low.ratio + high.ratio
      && Math.abs(middle.strike - low.strike - (high.strike - middle.strike)) < 1e-9) return named(`${right(low)} butterfly`);
  }
  if (all.length === 4 && same("expiry") && all.filter((leg) => leg.right === "C").length === 2) {
    const calls = all.filter((leg) => leg.right === "C").toSorted((x, y) => x.strike - y.strike);
    const puts = all.filter((leg) => leg.right === "P").toSorted((x, y) => x.strike - y.strike);
    // Short the inner strikes, long the wings (or the reverse): the two verticals of an iron condor.
    if (calls[0]!.action !== calls[1]!.action && puts[0]!.action !== puts[1]!.action && calls[0]!.action === puts[1]!.action
      && puts[1]!.strike <= calls[0]!.strike) return named(puts[1]!.strike === calls[0]!.strike ? "iron butterfly" : "iron condor");
  }
  return named(`${all.length}-leg spread`);
}

/** "Buy 1 · Oct 26 '26 345 Call": a leg's side, contracts per spread times the spread count, and its contract. */
export function strategyLegLabel(leg: BrokerOrderLeg, spreads = 1): { side: string; contracts: string; contract: string } {
  const parsed = parseLeg(leg);
  const contracts = Number.isFinite(spreads) && spreads > 0 ? leg.ratio * spreads : leg.ratio;
  if (!parsed) return { side: leg.action === "BUY" ? "Buy" : "Sell", contracts: String(contracts), contract: leg.contract.localSymbol || leg.contract.symbol };
  const expiry = formatExpDate(Date.UTC(Number(parsed.expiry.slice(0, 4)), Number(parsed.expiry.slice(4, 6)) - 1, Number(parsed.expiry.slice(6, 8))) / 1000);
  const strike = parsed.strike.toLocaleString("en-US", { maximumFractionDigits: 3 });
  return { side: leg.action === "BUY" ? "Buy" : "Sell", contracts: String(contracts), contract: `${expiry} ${strike} ${parsed.right === "C" ? "Call" : "Put"}` };
}

/** An order's instrument in a row or toast: the strategy's name for a spread, else the contract's symbol. */
export function orderInstrumentLabel(order: { contract: BrokerContractRef; legs?: readonly BrokerOrderLeg[] }): string {
  if (order.legs?.length) return strategyName(order.legs);
  return order.contract.secType?.toUpperCase() === "BAG" ? `${order.contract.symbol} spread` : order.contract.localSymbol || order.contract.symbol;
}
