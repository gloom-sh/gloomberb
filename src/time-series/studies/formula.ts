import { alignTimeSeries } from "../alignment";
import type { ChartStudySpec, ResolvedSeries, TimeSeriesPoint } from "../types";
import { isFiniteNumber } from "../../utils/guards";
import { GALLONS_PER_BARREL, isBarrelsPerTonne, perBarrelUnit, perTonneUnit } from "../price-units";
import { derivedPoint, outputSeries } from "./shared";
import {
  combinedUnit,
  derivedValueDecimals,
  fxConversionIssue,
  isPriceGroup,
  knownUnitSignature,
  legName,
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
}

export interface FormulaTerms {
  /** The inputs the formula adds up. */
  legs: FormulaLeg[];
  /** The inputs the whole sum is multiplied (1) or divided (-1) by: `/EURUSD=X`. */
  factors: Array<{ index: number; power: 1 | -1 }>;
  divisor: number;
}

/**
 * A formula study's terms: `weight1`, `perBarrel1`, `perTonne1` ... per
 * input it adds up, `power1` ... (1 or -1) per input it multiplies or divides
 * the sum by, and an optional `divisor`. A saved or hand-edited spec can carry
 * a multiplier or divisor no formula was written with (a value that is not a
 * number is dropped when the spec loads, so it arrives missing); that is an
 * error, not a silent 1.
 */
export function formulaTerms(spec: ChartStudySpec, inputs: readonly ResolvedSeries[]): FormulaTerms | { error: string } {
  const legs: FormulaLeg[] = [];
  const factors: FormulaTerms["factors"] = [];
  for (const [index, input] of inputs.entries()) {
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
    legs.push({
      index,
      weight,
      perBarrel: spec.parameters[`perBarrel${index + 1}`] === 1,
      perTonne: isFiniteNumber(perTonne) && isBarrelsPerTonne(perTonne) ? perTonne : null,
    });
  }
  if (legs.length === 0) return { error: "The formula has no series to add up, only series it divides by; write the formula again." };
  const divisor = spec.parameters.divisor ?? 1;
  if (!isFiniteNumber(divisor)) return { error: "The formula's divisor is not a number; write the formula again." };
  if (divisor === 0) return { error: "A formula cannot be divided by 0." };
  return { legs, factors, divisor };
}

/**
 * A leg's unit once its multiplier is applied: 42 gallons of a per-gallon
 * price are a barrel's worth, and 7.45 barrels of gasoil a tonne's.
 */
function formulaLegUnit(leg: FormulaLeg, input: ResolvedSeries): string {
  const unit = leg.perBarrel ? perBarrelUnit(input.unit) : input.unit;
  return leg.perTonne ? perTonneUnit(unit) : unit;
}

/** Why a formula's legs cannot be summed, or null when every leg counts the same known unit. */
function formulaUnitMismatch(terms: FormulaTerms, inputs: readonly ResolvedSeries[]): string | null {
  if (terms.legs.length < 2) return null;
  const legs = terms.legs.map((leg) => ({ series: inputs[leg.index]!, unit: formulaLegUnit(leg, inputs[leg.index]!) }));
  const signatures = legs.map(({ series, unit }) => knownUnitSignature({ unit, unitGroup: series.unitGroup }));
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
function formulaLabel(inputs: readonly ResolvedSeries[], terms: FormulaTerms): string {
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

/** Every input's value on each date they share, each carried forward to the others' dates. */
function alignedSamples(inputs: readonly ResolvedSeries[]): Array<{ point: TimeSeriesPoint; values: number[] }> {
  return alignTimeSeries(inputs, { mode: "intersection", carryForward: true }).flatMap((row) => {
    const aligned = inputs.map((input) => row.values[input.id]);
    if (aligned.some((entry) => !isFiniteNumber(entry?.value))) return [];
    const availability = Math.max(...aligned.map((entry) => entry!.point.availableAt?.getTime() ?? entry!.point.date.getTime()));
    return [{
      values: aligned.map((entry) => entry!.value as number),
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
export function formulaUnit(terms: FormulaTerms, inputs: readonly ResolvedSeries[]): SeriesUnit | { error: string } {
  const mismatch = formulaUnitMismatch(terms, inputs);
  if (mismatch) return { error: mismatch };
  const first = inputs[terms.legs[0]!.index]!;
  let unit: SeriesUnit = { unit: formulaLegUnit(terms.legs[0]!, first), unitGroup: first.unitGroup };
  for (const factor of terms.factors) {
    const series = inputs[factor.index]!;
    const next = combinedUnit(unit, series, factor.power);
    const issue = fxConversionIssue(unit, series, factor.power, next);
    if (issue) return { error: issue };
    unit = next;
  }
  return unit;
}

export function resolveFormula(
  spec: ChartStudySpec,
  inputs: readonly ResolvedSeries[],
  terms: FormulaTerms,
  unit: SeriesUnit,
  color: string,
): ResolvedSeries[] {
  const first = inputs[terms.legs[0]!.index]!;
  // Rounded off the float's last digits: 42 × 4.6233 - 96.12 is 98.0586, not 98.05860000000001.
  const points = alignedSamples(inputs).map(({ point, values }) => {
    let value: number | null = terms.legs.reduce((sum, leg) => sum + values[leg.index]! * leg.weight, 0) / terms.divisor;
    for (const factor of terms.factors) {
      const scale = values[factor.index]!;
      value = value === null || (factor.power < 0 && scale === 0) ? null : factor.power < 0 ? value / scale : value * scale;
    }
    return derivedPoint({ point, value: 0 }, value === null ? null : Number(value.toPrecision(12)));
  });
  const frequencies = new Set(inputs.map((input) => input.nativeFrequency));
  const resolutions = new Set(inputs.map((input) => input.historyResolution));
  const scaled = terms.factors.length > 0;
  // A price per quantity reads with its unit beside it, as a future's does.
  const statedUnit = scaled
    ? isPriceGroup(unit.unitGroup) && unit.unit.includes("/") ? unit.unit : null
    : inputs.some((input) => input.statedUnit) ? unit.unit : null;
  const valueDecimals = !scaled || isPriceGroup(unit.unitGroup) ? derivedValueDecimals(inputs, points) : undefined;
  return [outputSeries(spec, first, {
    label: formulaLabel(inputs, terms),
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
  })];
}
