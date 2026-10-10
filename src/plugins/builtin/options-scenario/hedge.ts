import type { StatItem } from "../../../components";
import type { OptionsChain } from "../../../types/financials";
import type { HeadlessPaneEntry } from "../../../types/headless";
import { formatCompact } from "../../../utils/format";
import { UNKNOWN_CURRENCY, type ScenarioPosition } from "./model";

/**
 * Hedge budget sizing (docs/research-data.md#options-scenario-analysis): how
 * many of the position as entered a budget of NAV buys, what that spends, and
 * how much of the underlying it protects.
 *
 * The position is scaled as a whole, in sets of its smallest whole ratio (a
 * put, a 1x1 spread, a 2x1 ratio), so the hedge keeps its shape. A set costs
 * its net debit: each leg's price times its signed contracts and multiplier.
 * The price is the entry price as entered, except for a leg a strategy seed
 * entered at its contract's midpoint (`priceSource: "mid"`, its id the
 * contract's symbol in the loaded chain), which buys at the ask and sells at
 * the bid, so a seeded hedge never spends past its budget.
 * The protecting legs are the long puts, or the long calls when the position
 * holds no long put; notional protected is their contracts times multiplier
 * times spot.
 */
export interface HedgeBudgetInputs {
  /** Portfolio NAV, in the position's currency. */
  nav: number;
  /** The budget as basis points of NAV: 50 is 0.5%. */
  budgetBps: number;
  /** The equity sleeve the hedge protects; coverage is notional over it. */
  sleeve: number | null;
}

/** How the set was priced: the legs as entered, chain quotes (long at the ask, short at the bid), or some of each. */
type HedgePriceBasis = "entry" | "quote" | "mixed";

export interface HedgeBudget extends HedgeBudgetInputs {
  currency: string;
  /** NAV times budget bps. */
  budget: number;
  basis: HedgePriceBasis;
  /** True for a single long leg: the price is that leg's own, not a net debit. */
  singleLeg: boolean;
  /** Per underlying unit of one protecting contract; null when the legs' multipliers differ. */
  sizingPrice: number | null;
  /** What one protecting contract costs, all legs of its set included. */
  costPerContract: number;
  /** Units of the underlying one protecting contract covers. */
  multiplier: number;
  /** Protecting contracts bought: whole sets, rounded down, times the protecting contracts in a set. */
  contracts: number;
  /** Premium spent: whole sets times what a set costs. */
  premium: number;
  /** Premium over NAV in basis points: what the budget actually spends. */
  premiumBps: number;
  /** The underlying price notional is read at. */
  spot: number;
  /** Protecting contracts times multiplier times spot. */
  notional: number;
  /** Notional over NAV, as a fraction. */
  notionalOfNav: number;
  /** Notional over the sleeve, as a fraction; null without a sleeve. */
  coverage: number | null;
}

const supplied = (value: unknown) => value != null && value !== "";

const AMOUNT_SCALES: Record<string, number> = { k: 1e3, m: 1e6, mm: 1e6, mn: 1e6, b: 1e9, bn: 1e9, t: 1e12, tn: 1e12 };
const AMOUNT = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*([a-z]{1,2})?$/i;
const AMOUNT_FORMS = "such as 100m, 2.5bn, 250k, 1,000,000 or $100m";

/** `100m`, `2.5bn`, `250k`, `1,000,000` and `$100m` as a positive amount; anything else names the flag and the forms. */
export function parseHedgeAmount(value: unknown, flag: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (/^-/.test(text)) throw new Error(`--${flag} must be greater than zero.`);
  const match = AMOUNT.exec(text);
  const scale = match ? match[3] ? AMOUNT_SCALES[match[3].toLowerCase()] : 1 : undefined;
  const amount = match && scale ? Number(`${match[1]!.replaceAll(",", "")}${match[2] ?? ""}`) * scale : Number.NaN;
  if (!Number.isFinite(amount)) throw new Error(`--${flag} must be an amount ${AMOUNT_FORMS}; got "${text}".`);
  if (!(amount > 0)) throw new Error(`--${flag} must be greater than zero.`);
  return amount;
}

function parseBudgetBps(value: unknown): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const bps = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isFinite(bps)) throw new Error(`--budget-bps must be a number of basis points, such as 50 for 0.5% of NAV; got "${text}".`);
  if (!(bps > 0)) throw new Error("--budget-bps must be greater than zero.");
  if (bps > 10_000) throw new Error("--budget-bps must be at most 10,000 (all of NAV).");
  return bps;
}

/**
 * `--nav`, `--budget-bps` and `--sleeve` as pane settings or report options.
 * Null when none is set; each needs the others it depends on.
 */
export function hedgeInputsFromSettings(settings: Record<string, unknown>): HedgeBudgetInputs | null {
  const hasNav = supplied(settings.nav);
  const hasBudget = supplied(settings.budgetBps);
  const hasSleeve = supplied(settings.sleeve);
  if (!hasNav && !hasBudget) {
    if (hasSleeve) throw new Error("--sleeve needs --nav and --budget-bps: coverage is the notional a hedge budget buys over the sleeve.");
    return null;
  }
  if (!hasBudget) throw new Error("--nav needs --budget-bps: the share of NAV to spend, in basis points (50 is 0.5%).");
  if (!hasNav) throw new Error("--budget-bps needs --nav: the portfolio value the budget is a share of, such as 100m.");
  return { nav: parseHedgeAmount(settings.nav, "nav"), budgetBps: parseBudgetBps(settings.budgetBps),
    sleeve: hasSleeve ? parseHedgeAmount(settings.sleeve, "sleeve") : null };
}

function gcd(left: number, right: number): number {
  return right === 0 ? left : gcd(right, left % right);
}

/** Float noise off a cent-quoted premium times a multiplier, so 5.495 x 100 is 549.5. */
const clean = (value: number) => Math.round(value * 1e6) / 1e6;

export interface HedgeQuote { bid: number; ask: number }

/**
 * The bid and ask of each leg a strategy seeded from the chain, by leg id: the
 * chain's, or the leg's streamed quote when the pane follows the market.
 */
function hedgeLegQuotes(
  position: ScenarioPosition, chain: OptionsChain | null | undefined, liveQuotes?: ReadonlyMap<string, HedgeQuote>,
): Map<string, HedgeQuote> {
  const contracts = new Map([...(chain?.calls ?? []), ...(chain?.puts ?? [])].map((contract) => [contract.contractSymbol, contract]));
  const quotes = new Map<string, HedgeQuote>();
  for (const leg of position.legs) {
    const contract = leg.priceSource === "mid" ? contracts.get(leg.id) : undefined;
    if (contract && contract.strike === leg.strike && contract.expiration === leg.expiration
      && contract.bid > 0 && contract.ask >= contract.bid && Number.isFinite(contract.ask)) {
      const live = liveQuotes?.get(leg.id);
      quotes.set(leg.id, live && live.bid > 0 && live.ask >= live.bid ? live : { bid: contract.bid, ask: contract.ask });
    }
  }
  return quotes;
}

/**
 * The underlying price notional is read at: the last price when the scenario
 * starts at a spot the option quotes imply (a seeded strategy) and no spot was
 * typed, otherwise the scenario's own spot.
 */
function hedgeSpot(position: ScenarioPosition, marketSpot: number | null | undefined, spotTyped: boolean): number {
  const quoteImplied = position.legs.some((leg) => leg.volatilitySource === "mid");
  return quoteImplied && !spotTyped && marketSpot != null && Number.isFinite(marketSpot) && marketSpot > 0 ? marketSpot : position.spot;
}

const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function sizeHedgeBudget(
  position: ScenarioPosition,
  inputs: HedgeBudgetInputs,
  { quotes = new Map(), spot = position.spot }: { quotes?: ReadonlyMap<string, HedgeQuote>; spot?: number } = {},
): HedgeBudget {
  const longs = position.legs.filter((leg) => leg.quantity > 0);
  if (!longs.length) throw new Error("A hedge budget buys options; this position has no long option.");
  const step = position.legs.reduce((divisor, leg) => gcd(divisor, Math.abs(leg.quantity)), 0);
  const protecting = longs.some((leg) => leg.side === "put") ? longs.filter((leg) => leg.side === "put") : longs;
  const priced = position.legs.map((leg) => {
    const quote = quotes.get(leg.id);
    return { leg, quoted: !!quote, price: quote ? leg.quantity > 0 ? quote.ask : quote.bid : leg.price };
  });
  const quotedCount = priced.filter((entry) => entry.quoted).length;
  const basis: HedgePriceBasis = quotedCount === 0 ? "entry" : quotedCount === priced.length ? "quote" : "mixed";
  const setCost = clean(priced.reduce((sum, { leg, price }) => sum + price * leg.quantity / step * leg.multiplier, 0));
  const currency = position.currency === UNKNOWN_CURRENCY ? "" : ` ${position.currency}`;
  if (!(setCost > 0)) {
    throw new Error(setCost < 0
      ? `This position takes in a net credit of ${money(-setCost)}${currency} per set, so a budget does not size it; a hedge budget buys a net debit.`
      : "This position costs nothing at these prices, so a budget does not size it.");
  }
  const contractsPerSet = protecting.reduce((sum, leg) => sum + leg.quantity / step, 0);
  const unitsPerSet = protecting.reduce((sum, leg) => sum + leg.quantity / step * leg.multiplier, 0);
  const multipliers = new Set(position.legs.map((leg) => leg.multiplier));
  const multiplier = unitsPerSet / contractsPerSet;
  const costPerContract = setCost / contractsPerSet;
  const sizingPrice = multipliers.size === 1 ? clean(costPerContract / multiplier) : null;
  const budget = clean(inputs.nav * inputs.budgetBps / 10_000);
  // A budget that is an exact multiple of the set's cost buys that many sets, despite float division.
  const sets = Math.floor(budget / setCost * (1 + 1e-12));
  if (sets < 1) {
    const single = position.legs.length === 1 && contractsPerSet === 1;
    const at = single && sizingPrice != null ? ` at ${describePrice(basis, true, sizingPrice)}` : "";
    throw new Error(`A ${formatBps(inputs.budgetBps)} budget of ${money(inputs.nav)}${currency} NAV is ${money(budget)}${currency}; `
      + `one ${single ? "contract" : "set of the position"} costs ${money(setCost)}${currency}${at}.`);
  }
  const contracts = sets * contractsPerSet;
  const premium = clean(sets * setCost);
  const notional = sets * unitsPerSet * spot;
  return { ...inputs, currency: position.currency, budget, basis, singleLeg: position.legs.length === 1, sizingPrice,
    costPerContract, multiplier, contracts, premium, premiumBps: premium / inputs.nav * 10_000, spot, notional,
    notionalOfNav: notional / inputs.nav, coverage: inputs.sleeve == null ? null : notional / inputs.sleeve };
}

/**
 * Hedge sizing for a scenario, read the same way by the report and the pane:
 * null without `--nav` and `--budget-bps`; throws on a bad input or a
 * position a budget cannot size.
 */
export function scenarioHedgeBudget(
  settings: Record<string, unknown>,
  position: ScenarioPosition | null,
  market: { chain?: OptionsChain | null; spot?: number | null; liveQuotes?: ReadonlyMap<string, HedgeQuote> } | null | undefined,
): HedgeBudget | null {
  const inputs = hedgeInputsFromSettings(settings);
  if (!inputs) return null;
  if (!position?.legs.length) throw new Error("A hedge budget needs a position; add --legs or select --strategy.");
  return sizeHedgeBudget(position, inputs, { quotes: hedgeLegQuotes(position, market?.chain, market?.liveQuotes),
    spot: hedgeSpot(position, market?.spot, supplied(settings.spot)) });
}

/** `50 bps`, `12.5 bps`. */
function formatBps(value: number): string {
  return `${Number(value.toFixed(2))} bps`;
}

/** A per-unit premium with the decimals it was quoted to: 5.51, 5.495. */
export function formatHedgePrice(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** The price a budget is sized at, and where it came from: `5.51 per share, the ask`, `2.30 per share net debit at entry prices`. */
function describePrice(basis: HedgePriceBasis, singleLeg: boolean, price: number): string {
  const value = `${formatHedgePrice(price)} per share`;
  if (singleLeg) return basis === "quote" ? `${value}, the ask` : `${value}, the entry price`;
  return basis === "quote" ? `${value} net debit: long legs at the ask, short at the bid`
    : basis === "mixed" ? `${value} net debit: quoted legs at the ask or bid, the rest at entry`
      : `${value} net debit at entry prices`;
}

/** The price basis in a word or two, for a figure's detail: `ask 5.51`, `entry 5.495`, `net debit 2.30`. */
function shortPrice(hedge: HedgeBudget): string {
  if (hedge.sizingPrice == null) return `${money(hedge.costPerContract)} each`;
  const word = !hedge.singleLeg ? "net debit" : hedge.basis === "quote" ? "ask" : "entry";
  return `${word} ${formatHedgePrice(hedge.sizingPrice)}`;
}

const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

/** `551.00 USD (5.51 x 100)`: what one protecting contract costs, and the price behind it. */
function costText(cost: number, sizingPrice: number | null, multiplier: number, unit: string): string {
  return `${money(cost)}${unit}${sizingPrice == null ? "" : ` (${formatHedgePrice(sizingPrice)} x ${multiplier})`}`;
}

/** The report's Hedge budget section; `value` keeps full precision, `formatted` is what text output prints. */
export function hedgeReportEntries(hedge: HedgeBudget): HeadlessPaneEntry[] {
  const unit = hedge.currency && hedge.currency !== UNKNOWN_CURRENCY ? ` ${hedge.currency}` : "";
  return [
    { key: "nav", label: "NAV", value: hedge.nav, formatted: `${money(hedge.nav)}${unit}` },
    { key: "budget", label: "Budget", value: hedge.budget, formatted: `${money(hedge.budget)}${unit} (${formatBps(hedge.budgetBps)} of NAV)` },
    { key: "sizingPrice", label: "Sizing price", value: hedge.sizingPrice,
      formatted: hedge.sizingPrice == null ? "--" : describePrice(hedge.basis, hedge.singleLeg, hedge.sizingPrice) },
    { key: "costPerContract", label: "Cost per contract", value: hedge.costPerContract, formatted: costText(hedge.costPerContract, hedge.sizingPrice, hedge.multiplier, unit) },
    { key: "contracts", label: "Contracts", value: hedge.contracts, formatted: hedge.contracts.toLocaleString("en-US") },
    { key: "premium", label: "Premium spent", value: hedge.premium, formatted: `${money(hedge.premium)}${unit}` },
    { key: "premiumBps", label: "Premium / NAV", value: hedge.premiumBps, formatted: `${formatBps(hedge.premiumBps)} (${(hedge.premiumBps / 100).toFixed(2)}% of NAV)` },
    { key: "notional", label: "Notional protected", value: hedge.notional,
      formatted: `${money(hedge.notional)}${unit} (${hedge.contracts.toLocaleString("en-US")} x ${hedge.multiplier} x ${formatHedgePrice(hedge.spot)})` },
    { key: "notionalOfNav", label: "Notional / NAV", value: hedge.notionalOfNav, formatted: percent(hedge.notionalOfNav) },
    hedge.coverage == null || hedge.sleeve == null
      ? { key: "coverage", label: "Coverage", value: null, formatted: "No equity sleeve given; add --sleeve <amount> to read notional against it" }
      : { key: "coverage", label: "Coverage", value: hedge.coverage, formatted: `${percent(hedge.coverage)} of a ${money(hedge.sleeve)}${unit} sleeve` },
  ];
}

/** `100M`, `70.62M`: an amount short enough for a figure. */
const short = (value: number) => formatCompact(value);

/**
 * The pane's Hedge budget figures: the same numbers as the report, sized for a
 * StatGrid. The currency is the P&L figure's, so it is not repeated here.
 */
export function hedgeStatItems(hedge: HedgeBudget): StatItem[] {
  return [
    { id: "hedge-budget", label: "Hedge budget", value: money(hedge.budget), detail: `${formatBps(hedge.budgetBps)} of ${short(hedge.nav)}` },
    { id: "hedge-contracts", label: "Contracts", value: hedge.contracts.toLocaleString("en-US"), detail: shortPrice(hedge) },
    { id: "hedge-premium", label: "Premium", value: money(hedge.premium), detail: `${formatBps(hedge.premiumBps)} of NAV` },
    { id: "hedge-notional", label: "Notional", value: short(hedge.notional),
      detail: `${percent(hedge.notionalOfNav)} of NAV at ${formatHedgePrice(hedge.spot)}` },
    hedge.coverage == null || hedge.sleeve == null
      ? { id: "hedge-coverage", label: "Coverage", value: "--", detail: "no sleeve set" }
      : { id: "hedge-coverage", label: "Coverage", value: percent(hedge.coverage), detail: `of ${short(hedge.sleeve)} sleeve` },
  ];
}
