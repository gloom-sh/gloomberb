import { daysToExpiryFrom, valueOption, type OptionValuation } from "../options-calculator/model";

const DAY_MS = 86_400_000;
const MAX_DATE_MS = Date.UTC(9999, 11, 31);
export const MAX_SCENARIO_LEGS = 32;

export interface ScenarioLeg {
  id: string;
  side: "call" | "put";
  /** Signed option contracts: positive buys, negative sells. */
  quantity: number;
  strike: number;
  /** Unix seconds identifying the expiration calendar date. */
  expiration: number;
  /** Entry premium per underlying unit. */
  price: number;
  /** Decimal annualized volatility. */
  volatility: number;
  multiplier: number;
}

export interface ScenarioPosition {
  symbol: string;
  /** Listing identity when a symbol has multiple venues. */
  exchange?: string;
  currency: string;
  spot: number;
  rate: number;
  dividendYield: number;
  /** Valuation origin in Unix milliseconds. */
  asOf: number;
  legs: ScenarioLeg[];
}

export interface ScenarioControls {
  date: number;
  /** Additive decimal shift, so .01 adds one volatility point. */
  volShift: number;
  spotRange: number;
}

export interface ScenarioValuation extends OptionValuation { pnl: number }

export interface ScenarioExpiryRisk {
  /** Roots and boundaries of any interval with identically zero P&L. */
  breakevens: number[];
  maxProfit: number | null;
  /** Nonnegative magnitude of the worst loss. */
  maxLoss: number | null;
  unlimitedProfit: boolean;
  unlimitedLoss: boolean;
  reason: string | null;
}

export interface ScenarioGridRow {
  spot: number;
  move: number | null;
  values: number[];
  /** A strike or terminal breakeven inserted between the even steps. */
  landmark?: "strike" | "breakeven";
}
export const SCENARIO_GRID_STEPS = 20;

export interface ScenarioModel {
  position: ScenarioPosition;
  controls: ScenarioControls;
  valuation: ScenarioValuation;
  expiryRisk: ScenarioExpiryRisk;
  dates: number[];
  grid: ScenarioGridRow[];
  payoff: Array<{ spot: number; selected: number; expiry: number }>;
  expiryDate: number;
  warnings: string[];
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const validDate = (value: unknown): value is number => finite(value) && value >= 0 && value <= MAX_DATE_MS;

/** Match the shared pricer's expiration-session close, including daylight saving. */
export function optionExpirationClose(expiration: number): number {
  const midnight = Math.floor(expiration / 86_400) * DAY_MS;
  return midnight + daysToExpiryFrom(expiration, midnight) * DAY_MS;
}

function legProblem(input: unknown): string | null {
  if (!input || typeof input !== "object") return "Leg must be an object.";
  const leg = input as ScenarioLeg;
  if (typeof leg.id !== "string" || !leg.id.trim()) return "Leg needs an id.";
  if (leg.side !== "call" && leg.side !== "put") return "Side must be call or put.";
  if (!Number.isSafeInteger(leg.quantity) || leg.quantity === 0) return "Quantity must be a nonzero integer.";
  if (!finite(leg.strike) || leg.strike <= 0) return "Strike must be positive.";
  if (!finite(leg.expiration) || !Number.isSafeInteger(leg.expiration) || !validDate(leg.expiration * 1000)) {
    return "Expiration must be a valid Unix timestamp in seconds.";
  }
  if (!finite(leg.price) || leg.price < 0) return "Entry price must be nonnegative.";
  if (!finite(leg.volatility) || leg.volatility < 0) return "Volatility must be nonnegative.";
  if (!finite(leg.multiplier) || leg.multiplier <= 0) return "Multiplier must be positive.";
  if (![leg.volatility * 100, leg.quantity * leg.multiplier, leg.price * leg.quantity * leg.multiplier,
    leg.strike * leg.quantity * leg.multiplier].every(Number.isFinite)) return "Leg exceeds model precision.";
  return null;
}

/** Validate inputs and existing legs while allowing an empty position builder. */
export function validateScenarioInputs(position: ScenarioPosition): string | null {
  if (!position || typeof position !== "object") return "Position must be an object.";
  if (typeof position.symbol !== "string" || !position.symbol.trim()) return "Position needs a symbol.";
  if (position.exchange !== undefined && (typeof position.exchange !== "string" || !position.exchange.trim())) {
    return "Position exchange must be a nonempty string when supplied.";
  }
  if (typeof position.currency !== "string" || !position.currency.trim()) return "Position needs a currency.";
  if (!finite(position.spot) || position.spot < 0) return "Spot must be nonnegative.";
  if (!finite(position.rate) || !finite(position.dividendYield)) return "Rate and dividend yield must be finite.";
  if (!validDate(position.asOf)) return "As-of date is invalid.";
  if (!Array.isArray(position.legs)) return "Option legs must be an array.";
  if (position.legs.length > MAX_SCENARIO_LEGS) return `A position supports up to ${MAX_SCENARIO_LEGS} legs.`;
  const ids = new Set<string>();
  for (const [index, leg] of position.legs.entries()) {
    const problem = legProblem(leg);
    if (problem) return `Leg ${index + 1}: ${problem}`;
    if (ids.has(leg.id)) return "Leg ids must be unique.";
    ids.add(leg.id);
    // Current spot cannot stand in for a settlement observed before the origin.
    if (optionExpirationClose(leg.expiration) < position.asOf) {
      return `Leg ${index + 1} has expired; remove it or use an as-of date before its close.`;
    }
  }
  return null;
}

/** Also validates restored persistence values at the model boundary. */
export function validatePosition(position: ScenarioPosition): string | null {
  return validateScenarioInputs(position) ?? (position.legs.length ? null : "Add at least one option leg.");
}

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseScenarioNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !DECIMAL.test(value.trim()) || !Number.isFinite(Number(value))) {
    throw new Error(`${field} must be a finite decimal number.`);
  }
  return Number(value);
}

/** call,100,2026-12-18,1,5,25[,100]; IV input is in percent. */
export function parseLegs(text: string): ScenarioLeg[] {
  if (typeof text !== "string" || !text.trim()) throw new Error("Add at least one option leg.");
  const entries = text.split(";");
  if (entries.length > MAX_SCENARIO_LEGS) throw new Error(`A position supports up to ${MAX_SCENARIO_LEGS} legs.`);
  return entries.map((entry, index) => {
    const fields = entry.split(",").map((field) => field.trim());
    if (fields.length < 6 || fields.length > 7) throw new Error(`Leg ${index + 1} needs side,strike,date,quantity,price,iv[,multiplier].`);
    const [side, strike, date, quantity, price, volatility, multiplier] = fields;
    if (side !== "call" && side !== "put") throw new Error(`Leg ${index + 1}: Side must be call or put.`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date!)) throw new Error(`Leg ${index + 1}: Use an expiration date in YYYY-MM-DD form.`);
    const expirationMs = Date.parse(`${date}T00:00:00.000Z`);
    if (!validDate(expirationMs) || new Date(expirationMs).toISOString().slice(0, 10) !== date) {
      throw new Error(`Leg ${index + 1}: Expiration date is invalid.`);
    }
    if (!/^[+-]?\d+$/.test(quantity!)) throw new Error(`Leg ${index + 1}: Quantity must be a nonzero integer.`);
    const leg: ScenarioLeg = { id: `leg-${index + 1}`, side, strike: parseScenarioNumber(strike, "Strike"),
      expiration: expirationMs / 1000, quantity: Number(quantity), price: parseScenarioNumber(price, "Entry price"),
      volatility: parseScenarioNumber(volatility, "Volatility") / 100,
      multiplier: multiplier === undefined ? 100 : parseScenarioNumber(multiplier, "Multiplier") };
    const problem = legProblem(leg);
    if (problem) throw new Error(`Leg ${index + 1}: ${problem}`);
    return leg;
  });
}

interface PreparedPosition { position: ScenarioPosition; closes: number[]; expiryDate: number }

function prepare(position: ScenarioPosition): PreparedPosition {
  const problem = validatePosition(position);
  if (problem) throw new Error(problem);
  const closes = position.legs.map((leg) => optionExpirationClose(leg.expiration));
  return { position, closes, expiryDate: Math.min(...closes) };
}

function aggregate(prepared: PreparedPosition, spot: number, date: number, volShift: number): ScenarioValuation {
  const { position, closes } = prepared;
  const result: ScenarioValuation = { price: 0, pnl: 0, delta: 0, gamma: 0, thetaPerDay: 0,
    vegaPerPoint: 0, rhoPerPoint: 0 };
  for (const [index, leg] of position.legs.entries()) {
    const value = valueOption({ symbol: position.symbol, side: leg.side, spot, strike: leg.strike,
      daysToExpiry: Math.max(0, (closes[index]! - date) / DAY_MS), rate: position.rate,
      dividendYield: position.dividendYield, volatility: Math.max(0, leg.volatility + volShift), marketPrice: 0 });
    const units = leg.quantity * leg.multiplier;
    for (const key of ["price", "delta", "gamma", "thetaPerDay", "vegaPerPoint", "rhoPerPoint"] as const) {
      result[key] += value[key] * units;
    }
    // Entry cash flow remains nominal: no financing, fees, or stock assignment.
    result.pnl += (value.price - leg.price) * units;
  }
  if (!Object.values(result).every(Number.isFinite)) throw new Error("Scenario inputs exceed model precision.");
  return result;
}

/** Aggregate currency P&L and Greeks in signed underlying units. */
export function scenarioValue(position: ScenarioPosition, spot: number, date: number, volShift = 0): ScenarioValuation {
  const prepared = prepare(position);
  if (!finite(spot) || spot < 0) throw new Error("Scenario spot must be nonnegative.");
  if (!validDate(date) || date < position.asOf || date > prepared.expiryDate) {
    throw new Error("Scenario date must lie between the as-of date and first expiration close.");
  }
  if (!finite(volShift)) throw new Error("Volatility shift must be finite.");
  return aggregate(prepared, spot, date, volShift);
}

function terminalPnl(position: ScenarioPosition, spot: number): number {
  return position.legs.reduce((sum, leg) => sum + (Math.max(0, leg.side === "call"
    ? spot - leg.strike : leg.strike - spot) - leg.price) * leg.quantity * leg.multiplier, 0);
}

function unavailableRisk(reason: string): ScenarioExpiryRisk {
  return { breakevens: [], maxProfit: null, maxLoss: null, unlimitedProfit: false, unlimitedLoss: false, reason };
}

/** Exact piecewise-linear terminal risk on S >= 0, never a sampled-chart bound. */
export function expiryRisk(position: ScenarioPosition): ScenarioExpiryRisk {
  const problem = validatePosition(position);
  if (problem) return unavailableRisk(problem);
  const expiries = new Set(position.legs.map((leg) => optionExpirationClose(leg.expiration)));
  if (expiries.size !== 1) return unavailableRisk("Mixed expirations: terminal breakevens and maximum profit/loss need an exercise and settlement path.");
  const knots = [...new Set([0, ...position.legs.map((leg) => leg.strike)])].sort((a, b) => a - b);
  const values = knots.map((spot) => terminalPnl(position, spot));
  if (!values.every(Number.isFinite)) return unavailableRisk("Position exceeds model precision.");
  const scale = Math.max(1, ...position.legs.flatMap((leg) => [leg.strike, leg.price]
    .map((value) => value * Math.abs(leg.quantity * leg.multiplier))));
  const tolerance = scale * Number.EPSILON * 32;
  const roots: number[] = [];
  for (const [index, spot] of knots.entries()) {
    const value = values[index]!;
    if (Math.abs(value) <= tolerance) roots.push(spot);
    if (index === 0) continue;
    const leftValue = values[index - 1]!;
    if ((leftValue < -tolerance && value > tolerance) || (leftValue > tolerance && value < -tolerance)) {
      roots.push(knots[index - 1]! + (spot - knots[index - 1]!) * -leftValue / (value - leftValue));
    }
  }
  const tailUnits = position.legs.filter((leg) => leg.side === "call").map((leg) => leg.quantity * leg.multiplier);
  const sum = tailUnits.reduce((total, units) => total + units, 0);
  if (!Number.isFinite(sum)) return unavailableRisk("Position exceeds model precision.");
  // Adjusted contracts can have fractional multipliers. Floating cancellation
  // must not turn an exactly balanced call tail into unlimited risk.
  const slopeTolerance = Math.max(0, ...tailUnits.map(Math.abs)) * tailUnits.length * Number.EPSILON * 4;
  const tailSlope = Math.abs(sum) <= slopeTolerance ? 0 : sum;
  const lastSpot = knots.at(-1)!;
  const lastValue = values.at(-1)!;
  if (tailSlope !== 0) {
    const tailRoot = lastSpot - lastValue / tailSlope;
    if (Number.isFinite(tailRoot) && tailRoot > lastSpot) roots.push(tailRoot);
  }
  const unlimitedProfit = tailSlope > 0;
  const unlimitedLoss = tailSlope < 0;
  const breakevens = roots.sort((a, b) => a - b).filter((value, index, sorted) => index === 0
    || Math.abs(value - sorted[index - 1]!) > Math.max(1, value) * Number.EPSILON * 32);
  return { breakevens, maxProfit: unlimitedProfit ? null : Math.max(0, ...values),
    maxLoss: unlimitedLoss ? null : Math.max(0, -Math.min(...values)), unlimitedProfit, unlimitedLoss, reason: null };
}

export function buildScenario(position: ScenarioPosition, input: Partial<ScenarioControls> = {}): ScenarioModel {
  const prepared = prepare(position);
  const date = input.date ?? position.asOf;
  const volShift = input.volShift ?? 0;
  const spotRange = input.spotRange ?? 0.2;
  if (!validDate(date)) throw new Error("Scenario date is invalid.");
  if (!finite(volShift)) throw new Error("Volatility shift must be finite.");
  if (!finite(spotRange) || spotRange <= 0) throw new Error("Spot range must be positive.");
  const controls = { date: Math.max(position.asOf, Math.min(prepared.expiryDate, date)), volShift, spotRange };
  const warnings: string[] = [];
  if (controls.date !== date) warnings.push("Scenario date was limited to the as-of date through first expiration close.");
  if (position.legs.some((leg) => leg.volatility + volShift < 0)) warnings.push("Shifted volatility was floored at zero.");
  const risk = expiryRisk(position);
  if (risk.reason) warnings.push(risk.reason);
  if (position.spot === 0) warnings.push("Spot is zero; percentage moves are unavailable.");
  const dates = position.asOf === prepared.expiryDate ? [position.asOf]
    : Array.from({ length: 5 }, (_, index) => position.asOf + (prepared.expiryDate - position.asOf) * index / 4);
  const anchor = position.spot || Math.max(...position.legs.map((leg) => leg.strike));
  const low = Math.max(0, position.spot * (1 - spotRange));
  const high = anchor * (1 + spotRange);
  if (!finite(high)) throw new Error("Spot range exceeds model precision.");
  // Even steps put spot on its own row; strikes and breakevens inside the range
  // are rows too, so the profit zone of a spread is never hidden between steps.
  const row = (spot: number, landmark?: ScenarioGridRow["landmark"]): ScenarioGridRow => ({
    spot, move: position.spot > 0 ? spot / position.spot - 1 : null, ...(landmark ? { landmark } : {}),
    values: dates.map((date) => aggregate(prepared, spot, date, volShift).pnl) });
  const steps = Array.from({ length: SCENARIO_GRID_STEPS + 1 }, (_, index) => low + (high - low) * index / SCENARIO_GRID_STEPS);
  // Only a landmark that coincides with a step is skipped; a strike a fraction
  // of a percent away still gets its own row, since it is the number a reader
  // wants to find.
  const near = (spot: number) => steps.some((step) => Math.abs(step - spot) <= Math.max(spot, 1) * 1e-6);
  const grid = [...steps.map((spot) => row(spot)),
    ...[...new Set(position.legs.map((leg) => leg.strike))].filter((spot) => spot > low && spot < high && !near(spot)).map((spot) => row(spot, "strike")),
    ...risk.breakevens.filter((spot) => spot > low && spot < high && !near(spot)).map((spot) => row(spot, "breakeven"))]
    .sort((a, b) => a.spot - b.spot);
  // Include all kinks and roots so strikes outside the spot grid remain visible.
  const landmarks = [...position.legs.map((leg) => leg.strike), ...risk.breakevens];
  const chartLow = Math.max(0, Math.min(low, ...landmarks.map((spot) => spot * 0.95)));
  const chartHigh = Math.max(high, ...landmarks.map((spot) => spot * 1.05));
  if (!finite(chartHigh)) throw new Error("Payoff range exceeds model precision.");
  const chartSpots = [...new Set([...landmarks, position.spot,
    ...Array.from({ length: 81 }, (_, index) => chartLow + (chartHigh - chartLow) * index / 80)])].sort((a, b) => a - b);
  const payoff = chartSpots.map((spot) => ({ spot,
    selected: aggregate(prepared, spot, controls.date, volShift).pnl,
    expiry: aggregate(prepared, spot, prepared.expiryDate, volShift).pnl }));
  return { position, controls, valuation: aggregate(prepared, position.spot, controls.date, volShift),
    expiryRisk: risk, dates, grid, payoff, expiryDate: prepared.expiryDate, warnings };
}
