import { valueOption, type ImpliedVolatilityResult, type OptionCalcDraft, type OptionValuation } from "./model";

const DAYS_PER_YEAR = 365;
export const DEFAULT_BINOMIAL_STEPS = 400;
export const MAX_BINOMIAL_STEPS = 2000;
const MAX_EFFECTIVE_STEPS = 4096;
const MAX_GRID_POINTS = 25_000;
const MAX_GRID_WORK = 20_000_000;

export interface CashDividend {
  /** Calendar days from valuation; American exercise is allowed immediately before the cash event. */
  days: number;
  /** Cash per underlying unit; any excess over spot is forfeited at the zero floor. */
  amount: number;
}

export interface BinomialInputs {
  exercise: "american" | "european";
  steps: number;
  dividends: CashDividend[];
}

interface PreparedInputs extends BinomialInputs {
  years: number;
  effectiveSteps: number;
  dx: number;
  probability: number;
  discount: number;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const intrinsic = (draft: OptionCalcDraft, spot: number) => Math.max(0, draft.side === "call" ? spot - draft.strike : draft.strike - spot);

export function validateBinomialInputs(draft: OptionCalcDraft, input: Partial<BinomialInputs> = {}): string | null {
  if (!draft || typeof draft !== "object") return "Option inputs are required.";
  if (draft.side !== "call" && draft.side !== "put") return "Side must be call or put.";
  for (const [key, label] of [["spot", "Spot"], ["strike", "Strike"], ["daysToExpiry", "Days to expiry"], ["volatility", "Volatility"]] as const) {
    if (!finite(draft[key]) || draft[key] < 0) return `${label} must be finite and nonnegative.`;
  }
  if (!finite(draft.rate) || !finite(draft.dividendYield)) return "Rate and continuous dividend yield must be finite.";
  if (!input || typeof input !== "object" || Array.isArray(input)) return "Binomial settings must be an object.";
  const exercise = input.exercise === undefined ? "american" : input.exercise;
  if (exercise !== "american" && exercise !== "european") return "Exercise must be american or european.";
  const steps = input.steps === undefined ? DEFAULT_BINOMIAL_STEPS : input.steps;
  if (!Number.isInteger(steps) || steps < 1 || steps > MAX_BINOMIAL_STEPS) return `Tree steps must be an integer from 1 to ${MAX_BINOMIAL_STEPS}.`;
  const dividends = input.dividends === undefined ? [] : input.dividends;
  if (!Array.isArray(dividends) || dividends.length > 64) return "Supply at most 64 discrete cash dividends.";
  for (const dividend of dividends) {
    if (!dividend || typeof dividend !== "object" || !finite(dividend.days) || dividend.days < 0 || dividend.days > draft.daysToExpiry) {
      return "Dividend dates must be finite days from valuation through expiry.";
    }
    if (!finite(dividend.amount) || dividend.amount < 0) return "Dividend cash amounts must be finite and nonnegative.";
  }
  return null;
}

function prepare(draft: OptionCalcDraft, input: Partial<BinomialInputs>): PreparedInputs {
  const problem = validateBinomialInputs(draft, input);
  if (problem) throw new Error(problem);
  const byDate = new Map<number, number>();
  for (const dividend of input.dividends ?? []) {
    if (dividend.amount === 0) continue;
    const amount = (byDate.get(dividend.days) ?? 0) + dividend.amount;
    if (!finite(amount)) throw new Error("Dividend amounts exceed model precision.");
    byDate.set(dividend.days, amount);
  }
  const dividends = [...byDate].sort((a, b) => a[0] - b[0]).map(([days, amount]) => ({ days, amount }));
  const steps = input.steps ?? DEFAULT_BINOMIAL_STEPS;
  const years = draft.daysToExpiry / DAYS_PER_YEAR;
  const base = { exercise: input.exercise ?? "american", steps, dividends, years } as const;
  if (years === 0 || draft.volatility === 0 || draft.spot === 0 || (draft.strike === 0 && dividends.length === 0)) {
    return { ...base, effectiveSteps: steps, dx: 0, probability: 0, discount: 1 };
  }
  const carry = draft.rate - draft.dividendYield;
  // CRR requires |carry| dt < sigma sqrt(dt). Increase time resolution;
  // clipping a probability would silently price a different carry process.
  const required = Math.ceil((carry / draft.volatility) ** 2 * years * (1 + 1e-10));
  let effectiveSteps = Math.max(steps, required);
  for (; effectiveSteps <= MAX_EFFECTIVE_STEPS; effectiveSteps = Math.max(effectiveSteps + 1, effectiveSteps * 2)) {
    const dt = years / effectiveSteps;
    const dx = draft.volatility * Math.sqrt(dt);
    if (dx > 0 && (Math.exp(dx) === 1 || Math.exp(-dx) === 1)) throw new Error("Tree increments are below floating-point resolution.");
    const probability = Math.expm1(carry * dt + dx) / Math.expm1(2 * dx);
    const discount = Math.exp(-draft.rate * dt);
    if (!finite(dx) || dx <= 0 || !finite(discount) || discount <= 0) break;
    if (finite(probability) && probability > 0 && probability < 1) {
      return { ...base, effectiveSteps, dx, probability, discount };
    }
  }
  throw new Error("Carry and volatility need more tree steps than the supported resolution.");
}

/** Effective refinement is exposed so callers can explain the numerical method used. */
export function effectiveBinomialSteps(draft: OptionCalcDraft, input: Partial<BinomialInputs> = {}): number {
  return prepare(draft, input).effectiveSteps;
}

function finitePrice(value: number): number {
  if (!finite(value)) throw new Error("Option inputs exceed binomial model precision.");
  return Math.max(0, value);
}

/** Exact deterministic carry and cash jumps, including interior exercise optima. */
function deterministicPrice(draft: OptionCalcDraft, inputs: PreparedInputs): number {
  const rate = draft.rate, yieldRate = draft.dividendYield, carry = rate - yieldRate;
  let time = 0;
  let spot = draft.spot;
  let best = intrinsic(draft, spot);
  const at = (s: number, t: number) => finitePrice(intrinsic(draft, s) * Math.exp(-rate * t));
  const advance = (end: number) => {
    const duration = end - time;
    // Discounted intrinsic is a difference of two exponentials. Endpoints
    // plus its one possible stationary point exhaust every exercise choice.
    const ratio = rate * draft.strike / (yieldRate * spot);
    if (inputs.exercise === "american" && duration > 0 && carry !== 0 && ratio > 0 && finite(ratio)) {
      const stationary = Math.log(ratio) / carry;
      if (stationary > 0 && stationary < duration) best = Math.max(best, at(spot * Math.exp(carry * stationary), time + stationary));
    }
    if (spot > 0) spot *= Math.exp(carry * duration);
    if (!finite(spot)) throw new Error("Deterministic stock carry exceeds model precision.");
    time = end;
    if (inputs.exercise === "american") best = Math.max(best, at(spot, time));
  };
  for (const dividend of inputs.dividends) {
    advance(dividend.days / DAYS_PER_YEAR);
    spot = Math.max(0, spot - dividend.amount);
    if (inputs.exercise === "american") best = Math.max(best, at(spot, time));
  }
  advance(inputs.years);
  return inputs.exercise === "american" ? best : at(spot, time);
}

/** Standard triangular CRR is exact for the chosen mesh when no cash jump occurs. */
function recombiningPrice(draft: OptionCalcDraft, inputs: PreparedInputs): number {
  const { effectiveSteps: n, dx, probability: p, discount } = inputs;
  const logSpot = Math.log(draft.spot);
  if (logSpot + n * dx > 700) throw new Error("Tree stock range exceeds model precision.");
  const values = new Float64Array(n + 1);
  for (let j = 0; j <= n; j += 1) values[j] = intrinsic(draft, Math.exp(logSpot + (2 * j - n) * dx));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = 0; j <= i; j += 1) {
      const continuation = discount * ((1 - p) * values[j]! + p * values[j + 1]!);
      values[j] = inputs.exercise === "american"
        ? Math.max(continuation, intrinsic(draft, Math.exp(logSpot + (2 * j - i) * dx))) : continuation;
    }
  }
  return finitePrice(values[0]!);
}

/**
 * CRR on a fixed log-spot mesh. A cash jump interpolates in absolute spot,
 * retaining the cash amount at every node rather than reducing today's spot.
 * The explicit zero state absorbs jumps larger than the underlying value.
 */
function cashDividendPrice(draft: OptionCalcDraft, inputs: PreparedInputs): number {
  const { effectiveSteps: n, dx, probability: p, discount } = inputs;
  const logSpot = Math.log(draft.spot);
  const smallestScale = Math.min(draft.spot, ...(draft.strike > 0 ? [draft.strike] : []), ...inputs.dividends.map((dividend) => dividend.amount));
  // Extend below the ordinary tree to cover post-cash spots and the payoff's
  // lowest scale. Between zero and the last positive node, use linear value.
  const lowerIndex = -n - Math.ceil(Math.max(0, logSpot - Math.log(smallestScale)) / dx);
  const upperIndex = n;
  const length = upperIndex - lowerIndex + 1;
  if (length > MAX_GRID_POINTS || length * n > MAX_GRID_WORK || logSpot + n * dx > 700) {
    throw new Error("Cash dividends need a stock grid beyond the supported resolution; reduce steps or review the inputs.");
  }
  const spots = new Float64Array(length);
  const values = new Float64Array(length);
  for (let j = 0; j < length; j += 1) {
    spots[j] = Math.exp(logSpot + (lowerIndex + j) * dx);
    values[j] = intrinsic(draft, spots[j]!);
  }
  if (spots[0] === 0 || !finite(spots.at(-1))) throw new Error("Cash-dividend grid exceeds model precision.");
  const cashByStep = new Map<number, number>();
  for (const dividend of inputs.dividends) {
    const step = Math.round(dividend.days / draft.daysToExpiry * n);
    const amount = (cashByStep.get(step) ?? 0) + dividend.amount;
    if (!finite(amount)) throw new Error("Dividend amounts exceed model precision.");
    cashByStep.set(step, amount);
  }
  let zeroValue = intrinsic(draft, 0);
  const jump = (amount: number) => {
    let cursor = length - 2;
    // Descending writes leave every lower post-dividend value intact until it
    // has been consumed. The interpolation weights are always in [0,1].
    for (let j = length - 1; j >= 0; j -= 1) {
      const afterSpot = Math.max(0, spots[j]! - amount);
      let value = zeroValue;
      if (afterSpot > 0 && afterSpot <= spots[0]!) value += (values[0]! - zeroValue) * afterSpot / spots[0]!;
      else if (afterSpot > spots[0]!) {
        while (cursor > 0 && spots[cursor]! > afterSpot) cursor -= 1;
        const fraction = (afterSpot - spots[cursor]!) / (spots[cursor + 1]! - spots[cursor]!);
        value = values[cursor]! * (1 - fraction) + values[cursor + 1]! * fraction;
      }
      values[j] = inputs.exercise === "american" ? Math.max(value, intrinsic(draft, spots[j]!)) : value;
    }
  };
  if (cashByStep.has(n)) jump(cashByStep.get(n)!);
  const down = Math.exp(-dx), up = Math.exp(dx);
  for (let i = n - 1; i >= 0; i -= 1) {
    const priorZero = zeroValue;
    let lower = priorZero + (values[0]! - priorZero) * down;
    // The upper boundary cannot be reached from the origin before maturity:
    // there are n up moves to it and cash jumps move only downward.
    const highSlope = (values[length - 1]! - values[length - 2]!) / (spots[length - 1]! - spots[length - 2]!);
    const higher = values[length - 1]! + highSlope * spots[length - 1]! * (up - 1);
    for (let j = 0; j < length; j += 1) {
      const previous = values[j]!;
      const upper = j + 1 < length ? values[j + 1]! : higher;
      const continuation = discount * ((1 - p) * lower + p * upper);
      values[j] = inputs.exercise === "american" ? Math.max(continuation, intrinsic(draft, spots[j]!)) : continuation;
      lower = previous;
    }
    zeroValue = inputs.exercise === "american" ? Math.max(discount * priorZero, intrinsic(draft, 0)) : discount * priorZero;
    if (cashByStep.has(i)) jump(cashByStep.get(i)!);
  }
  return finitePrice(values[-lowerIndex]!);
}

function preparedPrice(draft: OptionCalcDraft, inputs: PreparedInputs): number {
  if (inputs.dx === 0) return deterministicPrice(draft, inputs);
  return inputs.dividends.length ? cashDividendPrice(draft, inputs) : recombiningPrice(draft, inputs);
}

export function priceBinomialOption(draft: OptionCalcDraft, input: Partial<BinomialInputs> = {}): number {
  return preparedPrice(draft, prepare(draft, input));
}

/** Greeks are currency per underlying unit, per calendar day and per percentage point. */
export function valueBinomialOption(draft: OptionCalcDraft, input: Partial<BinomialInputs> = {}): OptionValuation {
  const prepared = prepare(draft, input);
  const price = preparedPrice(draft, prepared);
  const immediate = intrinsic(draft, draft.spot);
  if (draft.daysToExpiry === 0 && prepared.dividends.length === 0) return valueOption(draft);
  if (prepared.exercise === "american" && immediate > 0 && Math.abs(price - immediate) < 1e-9 * Math.max(1, price)) {
    return { price, delta: draft.side === "call" ? 1 : -1, gamma: 0, thetaPerDay: 0, vegaPerPoint: 0, rhoPerPoint: 0 };
  }
  const priceAt = (patch: Partial<OptionCalcDraft>, options: Partial<BinomialInputs> = prepared) =>
    priceBinomialOption({ ...draft, ...patch }, options);
  // A complete CRR lattice interval avoids the zero/noisy gamma of a tiny
  // bump between two terminal strike kinks. Use unequal-step derivatives.
  const logBump = prepared.dx > 0 ? 2 * prepared.dx : 0.0001;
  const upSpot = draft.spot > 0 ? draft.spot * Math.exp(logBump) : 0.0001;
  const downSpot = draft.spot > 0 ? draft.spot * Math.exp(-logBump) : 0;
  const upPrice = priceAt({ spot: upSpot });
  const downPrice = draft.spot > 0 ? priceAt({ spot: downSpot }) : price;
  const hUp = upSpot - draft.spot, hDown = draft.spot - downSpot;
  const delta = draft.spot > 0
    ? (hDown ** 2 * (upPrice - price) + hUp ** 2 * (price - downPrice)) / (hUp * hDown * (hUp + hDown))
    : (upPrice - price) / hUp;
  const gamma = draft.spot > 0 && draft.volatility > 0 && draft.daysToExpiry > 0
    ? 2 * ((upPrice - price) / hUp - (price - downPrice) / hDown) / (hUp + hDown) : 0;
  const volBump = Math.max(0.005, draft.volatility * 0.025);
  const lowVol = Math.max(0, draft.volatility - volBump);
  const vegaPerPoint = draft.volatility > 0 && draft.daysToExpiry > 0
    ? (priceAt({ volatility: draft.volatility + volBump }) - priceAt({ volatility: lowVol })) / (draft.volatility + volBump - lowVol) / 100 : 0;
  const rateBump = 0.0001;
  const rhoPerPoint = draft.daysToExpiry > 0
    ? (priceAt({ rate: draft.rate + rateBump }) - priceAt({ rate: draft.rate - rateBump })) / (2 * rateBump) / 100 : 0;
  const nextDividend = prepared.dividends.find((dividend) => dividend.days > 0)?.days ?? Infinity;
  const dayBump = Math.min(1, draft.daysToExpiry * 0.01, nextDividend / 4);
  const todayCash = prepared.dividends.filter((dividend) => dividend.days === 0).reduce((total, dividend) => total + dividend.amount, 0);
  const thetaPerDay = dayBump > 0 ? (priceAt({ daysToExpiry: draft.daysToExpiry - dayBump,
    spot: Math.max(0, draft.spot - todayCash) }, { ...prepared,
    dividends: prepared.dividends.filter((dividend) => dividend.days > 0)
      .map((dividend) => ({ ...dividend, days: dividend.days - dayBump })) }) - price) / dayBump : 0;
  const result = { price, delta, gamma, thetaPerDay, vegaPerPoint, rhoPerPoint };
  if (!Object.values(result).every(Number.isFinite)) throw new Error("Greeks exceed binomial model precision.");
  return result;
}

/** Solve against the selected exercise and cash schedule, with a 500% IV ceiling. */
export function solveBinomialImpliedVolatility(
  draft: OptionCalcDraft, marketPrice: number, input: Partial<BinomialInputs> = {},
): ImpliedVolatilityResult {
  if (marketPrice === 0) return { volatility: null, note: null };
  if (!finite(marketPrice) || marketPrice < 0) return { volatility: null, note: "Market price must be finite and positive." };
  const problem = validateBinomialInputs(draft, input);
  if (problem) return { volatility: null, note: problem };
  if (draft.daysToExpiry <= 0) return { volatility: null, note: "Expired, no implied volatility." };
  if (draft.spot <= 0 || draft.strike <= 0) return { volatility: null, note: "Needs positive spot and strike to identify IV." };
  const years = draft.daysToExpiry / DAYS_PER_YEAR;
  const american = (input.exercise ?? "american") === "american";
  const upper = draft.side === "call" ? draft.spot * Math.exp(-draft.dividendYield * years)
    : draft.strike * Math.exp(-draft.rate * years);
  const bound = american ? Math.max(upper, draft.side === "call" ? draft.spot : draft.strike) : upper;
  const tolerance = Math.max(1, draft.spot, draft.strike) * 1e-8;
  if (!finite(bound)) return { volatility: null, note: "Inputs exceed model precision." };
  if (marketPrice >= bound - tolerance) return { volatility: null, note: marketPrice > bound + tolerance
    ? "Market price is above the model's no-arbitrage maximum." : "No finite IV at the model maximum." };
  if (american && marketPrice < intrinsic(draft, draft.spot) - tolerance) {
    return { volatility: null, note: "Market price is below immediate exercise value." };
  }
  if (american && intrinsic(draft, draft.spot) > 0 && Math.abs(marketPrice - intrinsic(draft, draft.spot)) <= tolerance) {
    return { volatility: null, note: "Price is at the exercise bound; volatility is not identifiable." };
  }
  try {
    const priceAt = (volatility: number) => priceBinomialOption({ ...draft, volatility }, input);
    const atZero = priceAt(0);
    if (atZero === marketPrice) return { volatility: 0, note: null };
    if (Math.abs(atZero - marketPrice) <= tolerance) return { volatility: null, note: "Market price is too close to the zero-volatility bound to resolve IV." };
    const observations: Array<{ volatility: number; price: number }> = [{ volatility: 0, price: atZero }];
    for (const volatility of [0.05, 0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 5]) {
      try { observations.push({ volatility, price: priceAt(volatility) }); }
      catch (error) { if (volatility === 5) throw error; }
    }
    const exact = observations.filter((point) => Math.abs(point.price - marketPrice) <= tolerance);
    const brackets = observations.slice(1).flatMap((point, index) => {
      const previous = observations[index]!;
      return Math.abs(previous.price - marketPrice) > tolerance && Math.abs(point.price - marketPrice) > tolerance
        && (previous.price - marketPrice) * (point.price - marketPrice) < 0 ? [[previous, point] as const] : [];
    });
    if (exact.length + brackets.length > 1) return { volatility: null, note: "Cash-dividend model has multiple IV candidates; volatility is not uniquely identified." };
    if (exact[0]) return { volatility: exact[0].volatility, note: null };
    if (!brackets.length) return { volatility: null, note: marketPrice > Math.max(...observations.map((point) => point.price))
      ? "Market price implies volatility above 500%." : "Market price is below the prices resolved by this tree." };
    let [low, high] = brackets[0]!;
    for (let i = 0; i < 60 && high.volatility - low.volatility > 1e-7; i += 1) {
      const volatility = (low.volatility + high.volatility) / 2;
      const price = priceAt(volatility);
      if (Math.abs(price - marketPrice) <= tolerance) return { volatility, note: null };
      if ((price - marketPrice) * (low.price - marketPrice) > 0) low = { volatility, price };
      else high = { volatility, price };
    }
    const volatility = (low.volatility + high.volatility) / 2;
    return Math.abs(priceAt(volatility) - marketPrice) <= tolerance ? { volatility, note: null }
      : { volatility: null, note: "Tree mesh cannot resolve IV at this price; increase the number of steps." };
  } catch (error) {
    return { volatility: null, note: error instanceof Error ? error.message : String(error) };
  }
}
