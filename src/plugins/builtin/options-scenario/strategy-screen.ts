import type { InstrumentRef } from "../../../market-data/request-types";
import type { OptionsChain } from "../../../types/financials";
import { expiryIsoDate } from "../../../utils/option-expiry";
import { probabilityAbove } from "../shared/volatility";
import {
  loadScenarioMarket, nearestDeltaContract, seededLeg, seedScreenPosition,
  type QuotedChain, type QuotedContract, type ScenarioLoaderDependencies, type ScenarioMarketSnapshot, type ScreenSeed, type StrategyPricing,
  type UnusableChainText,
} from "./client";
import { calendarDaysToExpiry, earningsBeforeExpiry, type CspEarnings } from "./csp";
import {
  cspTargetDate, loadScreenMarket, nearestListedExpiry, readCspScreenCriteria, readNumber, screenNames, supplied,
  type CspScreen, type CspScreenCriteria, type CspScreenDependencies,
} from "./csp-screen";
import { seededLegQuotes } from "./hedge";
import { expiryRisk, optionExpirationClose, scenarioValue, type ScenarioPosition } from "./model";

/**
 * The options strategy screen (docs/research-data.md#options-strategy-screen):
 * the cash-secured put screen's names, expiry and limits, with each family's
 * legs picked from the chain the way the put is, by delta on the listed expiry
 * nearest the target, entered at their midpoints as OSA's seeds are, and read
 * with OSA's expiry risk.
 */
export const STRATEGY_FAMILIES = ["csp", "covered-call", "bull-put", "bear-call", "bull-call", "bear-put", "iron-condor",
  "short-straddle", "long-straddle", "short-strangle", "long-strangle", "calendar"] as const;
export type StrategyFamily = typeof STRATEGY_FAMILIES[number];
/** Every family but the cash-secured put, which keeps its own screen. */
export type ScreenFamily = Exclude<StrategyFamily, "csp">;

export const STRATEGY_TABS = [
  { value: "csp", label: "Cash-secured put" }, { value: "covered-call", label: "Covered call" }, { value: "vertical", label: "Vertical" },
  { value: "iron-condor", label: "Iron condor" }, { value: "straddle", label: "Straddle" }, { value: "strangle", label: "Strangle" },
  { value: "calendar", label: "Calendar" },
] as const;
export type StrategyTab = typeof STRATEGY_TABS[number]["value"];

export interface StrategyFamilyDef {
  id: StrategyFamily;
  /** The report's title: `Iron condors`. */
  title: string;
  tab: StrategyTab;
  /** Its name among its tab's choices, when the tab has several: `Bull put`. */
  choice?: string;
  /** Other words `--strategy` takes for it. */
  aliases: string[];
  /** The delta its legs are nearest by default; null when it takes the strike nearest the money. */
  delta: number | null;
  /** The delta its legs further out of the money (a vertical's or a condor's wings) are nearest by default; null without them. */
  wing: number | null;
  /**
   * How its rows rank: an income trade's annualised return, a debit trade's
   * reward to risk, or IV rank high or low first.
   */
  rank: "return" | "reward-risk" | "iv-rank-high" | "iv-rank-low";
  /**
   * Whether it takes in premium or pays it. That names its money column and its
   * measure: an income trade's annualised return, a debit trade's reward to risk.
   */
  net: "credit" | "debit";
  /** Which side of the trade its plain words start with. */
  lead: "sell" | "buy";
}

const family = (def: StrategyFamilyDef) => def;
export const STRATEGY_FAMILY_DEFS: readonly StrategyFamilyDef[] = [
  family({ id: "csp", title: "Cash-secured puts", tab: "csp", aliases: ["cash-secured-put"], delta: 0.3, wing: null, rank: "return", net: "credit", lead: "sell" }),
  family({ id: "covered-call", title: "Covered calls", tab: "covered-call", aliases: ["cc", "covered"], delta: 0.3, wing: null, rank: "return", net: "credit", lead: "sell" }),
  family({ id: "bull-put", title: "Bull put spreads", tab: "vertical", choice: "Bull put", aliases: ["put-credit", "bull-put-spread"],
    delta: 0.3, wing: 0.15, rank: "return", net: "credit", lead: "sell" }),
  family({ id: "bear-call", title: "Bear call spreads", tab: "vertical", choice: "Bear call", aliases: ["call-credit", "bear-call-spread"],
    delta: 0.3, wing: 0.15, rank: "return", net: "credit", lead: "sell" }),
  family({ id: "bull-call", title: "Bull call spreads", tab: "vertical", choice: "Bull call", aliases: ["call-debit", "bull-call-spread"],
    delta: 0.5, wing: 0.3, rank: "reward-risk", net: "debit", lead: "buy" }),
  family({ id: "bear-put", title: "Bear put spreads", tab: "vertical", choice: "Bear put", aliases: ["put-debit", "bear-put-spread"],
    delta: 0.5, wing: 0.3, rank: "reward-risk", net: "debit", lead: "buy" }),
  family({ id: "iron-condor", title: "Iron condors", tab: "iron-condor", aliases: ["ic", "condor"], delta: 0.2, wing: 0.1, rank: "return", net: "credit", lead: "sell" }),
  family({ id: "short-straddle", title: "Short straddles", tab: "straddle", choice: "Short", aliases: [], delta: null, wing: null, rank: "iv-rank-high", net: "credit", lead: "sell" }),
  family({ id: "long-straddle", title: "Long straddles", tab: "straddle", choice: "Long", aliases: [], delta: null, wing: null, rank: "iv-rank-low", net: "debit", lead: "buy" }),
  family({ id: "short-strangle", title: "Short strangles", tab: "strangle", choice: "Short", aliases: [], delta: 0.2, wing: null, rank: "iv-rank-high", net: "credit", lead: "sell" }),
  family({ id: "long-strangle", title: "Long strangles", tab: "strangle", choice: "Long", aliases: [], delta: 0.3, wing: null, rank: "iv-rank-low", net: "debit", lead: "buy" }),
  family({ id: "calendar", title: "Call calendars", tab: "calendar", aliases: ["call-calendar", "calendar-spread"], delta: 0.5, wing: null, rank: "reward-risk", net: "debit", lead: "sell" }),
];

export function strategyFamilyDef(id: StrategyFamily): StrategyFamilyDef {
  return STRATEGY_FAMILY_DEFS.find((def) => def.id === id)!;
}

/** The families under a tab, its first one the tab's default. */
export const tabFamilies = (tab: StrategyTab) => STRATEGY_FAMILY_DEFS.filter((def) => def.tab === tab);

/** `--strategy`, by its name or an alias, in any case; the cash-secured put when not set. */
export function readStrategyFamily(value: unknown): StrategyFamily {
  if (!supplied(value)) return "csp";
  const text = String(value).trim().toLowerCase().replaceAll(/[\s_]+/g, "-");
  const def = STRATEGY_FAMILY_DEFS.find((entry) => entry.id === text || entry.aliases.includes(text));
  if (!def) throw new Error(`Invalid --strategy "${String(value)}". Use one of ${STRATEGY_FAMILIES.join(", ")}.`);
  return def.id;
}

/** Calendar days after the sold expiry a calendar's bought one is nearest. */
const CALENDAR_GAP_DAYS = 30;
const DAY_MS = 86_400_000;

export interface StrategyScreenCriteria extends Omit<CspScreenCriteria, "delta"> {
  strategy: ScreenFamily;
  /** The absolute delta the legs are nearest; null for a straddle, which takes the strike nearest the money. */
  delta: number | null;
  /** The absolute delta a vertical's or a condor's legs further out of the money are nearest; null without them. */
  wingDelta: number | null;
}

const deltaExample = "a delta between 0 and 1, such as 0.30";

/**
 * A family's criteria from `fn CSP --strategy` options or the pane's settings:
 * the expiry and the spread limit as the put screen reads them, `--delta` and
 * `--wing-delta` at the family's defaults where not set. A wing's default
 * that is not further out of the money than `--delta` is half of it.
 */
export function readStrategyScreenCriteria(strategy: ScreenFamily, options: Record<string, unknown>): StrategyScreenCriteria {
  const def = strategyFamilyDef(strategy);
  const { days, expiration, maxSpreadPercent } = readCspScreenCriteria({ ...options, delta: undefined });
  if (def.delta == null && supplied(options.delta)) {
    throw new Error(`--delta does not apply to ${def.title.toLowerCase()}: they take the strike nearest the money`);
  }
  if (def.wing == null && supplied(options.wingDelta)) {
    throw new Error(`--wing-delta sets the far legs of a vertical or an iron condor; ${def.title.toLowerCase()} have none`);
  }
  if (def.delta == null) return { strategy, delta: null, wingDelta: null, days, expiration, maxSpreadPercent };
  const delta = supplied(options.delta) ? Math.abs(readNumber(options.delta, "delta", deltaExample)) : def.delta;
  if (!(delta > 0 && delta < 1)) throw new Error(`Invalid --delta "${String(options.delta)}". Use ${deltaExample}.`);
  let wingDelta: number | null = null;
  if (def.wing != null) {
    wingDelta = supplied(options.wingDelta) ? Math.abs(readNumber(options.wingDelta, "wing-delta", "a delta between 0 and 1, such as 0.15"))
      : def.wing < delta ? def.wing : delta / 2;
    if (!(wingDelta > 0 && wingDelta < 1)) throw new Error(`Invalid --wing-delta "${String(options.wingDelta)}". Use a delta between 0 and 1, such as 0.15.`);
    if (!(wingDelta < delta)) {
      throw new Error(`--wing-delta ${wingDelta.toFixed(2)} must be below --delta ${delta.toFixed(2)}: the wings sit further out of the money`);
    }
  }
  return { strategy, delta, wingDelta, days, expiration, maxSpreadPercent };
}

/**
 * Each family's legs from one quoted chain, one contract each: a short side's
 * strike nearest `delta` (a put's as its delta reads without its sign), a
 * vertical's or a condor's far legs nearest `wingDelta` and strictly further
 * out of the money, a straddle at the strike nearest spot quoted on both
 * sides when it is near the money (`straddleReach`), a calendar's call nearest
 * `delta` among the strikes quoted on both expiries, sold on `near` and bought
 * on `far`. `unusable` words a pick the chain has no quote for.
 */
function pickStrategyLegs(
  criteria: Pick<StrategyScreenCriteria, "strategy" | "delta" | "wingDelta">, quoted: QuotedChain, pricing: StrategyPricing,
  unusable: UnusableChainText, near: number, far?: number,
): ScreenSeed {
  const { strategy } = criteria;
  const delta = criteria.delta ?? 0.5;
  const wing = criteria.wingDelta ?? delta / 2;
  const onNear = (list: QuotedContract[]) => list.filter(({ contract }) => contract.expiration === near);
  const calls = onNear(quoted.calls);
  const puts = onNear(quoted.puts);
  const at = (list: QuotedContract[], target: number, what: string) => {
    const picked = nearestDeltaContract(list, list[0]?.side === "put" ? -target : target, pricing.spot, pricing, quoted.parityFor);
    if (!picked) throw new Error(unusable(what));
    return picked;
  };
  const below = (list: QuotedContract[], strike: number) => list.filter(({ contract }) => contract.strike < strike);
  const above = (list: QuotedContract[], strike: number) => list.filter(({ contract }) => contract.strike > strike);
  const strike = (leg: QuotedContract) => strikeText(leg.contract.strike);
  switch (strategy) {
    case "covered-call":
      return { legs: [seededLeg(at(calls, delta, "call to sell"), -1)], shares: 100 };
    case "bull-put": {
      const short = at(puts, delta, "put to sell");
      return { legs: [seededLeg(short, -1), seededLeg(at(below(puts, short.contract.strike), wing, `put to buy below the ${strike(short)} put`), 1)] };
    }
    case "bear-call": {
      const short = at(calls, delta, "call to sell");
      return { legs: [seededLeg(short, -1), seededLeg(at(above(calls, short.contract.strike), wing, `call to buy above the ${strike(short)} call`), 1)] };
    }
    case "bull-call": {
      const long = at(calls, delta, "call to buy");
      return { legs: [seededLeg(long, 1), seededLeg(at(above(calls, long.contract.strike), wing, `call to sell above the ${strike(long)} call`), -1)] };
    }
    case "bear-put": {
      const long = at(puts, delta, "put to buy");
      return { legs: [seededLeg(long, 1), seededLeg(at(below(puts, long.contract.strike), wing, `put to sell below the ${strike(long)} put`), -1)] };
    }
    case "iron-condor": {
      const put = at(puts, delta, "put to sell");
      const call = at(above(calls, put.contract.strike), delta, `call to sell above the ${strike(put)} put`);
      return { legs: [seededLeg(put, -1), seededLeg(call, -1),
        seededLeg(at(below(puts, put.contract.strike), wing, `put to buy below the ${strike(put)} put`), 1),
        seededLeg(at(above(calls, call.contract.strike), wing, `call to buy above the ${strike(call)} call`), 1)] };
    }
    case "short-straddle":
    case "long-straddle": {
      // OSA's straddle: the strike nearest spot that has a call and a put quoted.
      const call = calls.find(({ contract }) => puts.some((put) => put.contract.strike === contract.strike));
      const put = call && puts.find(({ contract }) => contract.strike === call.contract.strike);
      if (!call || !put) throw new Error(unusable("straddle"));
      const reach = straddleReach([...calls, ...puts].map(({ contract }) => contract.strike), pricing.spot);
      if (Math.abs(call.contract.strike - pricing.spot) > reach) {
        throw new Error(`No put and call both quoted within ${reach.toFixed(2)} of spot ${pricing.spot.toFixed(2)}: `
          + `the nearest is the ${strike(call)} strike`);
      }
      const quantity = strategy === "short-straddle" ? -1 : 1;
      return { legs: [seededLeg(put, quantity), seededLeg(call, quantity)] };
    }
    case "short-strangle":
    case "long-strangle": {
      const quantity = strategy === "short-strangle" ? -1 : 1;
      const verb = quantity < 0 ? "sell" : "buy";
      const put = at(puts, delta, `put to ${verb}`);
      return { legs: [seededLeg(put, quantity), seededLeg(at(above(calls, put.contract.strike), delta, `call to ${verb} above the ${strike(put)} put`), quantity)] };
    }
    case "calendar": {
      // Only a strike quoted on both expiries can be sold on one and bought on the other.
      const later = new Map(quoted.calls.filter(({ contract }) => contract.expiration === far).map((call) => [call.contract.strike, call]));
      const sold = at(calls.filter(({ contract }) => later.has(contract.strike)), delta,
        `call to sell at a strike also quoted on ${far == null ? "a later expiry" : expiryIsoDate(far)}`);
      return { legs: [seededLeg(sold, -1), seededLeg(later.get(sold.contract.strike)!, 1)] };
    }
  }
}

/** A straddle's strike is at the money when it is this share of spot from it, or half a strike step where strikes are wider. */
const STRADDLE_REACH = 0.025;

/**
 * How far from spot a straddle's strike may sit: 2.5% of spot, or half the
 * usual step between the quoted strikes where they are listed wider apart, so
 * a chain whose strikes near the money are missing quotes skips the name
 * rather than trade a strike well away from it.
 */
function straddleReach(strikes: readonly number[], spot: number): number {
  const sorted = [...new Set(strikes)].sort((a, b) => a - b);
  const steps = sorted.slice(1).map((value, index) => value - sorted[index]!).sort((a, b) => a - b);
  const step = steps.length ? steps[Math.floor(steps.length / 2)]! : 0;
  return Math.max(spot * STRADDLE_REACH, step / 2);
}

/** A strike as a trader says it: `92.5`, `105`. */
const strikeText = (value: number) => String(Number(value.toFixed(4)));
const legExpiry = (expiration: number) => new Date(expiration * 1000).toISOString().slice(0, 10);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `Dec 18`: a later leg's expiry, the row's own being its DTE. */
const monthDay = (expiration: number) => {
  const date = new Date(expiration * 1000);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
};

/**
 * The trade in plain words, one part per side, the side the family leads
 * with first, each leg its strike and `p` or `c`: `Sell 95p`, `buy 90p`;
 * `Sell 105c`, `buy 100 shares`; `Sell 95p/105c`, `buy 90p/110c`. A leg on a
 * later expiry than the row's names it: a calendar's `buy Dec 18 95c`.
 */
function strategyTradeParts(strategy: StrategyFamily, position: Pick<ScenarioPosition, "legs" | "underlying">): string[] {
  const first = Math.min(...position.legs.map((leg) => leg.expiration));
  const name = (leg: ScenarioPosition["legs"][number]) =>
    `${leg.expiration === first ? "" : `${monthDay(leg.expiration)} `}${strikeText(leg.strike)}${leg.side === "put" ? "p" : "c"}`;
  const sides = {
    sell: position.legs.filter((leg) => leg.quantity < 0).map(name),
    buy: [...(position.underlying ? [`${position.underlying.quantity} shares`] : []), ...position.legs.filter((leg) => leg.quantity > 0).map(name)],
  };
  const order = strategyFamilyDef(strategy).lead === "sell" ? ["sell", "buy"] as const : ["buy", "sell"] as const;
  return order.filter((side) => sides[side].length)
    .map((side, index) => `${index ? side : side === "sell" ? "Sell" : "Buy"} ${sides[side].join("/")}`);
}

/** The trade in plain words, its parts in one line: `Sell 95p/105c · buy 90p/110c`. */
const strategyTradeText = (strategy: StrategyFamily, position: Pick<ScenarioPosition, "legs" | "underlying">) =>
  strategyTradeParts(strategy, position).join(" · ");

const finite = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value);

export interface StrategyTrade {
  strategy: ScreenFamily;
  position: ScenarioPosition;
  /** The legs in plain words, the side the family leads with first: `Sell 95p/105c · buy 90p/110c`. */
  text: string;
  /** The first expiry, YYYY-MM-DD: when the trade is read. */
  expiry: string;
  /** A calendar's bought expiry; null for the rest. */
  farExpiry: string | null;
  daysToExpiry: number;
  /** Valuation date in New York, YYYY-MM-DD. */
  valuationDate: string;
  /** The spot the option quotes imply, which the trade is valued from. */
  spot: number;
  /** Per share: the options' premium at their midpoints, taken in when positive, paid when negative. */
  net: number;
  /** The same premium for one contract a leg, in currency, as OSA counts money: what the Credit or Debit column shows. */
  netAmount: number;
  /** In currency for one contract a leg; null when unlimited. */
  maxGain: number | null;
  maxLoss: number | null;
  /** Which side has no limit: a long straddle's gain, a short one's loss. */
  unlimited: "gain" | "loss" | null;
  breakEvens: number[];
  probabilityOfProfit: number | null;
  /**
   * An income trade's return to expiry: max gain over max loss, or for a short
   * straddle or strangle, whose loss has no limit, the credit over the cash
   * that secures its put (the put screen's yield on cash). Null for a debit trade.
   */
  returnToExpiry: number | null;
  /** Return to expiry x 365 / days to expiry; null on the expiry day. */
  annualizedReturn: number | null;
  /** A debit trade's max gain over its max loss; null for an income trade, an unlimited gain, or nothing at risk. */
  rewardToRisk: number | null;
  /** The legs' spreads added up and over the net midpoint; null when a leg has no two-sided quote. */
  quote: { spread: number; spreadOfMid: number } | null;
  /** The next report against the last expiry: a calendar's bought one, which an earnings move between its expiries reaches. */
  earnings: CspEarnings;
}

interface TradeRisk { maxGain: number | null; maxLoss: number | null; unlimited: StrategyTrade["unlimited"]; breakEvens: number[] }

const firstClose = (position: ScenarioPosition) => Math.min(...position.legs.map((leg) => optionExpirationClose(leg.expiration)));

/**
 * A calendar read at its sold leg's expiry, with the bought one still open at
 * its IV (OSA's scenario value): the most it makes is where the sold call
 * expires worthless at its strike, the most it loses the debit, and its
 * break-evens are where that value crosses the debit.
 */
function calendarRisk(position: ScenarioPosition, net: number): TradeRisk {
  const close = firstClose(position);
  const pnl = (spot: number) => scenarioValue(position, spot, close).pnl;
  const strikes = [...new Set(position.legs.map((leg) => leg.strike))];
  const multiplier = position.legs[0]?.multiplier ?? 100;
  const steps = 400;
  const low = position.spot * 0.2;
  const high = position.spot * 3;
  const grid = [...new Set([...Array.from({ length: steps + 1 }, (_, index) => low + (high - low) * index / steps), ...strikes])].sort((a, b) => a - b);
  const values = grid.map(pnl);
  const breakEvens: number[] = [];
  for (let index = 1; index < grid.length; index++) {
    let [left, right] = [grid[index - 1]!, grid[index]!];
    let leftValue = values[index - 1]!;
    if ((leftValue < 0) === (values[index]! < 0)) continue;
    for (let step = 0; step < 60; step++) {
      const middle = (left + right) / 2;
      const value = pnl(middle);
      if ((value < 0) === (leftValue < 0)) { left = middle; leftValue = value; } else right = middle;
    }
    breakEvens.push((left + right) / 2);
  }
  return { maxGain: Math.max(0, ...strikes.map(pnl)), maxLoss: Math.max(0, -net) * multiplier, unlimited: null, breakEvens };
}

/**
 * The chance the trade is in profit when its first leg expires: the
 * Black-Scholes-Merton probability the underlying ends in each stretch
 * between break-evens whose P&L is above zero (OSA's scenario value at that
 * close), each break-even at the IV of the expiring leg whose strike is
 * nearest it, from the spot the quotes imply at the scenario's rate and
 * dividend yield.
 */
function probabilityOfProfit(position: ScenarioPosition, breakEvens: readonly number[]): number | null {
  if (!position.legs.length) return null;
  const close = firstClose(position);
  const days = Math.max(0, (close - position.asOf) / DAY_MS);
  const expiring = position.legs.filter((leg) => optionExpirationClose(leg.expiration) === close);
  const pnl = (spot: number) => scenarioValue(position, spot, close).pnl;
  const above = (level: number) => {
    if (level <= 0) return 1;
    if (!Number.isFinite(level)) return 0;
    const leg = expiring.reduce((best, entry) => Math.abs(entry.strike - level) < Math.abs(best.strike - level) ? entry : best);
    return probabilityAbove({ spot: position.spot, strike: level, daysToExpiry: days, rate: position.rate,
      dividendYield: position.dividendYield, volatility: leg.volatility });
  };
  const bounds = [0, ...breakEvens.filter((value) => value > 0), Number.POSITIVE_INFINITY];
  let total = 0;
  for (let index = 1; index < bounds.length; index++) {
    const [low, high] = [bounds[index - 1]!, bounds[index]!];
    const probe = Number.isFinite(high) ? (low + high) / 2 : low > 0 ? low * 1.5 : position.spot;
    if (pnl(probe) > 0) total += Math.max(0, above(low) - above(high));
  }
  return Math.min(1, total);
}

/**
 * A trade's figures, as the screen's row and its export read them; `quotes`
 * are its legs' bids and asks. Mids that cross (an income trade that would pay
 * to open, a debit trade that would be paid) leave the name out.
 */
function strategyTrade(
  strategy: ScreenFamily, position: ScenarioPosition, quotes: ReadonlyMap<string, { bid: number; ask: number }>, earningsDate: string | null | undefined,
): StrategyTrade {
  const def = strategyFamilyDef(strategy);
  const expirations = [...new Set(position.legs.map((leg) => leg.expiration))].sort((a, b) => a - b);
  const expiry = legExpiry(expirations[0]!);
  const farExpiry = expirations.length > 1 ? legExpiry(expirations.at(-1)!) : null;
  const { valuationDate, daysToExpiry } = calendarDaysToExpiry(position.asOf, expiry);
  const net = Math.round(position.legs.reduce((sum, leg) => sum - leg.quantity * leg.price, 0) * 1e8) / 1e8;
  if (def.net === "credit" ? !(net > 0) : !(net < 0)) {
    throw new Error(`Crossed mids: the legs ${net > 0 ? `take in ${net.toFixed(2)}` : net < 0 ? `cost ${(-net).toFixed(2)}` : "net to nothing"} `
      + `where the trade ${def.net === "credit" ? "takes in a credit" : "pays a debit"}`);
  }
  const multiplier = position.legs[0]!.multiplier;
  let risk: TradeRisk;
  if (expirations.length > 1) risk = calendarRisk(position, net);
  else {
    const expiryRisks = expiryRisk(position);
    risk = { maxGain: expiryRisks.unlimitedProfit ? null : expiryRisks.maxProfit, maxLoss: expiryRisks.unlimitedLoss ? null : expiryRisks.maxLoss,
      unlimited: expiryRisks.unlimitedProfit ? "gain" : expiryRisks.unlimitedLoss ? "loss" : null, breakEvens: expiryRisks.breakevens };
  }
  const riskRatio = finite(risk.maxGain) && finite(risk.maxLoss) && risk.maxLoss > 0 ? risk.maxGain / risk.maxLoss : null;
  // A short straddle or strangle has no max loss to divide by: its credit is read on the cash its put would take, as the put screen's yield is.
  const securedPut = risk.unlimited === "loss" ? position.legs.find((leg) => leg.side === "put" && leg.quantity < 0) : undefined;
  const returnToExpiry = def.net === "debit" ? null
    : riskRatio ?? (securedPut ? net * multiplier / (securedPut.strike * securedPut.multiplier * -securedPut.quantity) : null);
  const legQuotes = position.legs.map((leg) => quotes.get(leg.id));
  const spread = legQuotes.every((quote) => quote && quote.ask >= quote.bid && quote.bid > 0)
    ? legQuotes.reduce((sum, quote) => sum + quote!.ask - quote!.bid, 0) : null;
  return {
    strategy, position, text: strategyTradeText(strategy, position), expiry, farExpiry, daysToExpiry, valuationDate, spot: position.spot,
    net, netAmount: Math.round(net * multiplier * 1e6) / 1e6,
    ...risk, probabilityOfProfit: probabilityOfProfit(position, risk.breakEvens), returnToExpiry,
    annualizedReturn: finite(returnToExpiry) && daysToExpiry > 0 ? returnToExpiry * 365 / daysToExpiry : null,
    rewardToRisk: def.net === "debit" ? riskRatio : null,
    quote: spread != null ? { spread, spreadOfMid: spread / Math.abs(net) } : null,
    earnings: earningsBeforeExpiry(earningsDate, valuationDate, farExpiry ?? expiry),
  };
}

export interface StrategyScreenRow {
  symbol: string;
  /** 1 for the first by the family's ranking; null for a name with no trade or nothing to rank it by. */
  rank: number | null;
  trade: StrategyTrade | null;
  /** 30-day IV rank, 0 to 100, against the prior 52 weeks; null when IV history has none. */
  ivRank: number | null;
  /** Its spread is over the screen's `maxSpreadPercent` of the net midpoint. */
  wideSpread: boolean;
  /** Why the name has no trade. */
  note: string | null;
}

export interface StrategyScreen extends Omit<CspScreen, "rows" | "criteria"> {
  rows: StrategyScreenRow[];
  criteria: StrategyScreenCriteria;
}

/** What a row ranks by: an income trade's annualised return, a debit trade's reward to risk, or its IV rank. */
function rankValue(row: Omit<StrategyScreenRow, "rank">, def: StrategyFamilyDef): number | null {
  if (!row.trade) return null;
  const value = def.rank === "return" ? row.trade.annualizedReturn : def.rank === "reward-risk" ? row.trade.rewardToRisk : row.ivRank;
  return finite(value) ? value : null;
}

/**
 * The family's order: an income trade's highest annualised return first, a
 * debit trade's highest reward to risk, or for a straddle or strangle the
 * richest IV rank first when selling and the cheapest when buying. A wide spread is ranked and flagged. A trade with
 * nothing to rank it by follows, then the names with no trade, by symbol.
 */
export function rankStrategyScreen(rows: readonly Omit<StrategyScreenRow, "rank">[], strategy: ScreenFamily): StrategyScreenRow[] {
  const def = strategyFamilyDef(strategy);
  const direction = def.rank === "iv-rank-low" ? 1 : -1;
  const tier = (row: Omit<StrategyScreenRow, "rank">) => rankValue(row, def) != null ? 0 : row.trade ? 1 : 2;
  const sorted = [...rows].sort((left, right) => tier(left) - tier(right)
    || direction * ((rankValue(left, def) ?? 0) - (rankValue(right, def) ?? 0))
    || left.symbol.localeCompare(right.symbol));
  let rank = 0;
  return sorted.map((row) => ({ ...row, rank: tier(row) === 0 ? ++rank : null }));
}

/** The date a calendar's bought expiry is nearest: `CALENDAR_GAP_DAYS` after the sold one. */
const farTarget = (near: number) => new Date(Date.parse(`${expiryIsoDate(near)}T00:00:00Z`) + CALENDAR_GAP_DAYS * DAY_MS).toISOString().slice(0, 10);

/** One name's trade: its legs picked from the chain on the listed expiry nearest the target, and a calendar's from the expiry after it. */
async function screenStrategy(
  instrument: InstrumentRef, criteria: StrategyScreenCriteria, dependencies: ScenarioLoaderDependencies, target: string,
  earningsDate: string | null, signal: AbortSignal | undefined,
): Promise<{ value: StrategyTrade; market: ScenarioMarketSnapshot }> {
  const market = await loadScreenMarket(instrument, criteria, dependencies, target, signal);
  const near = market.chain ? [...market.chain.calls, ...market.chain.puts][0]?.expiration : undefined;
  let merged: OptionsChain | undefined;
  let far: number | undefined;
  if (criteria.strategy === "calendar" && market.chain && near != null) {
    far = nearestListedExpiry(market.expirationDates.filter((expiration) => expiryIsoDate(expiration) > expiryIsoDate(near)), farTarget(near));
    if (far == null) throw new Error(`No expiry listed after ${expiryIsoDate(near)} to buy`);
    const back = await loadScenarioMarket({ instrument, expiration: far, signal }, dependencies);
    if (!back.chain || back.warnings.includes("Options chain is stale")) {
      throw new Error(back.missingExpiry ?? `No current ${expiryIsoDate(far)} chain to buy the calendar on`);
    }
    // The bought contracts by the date they are listed on in the catalogue.
    const backExpiration = [...back.chain.calls, ...back.chain.puts][0]?.expiration ?? far;
    far = backExpiration;
    merged = { ...market.chain, calls: [...market.chain.calls, ...back.chain.calls], puts: [...market.chain.puts, ...back.chain.puts] };
  }
  const position = seedScreenPosition(market, (quoted, pricing, unusable) => pickStrategyLegs(criteria, quoted, pricing, unusable, near!, far), merged);
  return { value: strategyTrade(criteria.strategy, position, seededLegQuotes(position, merged ?? market.chain), earningsDate), market };
}

/** Each name's trade of the family, ranked. */
export async function loadStrategyScreen(
  instruments: readonly InstrumentRef[], criteria: StrategyScreenCriteria, dependencies: CspScreenDependencies, signal?: AbortSignal,
): Promise<StrategyScreen> {
  const target = cspTargetDate(criteria, dependencies.scenario.now?.() ?? Date.now());
  const screened = await screenNames(instruments, dependencies, signal, "No trade on this chain", async (instrument, earningsDate, scenario) =>
    screenStrategy(instrument, criteria, scenario, target, earningsDate, signal));
  const rows = screened.names.map(({ symbol, ivRank, value, note }): Omit<StrategyScreenRow, "rank"> => ({
    symbol, trade: value, ivRank, note,
    wideSpread: value?.quote != null && value.quote.spreadOfMid * 100 > criteria.maxSpreadPercent }));
  return { rows: rankStrategyScreen(rows, criteria.strategy), criteria, missingRanks: screened.missingRanks,
    ivRankError: screened.ivRankError, freshness: screened.freshness };
}

/** `nearest 0.30 delta, wings 0.15 · expiry nearest 2026-11-20 (30 days)`: what each name's trade is. */
export function strategyScreenCriteriaText(criteria: StrategyScreenCriteria, now: number): string {
  const def = strategyFamilyDef(criteria.strategy);
  const legs = def.delta == null || criteria.delta == null ? "strike nearest the money"
    : `nearest ${criteria.delta.toFixed(2)} delta${criteria.wingDelta != null ? `, wings ${criteria.wingDelta.toFixed(2)}` : ""}`;
  return `${legs} · expiry nearest ${cspTargetDate(criteria, now)}${criteria.expiration == null ? ` (${criteria.days} days)` : ""}`
    + (criteria.strategy === "calendar" ? `, bought about ${CALENDAR_GAP_DAYS} days later` : "");
}

/** How a family's rows are ranked, in the words the notes and exports use. */
export function strategyRankedBy(strategy: ScreenFamily): string {
  const def = strategyFamilyDef(strategy);
  if (def.rank === "reward-risk") return "reward to risk (max gain over max loss) at the mid";
  if (def.rank === "return") return "annualised return on risk at the mid";
  return def.rank === "iv-rank-high" ? "IV rank, highest first" : "IV rank, lowest first";
}
