import type { StatItem } from "../../../components";
import type { HeadlessPaneEntry } from "../../../types/headless";
import { formatHedgePrice } from "./hedge";
import { amountUnit, UNKNOWN_CURRENCY, type ScenarioPosition } from "./model";

/**
 * A collar (docs/research-data.md#collar): one long put and one short call on
 * the same expiry, with the shares they cover. Per share, for the position as
 * entered:
 *
 * - net premium = call price - put price; positive is a net credit, negative a net debit
 * - floor = put strike + net premium: the least the shares are worth at expiry, net of the options
 * - cap = call strike + net premium: the most they are worth
 *
 * The floor and cap hold when the shares match the contracts (contracts x
 * multiplier); without shares the options alone have neither.
 */
export interface Collar {
  currency: string;
  /** Expiry calendar date, YYYY-MM-DD. */
  expiry: string;
  contracts: number;
  multiplier: number;
  put: CollarLeg;
  call: CollarLeg;
  /** Signed shares held with the options; 0 for none. */
  shares: number;
  /** The shares the contracts cover: contracts x multiplier. */
  coveredShares: number;
  /** Per share: call price - put price; positive is a credit. */
  netPremium: number;
  /** For the whole position: net premium x multiplier x contracts. */
  netPremiumTotal: number;
  /** Per share; null unless the shares match the contracts. */
  floor: number | null;
  cap: number | null;
  spot: number;
  /** What the spot is: `implied by option quotes`, `typed`, `last price`. */
  spotBasis: string;
}

interface CollarLeg {
  strike: number;
  /** Per share. */
  price: number;
  /** "mid" when a strategy seed entered the leg at its quote midpoint, else the entry price as typed. */
  priceBasis: "mid" | "entry";
}

const clean = (value: number) => Math.round(value * 1e9) / 1e9;

/** The position as a collar, or null when it is not one long put and one short call of the same size, expiry and multiplier. */
export function scenarioCollar(position: ScenarioPosition, spotBasis: string): Collar | null {
  if (position.legs.length !== 2) return null;
  const put = position.legs.find((leg) => leg.side === "put" && leg.quantity > 0);
  const call = position.legs.find((leg) => leg.side === "call" && leg.quantity < 0);
  if (!put || !call || put.quantity !== -call.quantity || put.expiration !== call.expiration || put.multiplier !== call.multiplier
    || put.strike >= call.strike) return null;
  const contracts = put.quantity;
  const coveredShares = contracts * put.multiplier;
  const shares = position.underlying?.quantity ?? 0;
  const netPremium = clean(call.price - put.price);
  const covered = shares === coveredShares;
  return {
    currency: position.currency, expiry: new Date(put.expiration * 1000).toISOString().slice(0, 10),
    contracts, multiplier: put.multiplier,
    put: { strike: put.strike, price: put.price, priceBasis: put.priceSource === "mid" ? "mid" : "entry" },
    call: { strike: call.strike, price: call.price, priceBasis: call.priceSource === "mid" ? "mid" : "entry" },
    shares, coveredShares, netPremium, netPremiumTotal: clean(netPremium * coveredShares),
    floor: covered ? clean(put.strike + netPremium) : null, cap: covered ? clean(call.strike + netPremium) : null,
    spot: position.spot, spotBasis,
  };
}

const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const strikeText = (value: number) => formatHedgePrice(value).replace(/\.00$/, "");
const unitOf = (collar: Collar) => collar.currency && collar.currency !== UNKNOWN_CURRENCY ? ` ${collar.currency}` : "";
const priceWord = (leg: CollarLeg) => leg.priceBasis === "mid" ? "quote mid" : "entry price";
/** `debit`, `credit`, or `zero cost` for a premium that nets to nothing. */
const premiumWord = (collar: Collar) => collar.netPremium > 0 ? "credit" : collar.netPremium < 0 ? "debit" : "zero cost";

/** `10.4% below spot 382.71 (implied by option quotes)`. */
function distanceText(collar: Collar, price: number): string {
  if (!(collar.spot > 0)) return "";
  const distance = (price - collar.spot) / collar.spot;
  const basis = collar.spotBasis && collar.spotBasis !== "last price" ? ` (${collar.spotBasis})` : "";
  return `, ${(Math.abs(distance) * 100).toFixed(1)}% ${distance < 0 ? "below" : "above"} spot ${money(collar.spot)}${basis}`;
}

/** Why there is no floor or cap: no shares, or not the shares the contracts cover. */
function uncoveredText(collar: Collar): string {
  if (collar.shares === 0) return "-- (no shares held: the options alone)";
  return `-- (${collar.shares.toLocaleString("en-US")} shares held; the contracts cover ${collar.coveredShares.toLocaleString("en-US")})`;
}

/** `342.80 per share (345 put - 2.20 debit), 10.4% below spot 382.71`. */
function boundText(collar: Collar, value: number | null, side: "put" | "call"): string {
  if (value == null) return uncoveredText(collar);
  const premium = collar.netPremium === 0 ? "" : ` ${collar.netPremium > 0 ? "+" : "-"} ${formatHedgePrice(Math.abs(collar.netPremium))} ${premiumWord(collar)}`;
  return `${formatHedgePrice(value)} per share (${strikeText(collar[side].strike)} ${side}${premium})${distanceText(collar, value)}`;
}

/** The report's Collar section; `value` keeps full precision, `formatted` is what text output prints. */
export function collarReportEntries(collar: Collar): HeadlessPaneEntry[] {
  const unit = unitOf(collar);
  const premium = Math.abs(collar.netPremium);
  // Every figure is per share, so an export writes the number with that unit.
  const perShare = { unit: `${amountUnit(collar.currency)} per share` };
  return [
    { key: "putBought", label: "Put bought", value: collar.put.price, ...perShare,
      formatted: `${strikeText(collar.put.strike)} put at ${formatHedgePrice(collar.put.price)} per share (${priceWord(collar.put)})` },
    { key: "callSold", label: "Call sold", value: collar.call.price, ...perShare,
      formatted: `${strikeText(collar.call.strike)} call at ${formatHedgePrice(collar.call.price)} per share (${priceWord(collar.call)})` },
    { key: "netPremium", label: "Net premium", value: collar.netPremium, ...perShare,
      formatted: collar.netPremium === 0 ? `0.00 per share (zero cost)`
        : `${formatHedgePrice(premium)} per share ${premiumWord(collar)} (${money(Math.abs(collar.netPremiumTotal))}${unit} `
          + `for ${collar.contracts.toLocaleString("en-US")} ${collar.contracts === 1 ? "contract" : "contracts"} each)` },
    { key: "floor", label: "Floor", value: collar.floor, ...perShare, formatted: boundText(collar, collar.floor, "put") },
    { key: "cap", label: "Cap", value: collar.cap, ...perShare, formatted: boundText(collar, collar.cap, "call") },
  ];
}

/** `-10.4% vs 382.71`. */
function shortDistance(collar: Collar, value: number): string {
  if (!(collar.spot > 0)) return "per share";
  const distance = (value - collar.spot) / collar.spot;
  return `${distance < 0 ? "-" : "+"}${(Math.abs(distance) * 100).toFixed(1)}% vs ${money(collar.spot)}`;
}

/** The pane's figures: the same numbers as the report, sized for a StatGrid. */
export function collarStatItems(collar: Collar): StatItem[] {
  const uncovered = collar.shares === 0 ? "no shares" : `${collar.coveredShares.toLocaleString("en-US")} shares cover it`;
  return [
    { id: "collar-premium", label: "Net premium", value: formatHedgePrice(Math.abs(collar.netPremium)),
      detail: collar.netPremium === 0 ? "zero cost" : `${premiumWord(collar)} per share` },
    { id: "collar-floor", label: "Floor", value: collar.floor == null ? "--" : formatHedgePrice(collar.floor),
      detail: collar.floor == null ? uncovered : shortDistance(collar, collar.floor) },
    { id: "collar-cap", label: "Cap", value: collar.cap == null ? "--" : formatHedgePrice(collar.cap),
      detail: collar.cap == null ? uncovered : shortDistance(collar, collar.cap) },
    { id: "collar-shares", label: "Shares", value: collar.shares.toLocaleString("en-US"),
      detail: collar.shares === collar.coveredShares ? "covered" : `of ${collar.coveredShares.toLocaleString("en-US")}` },
  ];
}
