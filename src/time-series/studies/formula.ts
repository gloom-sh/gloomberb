import { alignTimeSeries } from "../alignment";
import type { ChartStudySpec, ResolvedSeries, TimeSeriesPoint } from "../types";
import { isFiniteNumber } from "../../utils/guards";
import { continuousFuturesRoot, futuresContractCode, futuresContractMonth, futuresGenericListing } from "../../utils/futures-generic";
import { GALLONS_PER_BARREL, isBarrelsPerTonne, perBarrelUnit, perTonneUnit } from "../price-units";
import { derivedPoint, outputSeries } from "./shared";
import {
  combinedUnit,
  derivedValueDecimals,
  fxConversionIssue,
  isPriceGroup,
  knownUnitSignature,
  legName,
  percentBasisPointRatioScale,
  percentBasisPointUnit,
  PLAIN_RATIO_UNIT,
  unitMismatchMessage,
  type SeriesUnit,
} from "./units";

interface FormulaLeg {
  /** The input's place in the study's inputs. */
  index: number;
  /** Its multiplier, its sign included. */
  weight: number;
  /** The multiplier carries the 42 gallons that make a per-gallon price per barrel. */
  perBarrel: boolean;
  /** The barrels in a tonne the multiplier carries (7.45 for gasoil), making a per-barrel price per tonne. */
  perTonne: number | null;
  /** The multiplier carries 100 (1), making a percent basis points, or 0.01 (-1), making basis points a percent. */
  percentBp: 1 | -1 | null;
}

export interface FormulaTerms {
  /** The inputs the formula adds up. */
  legs: FormulaLeg[];
  /** The inputs the whole sum is multiplied (1) or divided (-1) by: `/EURUSD=X`. */
  factors: Array<{ index: number; power: 1 | -1 }>;
  divisor: number;
  /**
   * The leg (its input's place) whose delivery month every other leg is priced
   * in, all rolling together on its roll day: CL=F in the 3-2-1 crack. Null
   * for a formula of its legs as served.
   */
  leader: number | null;
  /** For a leg priced in its leader's month, the input holding its next listed month (RB2 beside RB=F), by the leg's input. */
  nextMonths: ReadonlyMap<number, number>;
  /** What the formula is called, a catalog series' name (`3-2-1 crack`); null to name it by its terms. */
  name: string | null;
}

/** The study parameter naming the leg (1-based) a formula's legs take their delivery month from. */
export const FORMULA_ROLLS_WITH = "rollsWith";
/** The study parameter, per input, naming the leg (1-based) whose next listed month the input holds. */
export const FORMULA_NEXT_MONTH_OF = "nextMonthOf";
/** The study parameter holding a catalog formula's name. */
export const FORMULA_NAME = "name";

/** The inputs a formula holds a leg's next listed month in, by place: no leg or factor of its own. */
export function formulaNextMonthInputs(spec: Pick<ChartStudySpec, "parameters" | "inputSeriesIds">): Set<number> {
  return new Set(spec.inputSeriesIds.flatMap((_, index) => isFiniteNumber(spec.parameters[`${FORMULA_NEXT_MONTH_OF}${index + 1}`]) ? [index] : []));
}

/**
 * A formula study's terms: `weight1`, `perBarrel1`, `perTonne1`, `percentBp1` ... per
 * input it adds up, `power1` ... (1 or -1) per input it multiplies or divides
 * the sum by, and an optional `divisor`. A saved or hand-edited spec can carry
 * a multiplier or divisor no formula was written with (a value that is not a
 * number is dropped when the spec loads, so it arrives missing); that is an
 * error, not a silent 1.
 */
export function formulaTerms(spec: ChartStudySpec, inputs: readonly (ResolvedSeries | undefined)[]): FormulaTerms | { error: string } {
  const legs: FormulaLeg[] = [];
  const factors: FormulaTerms["factors"] = [];
  const nextMonths = new Map<number, number>();
  for (const [index, input] of inputs.entries()) {
    const nextOf = spec.parameters[`${FORMULA_NEXT_MONTH_OF}${index + 1}`];
    if (isFiniteNumber(nextOf)) {
      // A leg's next month that did not load leaves the leg in its own month.
      if (input) nextMonths.set(nextOf - 1, index);
      continue;
    }
    if (!input) return { error: "A series of the formula did not load; write the formula again." };
    const power = spec.parameters[`power${index + 1}`];
    if (power !== undefined) {
      if (power !== 1 && power !== -1) return { error: `The formula neither multiplies nor divides by ${legName(input)}; write the formula again.` };
      factors.push({ index, power });
      continue;
    }
    const weight = spec.parameters[`weight${index + 1}`];
    if (!isFiniteNumber(weight)) return { error: `The multiplier of ${legName(input)} is missing or not a number; write the formula again.` };
    if (weight === 0) return { error: `${legName(input)} has a multiplier of 0, which removes it; leave it out of the formula instead.` };
    const perTonne = spec.parameters[`perTonne${index + 1}`];
    const percentBp = spec.parameters[`percentBp${index + 1}`];
    legs.push({
      index,
      weight,
      perBarrel: spec.parameters[`perBarrel${index + 1}`] === 1,
      perTonne: isFiniteNumber(perTonne) && isBarrelsPerTonne(perTonne) ? perTonne : null,
      percentBp: percentBp === 1 || percentBp === -1 ? percentBp : null,
    });
  }
  if (legs.length === 0) return { error: "The formula has no series to add up, only series it divides by; write the formula again." };
  const divisor = spec.parameters.divisor ?? 1;
  if (!isFiniteNumber(divisor)) return { error: "The formula's divisor is not a number; write the formula again." };
  if (divisor === 0) return { error: "A formula cannot be divided by 0." };
  const rollsWith = spec.parameters[FORMULA_ROLLS_WITH];
  const leader = isFiniteNumber(rollsWith) && legs.some((leg) => leg.index === rollsWith - 1) ? rollsWith - 1 : null;
  const name = spec.parameters[FORMULA_NAME];
  return { legs, factors, divisor, leader, nextMonths, name: typeof name === "string" && name.trim() ? name.trim() : null };
}

/**
 * A leg's unit once its multiplier is applied: 42 gallons of a per-gallon
 * price are a barrel's worth, 7.45 barrels of gasoil a tonne's, and 100 times
 * a percent is basis points.
 */
function formulaLegUnit(leg: FormulaLeg, input: ResolvedSeries): SeriesUnit {
  const converted = leg.percentBp ? percentBasisPointUnit(input.unit, leg.percentBp) : null;
  if (converted) return converted;
  const unit = leg.perBarrel ? perBarrelUnit(input.unit) : input.unit;
  return { unit: leg.perTonne ? perTonneUnit(unit) : unit, unitGroup: input.unitGroup };
}

/** Why a formula's legs cannot be summed, or null when every leg counts the same known unit. */
function formulaUnitMismatch(terms: FormulaTerms, inputs: readonly (ResolvedSeries | undefined)[]): string | null {
  if (terms.legs.length < 2) return null;
  // A 100 or 0.01 times the whole formula converts each leg it can: one it cannot convert beside one it does
  // (a bp leg beside a % one, `(FRED:DGS5 - CAP:cdx:ig)*100`) would chart 100 times its basis points as basis points.
  const scaled = terms.legs.filter((leg) => leg.percentBp !== null);
  const converts = (leg: FormulaLeg) => percentBasisPointUnit(inputs[leg.index]!.unit, leg.percentBp!) !== null;
  const converted = scaled.find(converts);
  const unconverted = scaled.find((leg) => !converts(leg));
  if (converted && unconverted) {
    const [one, other] = [converted, unconverted].sort((left, right) => left.index - right.index);
    return unitMismatchMessage("formula", { series: inputs[one!.index]!, unit: inputs[one!.index]!.unit },
      { series: inputs[other!.index]!, unit: inputs[other!.index]!.unit });
  }
  const legs = terms.legs.map((leg) => ({ series: inputs[leg.index]!, ...formulaLegUnit(leg, inputs[leg.index]!) }));
  const signatures = legs.map((leg) => knownUnitSignature(leg));
  const other = signatures.findIndex((signature, index) => index > 0 && (signature === null || signature !== signatures[0]));
  if (signatures[0] !== null && other < 0) return null;
  return unitMismatchMessage("formula", legs[0]!, legs[Math.max(1, other)]!);
}

function formatFormulaNumber(value: number): string {
  return String(Number(value.toPrecision(10)));
}

/**
 * A formula as the legend names it, from the terms it was written with:
 * `42×HO=F - CL=F`, `(2×42×RB=F + 42×HO=F - 3×CL=F)/3`, `(42×HO=F - BZ=F)/EURUSD=X`.
 */
function formulaLabel(inputs: readonly (ResolvedSeries | undefined)[], terms: FormulaTerms): string {
  const sum = terms.legs.map((leg, position) => {
    const magnitude = Math.abs(leg.weight);
    // The conversions it carries are named as written: 7.45×42×HO=F.
    const conversions = [...(leg.perTonne ? [leg.perTonne] : []), ...(leg.perBarrel ? [GALLONS_PER_BARREL] : [])];
    const count = conversions.reduce((rest, factor) => rest / factor, magnitude);
    const factors = [...(Math.abs(count - 1) < 1e-9 ? [] : [formatFormulaNumber(count)]), ...conversions.map(String)];
    const term = [...factors, legName(inputs[leg.index]!)].join("×");
    if (position === 0) return leg.weight < 0 ? `-${term}` : term;
    return `${leg.weight < 0 ? "-" : "+"} ${term}`;
  }).join(" ");
  if (terms.divisor === 1 && terms.factors.length === 0) return sum;
  return [
    `(${sum})`,
    ...(terms.divisor === 1 ? [] : [`/${formatFormulaNumber(terms.divisor)}`]),
    ...terms.factors.map(({ index, power }) => `${power < 0 ? "/" : "×"}${legName(inputs[index]!)}`),
  ].join("");
}

/**
 * Every input's value on each date they share, each carried forward to the
 * others' dates, with the point each was read from (by the input's place;
 * an input the sum does not read is left out of the dates).
 */
function alignedSamples(inputs: readonly (ResolvedSeries | undefined)[], summed: readonly number[]): Array<{ point: TimeSeriesPoint; values: number[]; points: TimeSeriesPoint[] }> {
  const read = summed.map((index) => inputs[index]!);
  return alignTimeSeries(read, { mode: "intersection", carryForward: true }).flatMap((row) => {
    const aligned = read.map((input) => row.values[input.id]);
    if (aligned.some((entry) => !isFiniteNumber(entry?.value))) return [];
    const availability = Math.max(...aligned.map((entry) => entry!.point.availableAt?.getTime() ?? entry!.point.date.getTime()));
    const values: number[] = [];
    const points: TimeSeriesPoint[] = [];
    summed.forEach((index, position) => {
      values[index] = aligned[position]!.value as number;
      points[index] = aligned[position]!.point;
    });
    return [{
      values,
      points,
      point: {
        date: new Date(row.date),
        observedAt: new Date(row.date),
        availableAt: Number.isFinite(availability) ? new Date(availability) : undefined,
        value: null,
        provenance: { quality: "derived" as const },
      },
    }];
  });
}

/**
 * A weighted sum of the legs over a divisor, in the unit the legs share once
 * converted, then times or over the series it is scaled by, in the unit
 * that arithmetic leaves: a crack in USD / barrel over EURUSD=X is EUR / barrel.
 */
/**
 * A formula's unit: its legs' once converted, then times or over each series
 * it is scaled by. Legs that count different units, or an FX rate the wrong
 * way up, are an error that says why: a crack over USDJPY=X is no price, and
 * times it JPY / barrel.
 */
export function formulaUnit(terms: FormulaTerms, inputs: readonly (ResolvedSeries | undefined)[]): SeriesUnit | { error: string } {
  const mismatch = formulaUnitMismatch(terms, inputs);
  if (mismatch) return { error: mismatch };
  const first = inputs[terms.legs[0]!.index]!;
  let unit: SeriesUnit = formulaLegUnit(terms.legs[0]!, first);
  for (const factor of terms.factors) {
    const series = inputs[factor.index]!;
    // A percent over basis points, or basis points over a percent, is a plain number (formulaFactorScale).
    if (factor.power < 0 && percentBasisPointRatioScale(unit, series) !== null) {
      unit = PLAIN_RATIO_UNIT;
      continue;
    }
    const next = combinedUnit(unit, series, factor.power);
    const issue = fxConversionIssue(unit, series, factor.power, next);
    if (issue) return { error: issue };
    unit = next;
  }
  return unit;
}

/**
 * What each series a formula divides by scales its value by besides itself:
 * 100 over basis points when the formula is in %, 0.01 over a percent when it
 * is in bp, so the two cancel to a plain number; 1 otherwise.
 */
function formulaFactorScales(terms: FormulaTerms, inputs: readonly (ResolvedSeries | undefined)[]): number[] {
  let unit: SeriesUnit = formulaLegUnit(terms.legs[0]!, inputs[terms.legs[0]!.index]!);
  return terms.factors.map((factor) => {
    const series = inputs[factor.index]!;
    const scale = factor.power < 0 ? percentBasisPointRatioScale(unit, series) : null;
    unit = scale !== null ? PLAIN_RATIO_UNIT : combinedUnit(unit, series, factor.power);
    return scale ?? 1;
  });
}

/** A leg that follows the front month (`CL=F`, `CL1`), whose contract changes as it rolls; a listed contract or a stock does not. */
function isContinuousLeg(symbol: string): boolean {
  return continuousFuturesRoot(symbol) != null || futuresGenericListing(symbol) != null;
}

/**
 * A continuous leg's live bar: the quote's, after the last bar the source
 * served, which names no contract. It is the contract of the bar before
 * until the source serves the session.
 */
function liveBarContract(input: ResolvedSeries): { time: number; contract: string } | null {
  const [before, last] = input.points.slice(-2);
  if (!last || last.contract || !before?.contract || !isContinuousLeg(input.listing?.symbol ?? "")) return null;
  return { time: last.date.getTime(), contract: before.contract };
}

/** A leg's contract on a date: its bar's (a continuous future's), or the listed contract it is (RBZ26). */
function legContract(input: ResolvedSeries, point: TimeSeriesPoint | undefined, live?: { time: number; contract: string } | null): string | null {
  if (point?.contract) return point.contract;
  if (point && live && point.date.getTime() === live.time) return live.contract;
  const symbol = input.listing?.symbol ?? "";
  return futuresContractMonth(symbol) ? symbol.replace(/\.[A-Za-z]+$/, "").toUpperCase() : null;
}

const DAY_MS = 86_400_000;
/** Rolls a note names, the latest first; earlier ones are counted. */
const LISTED_ROLLS = 3;

/**
 * The chart period a bar is in. A continuous future dates its week or month
 * at the start (Monday, the 1st) and a generic at its last session (Friday,
 * the 30th), so a leg's next month is read in the leg's own period, not on
 * its day: the ISO week, the calendar month, else the UTC day.
 */
function periodKey(date: Date, resolution: string | null | undefined): number {
  const day = Math.floor(date.getTime() / DAY_MS);
  // Day 0, 1 January 1970, was a Thursday: three days on, each week starts on a Monday.
  if (resolution === "1wk") return Math.floor((day + 3) / 7);
  if (resolution === "1mo") return date.getUTCFullYear() * 12 + date.getUTCMonth();
  return day;
}

/** A series' points by the period they are in, the latest a period holds. */
function pointsByPeriod(series: ResolvedSeries | undefined, resolution: string | null | undefined): Map<number, TimeSeriesPoint> {
  return new Map((series?.points ?? []).map((point) => [periodKey(point.date, resolution), point]));
}

/**
 * Each leg's price and contract on a date. A formula with a leader prices
 * every other leg in the leader's delivery month: a leg still in the month
 * before (RBX26 beside CLZ26, between crude's roll and the products') takes
 * its next listed month (RB2, which is RBZ26 then). Where that month has no
 * price, the leg stays in its own and the date counts as mixed.
 */
function formulaLegPricer(terms: FormulaTerms, inputs: readonly (ResolvedSeries | undefined)[]) {
  const first = inputs[terms.legs[0]!.index]!;
  const resolution = first.barSize ?? first.historyResolution ?? null;
  const nextByLeg = new Map([...terms.nextMonths].map(([leg, input]) => [leg, pointsByPeriod(inputs[input], resolution)] as const));
  const live = new Map(terms.legs.map((leg) => [leg.index, liveBarContract(inputs[leg.index]!)] as const));
  const leaderPosition = terms.leader == null ? -1 : terms.legs.findIndex((leg) => leg.index === terms.leader);
  return (date: Date, values: readonly number[], points: readonly TimeSeriesPoint[]) => {
    let partial = false;
    const legs = terms.legs.map((leg) => {
      const point = points[leg.index];
      if (point?.partial) partial = true;
      return { contract: legContract(inputs[leg.index]!, point, live.get(leg.index)), price: values[leg.index]! };
    });
    const lead = leaderPosition < 0 ? null : futuresContractMonth(legs[leaderPosition]!.contract ?? "");
    if (lead) {
      const period = periodKey(date, resolution);
      terms.legs.forEach((leg, position) => {
        const own = futuresContractMonth(legs[position]!.contract ?? "");
        if (position === leaderPosition || !own || own.month + 1 !== lead.month) return;
        const next = nextByLeg.get(leg.index)?.get(period);
        const price = next?.value ?? next?.close;
        if (!isFiniteNumber(price)) return;
        legs[position] = { contract: futuresContractCode(own.root, lead.month), price };
        if (next?.partial) partial = true;
      });
    }
    return { legs, partial };
  };
}

/**
 * What a futures formula's points say about their months, as a caveat of the
 * data: the bars its continuous legs are in different months (a free formula
 * of front months, `legs in different months on 9 days, the latest
 * 2026-10-28`, or one priced in one month where a leg's next month has no
 * price), and from when their contracts are named, before which a formula
 * priced in one month is each leg's front month. Only the legs that follow
 * the front month count: a calendar spread (`CLZ26 - CLF27`) is in two months
 * by design, and `CL=F - 10*USO` has one month to be in. Null when every
 * point's continuous legs share a month.
 */
export function formulaContractNote(
  series: Pick<ResolvedSeries, "points" | "formulaLeader" | "formulaLegs" | "historyResolution" | "barSize">,
): string | null {
  const continuous = (series.formulaLegs ?? []).flatMap((leg, position) => isContinuousLeg(leg) ? [position] : []);
  if (continuous.length < 2) return null;
  const points = series.points.filter((point) => point.legs?.length && point.value != null);
  // The month of each continuous leg whose bar names its contract.
  const monthsOf = (point: TimeSeriesPoint) => continuous.map((position) => futuresContractMonth(point.legs![position]?.contract ?? "")?.month ?? null);
  const mixed = points.filter((point) => new Set(monthsOf(point).filter((month) => month != null)).size > 1);
  const known = points.findIndex((point) => monthsOf(point).every((month) => month != null));
  const named = points.some((point) => monthsOf(point).some((month) => month != null));
  const parts: string[] = [];
  // A daily chart counts days; a weekly or monthly one, or one of built bars, its bars.
  const unit = !series.barSize && (series.historyResolution ?? "1d") === "1d" ? "day" : "bar";
  if (mixed.length) parts.push(`legs in different months on ${mixed.length} ${unit}${mixed.length === 1 ? "" : "s"}, the latest ${utcDay(mixed.at(-1)!.date)}`);
  // Bars that name no contract (intraday ones) cannot be read in one month.
  if (!named && points.length) {
    parts.push(series.formulaLeader ? "each leg's front month: these bars do not name their contracts" : "these bars do not name the legs' contracts");
  } else if (known > 0) {
    const from = utcDay(points[known]!.date);
    parts.push(series.formulaLeader ? `one delivery month from ${from}, each leg's front month before` : `leg contracts are named from ${from}`);
  }
  return parts.length ? `${parts.join("; ")}.` : null;
}

/**
 * The rolls of a formula priced in its leader's month, as `history` names a
 * front month's: `legs in CL=F's delivery month, rolling with it: to RBZ26,
 * HOZ26, CLZ26 on 2026-10-16 (marked roll)`, the latest few, the rest
 * counted. Null for a formula of front months, or one that did not roll.
 */
export function formulaRollNote(series: Pick<ResolvedSeries, "points" | "formulaLeader">): string | null {
  if (!series.formulaLeader) return null;
  const rolls = series.points.filter((point) => point.roll && point.legs?.length);
  if (!rolls.length) return null;
  const shown = rolls.slice(-LISTED_ROLLS);
  const earlier = rolls.length - shown.length;
  const listed = shown.map((point) => `to ${point.legs!.flatMap((leg) => leg.contract ? [leg.contract] : []).join(", ")} on ${utcDay(point.date)}`);
  return `legs in ${series.formulaLeader}'s delivery month, rolling with it: ${earlier > 0 ? `${earlier} earlier, then ` : ""}${listed.join("; ")} (marked roll)`;
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * A formula's one series: its legs weighed, summed and scaled on every date
 * of any leg. A formula of futures carries each point's leg contracts and
 * prices, its roll and whether a leg's session is still forming; one with a
 * leader (a catalog crack) prices every leg in the leader's delivery month.
 */
export function resolveFormula(
  spec: ChartStudySpec,
  inputs: readonly (ResolvedSeries | undefined)[],
  terms: FormulaTerms,
  unit: SeriesUnit,
  color: string,
): ResolvedSeries[] {
  const first = inputs[terms.legs[0]!.index]!;
  const summedIndexes = [...terms.legs.map((leg) => leg.index), ...terms.factors.map((factor) => factor.index)];
  const summed = summedIndexes.map((index) => inputs[index]!);
  // Rounded off the float's last digits: 42 × 4.6233 - 96.12 is 98.0586, not 98.05860000000001.
  const factorScales = formulaFactorScales(terms, inputs);
  const price = formulaLegPricer(terms, inputs);
  // A formula of futures names each leg's contract on every date it can; one of other series has none to name.
  const futures = terms.leader != null || terms.legs.some((leg) => {
    const input = inputs[leg.index]!;
    return input.points.some((point) => point.contract) || legContract(input, undefined) != null
      || continuousFuturesRoot(input.listing?.symbol ?? "") != null;
  });
  let previous: Array<string | null> | null = null;
  const points = alignedSamples(inputs, summedIndexes).map(({ point, values, points: read }) => {
    const priced = price(point.date, values, read);
    let value: number | null = terms.legs.reduce((sum, leg, position) => sum + priced.legs[position]!.price * leg.weight, 0) / terms.divisor;
    terms.factors.forEach((factor, position) => {
      const scale = values[factor.index]!;
      value = value === null || (factor.power < 0 && scale === 0) ? null
        : (factor.power < 0 ? value / scale : value * scale) * factorScales[position]!;
    });
    const derived = derivedPoint({ point, value: 0 }, value === null ? null : Number(value.toPrecision(12)));
    if (!futures) return derived;
    const contracts = priced.legs.map((leg) => leg.contract);
    // A roll moves a leg from one known contract to another; a leg whose contract comes to be known has not rolled.
    // One priced in its leader's month rolls only as a whole, once every leg's contract is known.
    const whole = (named: ReadonlyArray<string | null>) => terms.leader == null || named.every((contract) => contract != null);
    const roll = previous != null && whole(previous) && whole(contracts)
      && contracts.some((contract, position) => contract != null && previous![position] != null && contract !== previous![position]);
    previous = contracts;
    return { ...derived, legs: priced.legs, ...(roll ? { roll: true } : {}), ...(priced.partial ? { partial: true } : {}) };
  });
  const frequencies = new Set(summed.map((input) => input.nativeFrequency));
  const resolutions = new Set(summed.map((input) => input.historyResolution));
  const scaled = terms.factors.length > 0;
  // A price per quantity reads with its unit beside it, as a future's does.
  const statedUnit = scaled
    ? isPriceGroup(unit.unitGroup) && unit.unit.includes("/") ? unit.unit : null
    : summed.some((input) => input.statedUnit) ? unit.unit : null;
  const valueDecimals = !scaled || isPriceGroup(unit.unitGroup) ? derivedValueDecimals(summed, points) : undefined;
  return [{
    ...outputSeries(spec, first, {
      label: terms.name ?? formulaLabel(inputs, terms),
      points,
      color,
      unit: unit.unit,
      unitGroup: unit.unitGroup,
      statedUnit,
      // A weighted sum is no traded price: its decimals are its legs', not a contract's tick.
      priceAssetCategory: null,
      ...(valueDecimals !== undefined ? { valueDecimals } : {}),
      // As the pair formulas: as-of levels, constant until an input changes.
      style: "step",
      interpolation: "step-after",
      axis: "left",
      nativeFrequency: frequencies.size === 1 ? first.nativeFrequency : "auto",
      historyResolution: resolutions.size === 1 ? first.historyResolution : null,
    }),
    // A catalog formula is named; a report writes the terms it was charted from beside the name.
    ...(terms.name ? { expression: formulaLabel(inputs, terms) } : {}),
    ...(futures ? { formulaLegs: terms.legs.map((leg) => legName(inputs[leg.index]!)) } : {}),
    ...(futures && terms.leader != null ? { formulaLeader: legName(inputs[terms.leader]!) } : {}),
  }];
}
