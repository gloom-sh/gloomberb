import { scalarPointValue } from "../alignment";
import { resolveCurrencyUnit, US_CENTS } from "../../utils/currency-units";
import { isCurrencyCode } from "../../utils/currency-pair";
import { stablePriceFractionDigits } from "../../market-data/market/format";
import type { ResolvedSeries, TimeSeriesPoint } from "../types";
import {
  GALLONS_PER_BARREL,
  isPerBarrelUnit,
  isPerGallonUnit,
  quantityIdentity,
  unitCurrencyToken,
} from "../price-units";

export function seriesCurrency(series: ResolvedSeries): string | null {
  const grouped = series.unitGroup.match(/:([A-Z]{3})$/i)?.[1];
  if (grouped) return grouped.toUpperCase();
  if (!/^(?:price|currency-total|per-share)$/.test(series.unitGroup)) return null;
  return series.unit.match(/^([A-Z]{3})(?:$|\/)/i)?.[1]?.toUpperCase() ?? null;
}

function unitFactorIdentity(value: string): string {
  // "US cents", as futures terms word a grain's quote, is the USX the quote names.
  const token = unitCurrencyToken(value) ?? value.trim();
  // Three letters are a currency unless they spell a quantity: "bbl" is a barrel.
  if (/^[A-Za-z]{3}$/.test(token) && quantityIdentity(token) === token.toLowerCase()) {
    const { currency, divisor } = resolveCurrencyUnit(token);
    return `${currency}:${divisor}`;
  }
  return quantityIdentity(token);
}

/** Whether a unit's factor is money (USD, GBp, US cents) rather than a quantity it buys. */
function isCurrencyFactor(value: string): boolean {
  const currency = /^([A-Z]{3}):\d+$/.exec(unitFactorIdentity(value))?.[1];
  return !!currency && (currency === US_CENTS || isCurrencyCode(currency));
}

export function knownUnitSignature(series: Pick<ResolvedSeries, "unit" | "unitGroup">): string | null {
  const unit = series.unit.trim();
  if (!unit || /(?:^|\W)(?:currency|unknown|unspecified|n\/a)(?:$|\W)/i.test(unit)
    || /^(?:units?|[-?]+)$/i.test(unit)) return null;
  const parts = unit.split("/");
  if (parts.some((part) => !part.trim() || /^[-?]+$/.test(part.trim()))) return null;

  const monetary = series.unitGroup.match(/^(price|currency-total|per-share)(?::([^:]+))?$/);
  // A futures contract writes its unit spaced ("USD / gallon"); a catalog series does not ("USD/gallon").
  const currency = unitCurrencyToken(parts[0]!);
  if (monetary && (!currency || (monetary[2] && unitFactorIdentity(monetary[2]) !== unitFactorIdentity(currency)))) return null;

  // Currency alone does not establish a price's physical/share basis. A scalar
  // multiplier cannot establish it either. Explicit USD/share price and EPS
  // units, however, match despite different groups.
  if (monetary?.[1] === "price" && !unit.includes("/")) return null;
  const basis = monetary && !unit.includes("/") ? monetary[1] : "";
  // Keep currency scale and compound order: GBp/GBX are pence, not pounds;
  // USD/EUR cannot subtract EUR/USD.
  return `${basis ?? ""}|${parts.map(unitFactorIdentity).join("/")}`;
}

/** A leg as an error names it: its ticker (HO=F), else its label. */
export function legName(series: ResolvedSeries): string {
  return series.listing?.symbol || series.label;
}

/** What a leg's unit is, in words: "is USD / gallon", "is in %", "is in USD per an unknown quantity". */
function unitPhrase(series: ResolvedSeries, unit: string): string {
  const text = unit.trim();
  // A rate reads as itself (HO=F is USD / gallon); an amount or a scale is what a leg is in (REVENUE is in USD).
  if (knownUnitSignature({ unit: text, unitGroup: series.unitGroup }) !== null) return text.includes("/") ? `is ${text}` : `is in ${text}`;
  if (unitCurrencyToken(text) && /^price(?::|$)/.test(series.unitGroup)) return `is in ${text} per an unknown quantity`;
  return "has no known unit";
}

function unitCurrency(series: ResolvedSeries, unit: string): string | null {
  const token = unitCurrencyToken(unit.split("/")[0] ?? "");
  return token ? unitFactorIdentity(token) : seriesCurrency(series);
}

/**
 * Why two legs cannot be added or subtracted, naming each one's unit and the
 * fix: a per-gallon leg beside a per-barrel one is 42 gallons short of it.
 */
export function unitMismatchMessage(
  kind: "spread" | "formula",
  left: { series: ResolvedSeries; unit: string },
  right: { series: ResolvedSeries; unit: string },
): string {
  // Two fields of one listing are told apart by their labels.
  const [leftName, rightName] = legName(left.series) === legName(right.series)
    ? [left.series.label, right.series.label]
    : [legName(left.series), legName(right.series)];
  const named = `${leftName} ${unitPhrase(left.series, left.unit)} and ${rightName} ${unitPhrase(right.series, right.unit)}`;
  const leftCurrency = unitCurrency(left.series, left.unit);
  const rightCurrency = unitCurrency(right.series, right.unit);
  const gallons = isPerGallonUnit(left.unit) && isPerBarrelUnit(right.unit) ? leftName
    : isPerBarrelUnit(left.unit) && isPerGallonUnit(right.unit) ? rightName : null;
  if (gallons && leftCurrency === rightCurrency) {
    return `${named}: write ${GALLONS_PER_BARREL}*${gallons} to compare per barrel.`;
  }
  const subject = kind === "spread" ? "a spread" : "a formula";
  if (leftCurrency && rightCurrency && leftCurrency !== rightCurrency) return `${named}: ${subject} does not convert currencies.`;
  const known = knownUnitSignature({ unit: left.unit, unitGroup: left.series.unitGroup }) !== null
    && knownUnitSignature({ unit: right.unit, unitGroup: right.series.unitGroup }) !== null;
  return `${named}: ${subject} needs ${kind === "spread" ? "both" : "every leg"} in one${known ? "" : " known"} unit.`;
}

function unitFactors(unit: string): { numerator: string[]; denominator: string[] } {
  const [numerator = "", ...denominator] = unit.split("/");
  const factor = (value: string) => value.split("·").flatMap((part) => {
    const normalized = part.trim();
    if (!normalized || normalized === "1") return [];
    return [normalized.toLowerCase() === "shares" ? "share" : normalized];
  });
  return {
    numerator: factor(numerator),
    denominator: denominator.flatMap(factor),
  };
}

export interface SeriesUnit {
  unit: string;
  unitGroup: string;
}

const UNKNOWN_UNIT: SeriesUnit = { unit: "unknown", unitGroup: "derived-unit:unknown" };

export function isPriceGroup(unitGroup: string): boolean {
  return /^price(?::|$)/.test(unitGroup);
}

/**
 * The unit of `left` times (`power` 1) or over (-1) `right`, the factors they
 * share cancelling: USD / barrel over an FX rate's USD / EUR is EUR / barrel.
 * Units are spaced as either side writes them ("USD / gallon"). A price over
 * or times a price that leaves one currency per one quantity is a price in
 * that currency; anything else is a derived unit, or a plain ratio.
 */
export function combinedUnit(left: SeriesUnit, right: SeriesUnit, power: 1 | -1): SeriesUnit {
  if (!knownUnitSignature(left) || !knownUnitSignature(right)) return UNKNOWN_UNIT;
  const leftFactors = unitFactors(left.unit);
  const rightFactors = unitFactors(right.unit);
  const numerator = [...leftFactors.numerator, ...(power < 0 ? rightFactors.denominator : rightFactors.numerator)];
  const denominator = [...leftFactors.denominator, ...(power < 0 ? rightFactors.numerator : rightFactors.denominator)];
  for (let index = numerator.length - 1; index >= 0; index -= 1) {
    const match = denominator.findIndex((factor) => (
      unitFactorIdentity(factor) === unitFactorIdentity(numerator[index]!)
    ));
    if (match < 0) continue;
    numerator.splice(index, 1);
    denominator.splice(match, 1);
  }
  const slash = [left.unit, right.unit].some((unit) => /\s\/\s/.test(unit)) ? " / " : "/";
  const unit = denominator.length === 0
    ? numerator.join("·") || "x"
    : `${numerator.join("·") || "1"}${slash}${denominator.join("·")}`;
  if (isPriceGroup(left.unitGroup) && isPriceGroup(right.unitGroup) && numerator.length === 1 && isCurrencyFactor(numerator[0]!)
    && (denominator.length === 0 || (denominator.length === 1 && !isCurrencyFactor(denominator[0]!)))) {
    return { unit, unitGroup: `price:${unitCurrencyToken(numerator[0]!) ?? numerator[0]!}` };
  }
  const groupFactor = (value: string) => {
    const identity = unitFactorIdentity(value);
    return (/^[A-Za-z]{3}$/.test(value.trim()) ? identity.replace(/:1$/, "") : identity).toLowerCase();
  };
  const groupNumerator = numerator.map(groupFactor).join("·");
  const groupDenominator = denominator.map(groupFactor).join("·");
  const group = groupDenominator ? `${groupNumerator || "1"}/${groupDenominator}` : groupNumerator;
  return {
    unit,
    unitGroup: unit === "x" ? "ratio" : `derived-unit:${group}`,
  };
}

export function ratioUnit(left: SeriesUnit, right: SeriesUnit): SeriesUnit {
  return combinedUnit(left, right, -1);
}

/** An FX rate's unit: one currency per another, as USD / EUR. */
function isRateUnit(unit: string): boolean {
  const { numerator, denominator } = unitFactors(unit);
  return numerator.length === 1 && denominator.length === 1 && isCurrencyFactor(numerator[0]!) && isCurrencyFactor(denominator[0]!);
}

/**
 * Why a price times (`power` 1) or over (-1) an FX rate is no price, with how
 * to convert it instead: a crack in USD / barrel over USDJPY=X (JPY / USD) is
 * USD·USD / barrel·JPY, and times it JPY / barrel. A ratio, which cannot
 * multiply, names the formula to write (`priceName` its numerator). Null when
 * the rate converts the price, or either is not what this asks about.
 */
export function fxConversionIssue(price: SeriesUnit, rate: ResolvedSeries, power: 1 | -1, result: SeriesUnit, priceName?: string): string | null {
  if (!isPriceGroup(price.unitGroup) || !isPriceGroup(rate.unitGroup) || !isRateUnit(rate.unit) || isPriceGroup(result.unitGroup)) {
    return null;
  }
  const name = legName(rate);
  const done = `${power < 0 ? "Dividing" : "Multiplying"} by ${name} (${rate.unit}) leaves ${result.unit}`;
  const other = combinedUnit(price, rate, power < 0 ? 1 : -1);
  if (isPriceGroup(other.unitGroup)) {
    const fix = priceName ? `write (${priceName})${power < 0 ? "*" : "/"}${name}` : `${power < 0 ? "multiply" : "divide"} by ${name}`;
    return `${done}; ${fix} instead to get ${other.unit}.`;
  }
  const currency = price.unitGroup.slice("price:".length) || "its currency";
  return `${done}; ${price.unit} converts only with a rate that has ${currency} on one side.`;
}

/** The distinct currencies a unit still counts, once its factors cancel. */
export function unitCurrencies(unit: string): Set<string> {
  const { numerator, denominator } = unitFactors(unit);
  return new Set([...numerator, ...denominator].filter(isCurrencyFactor).map((factor) => unitFactorIdentity(factor).split(":")[0]!));
}

/**
 * The decimals a value worked out from prices prints at: the most its legs
 * print, from two to four, and no more than a value of its own size needs:
 * four under 10, two from 10. A crack of 4.9842 USD / gallon heating oil and
 * 116.72 USD / barrel Brent reads 92.62; a gasoline-heating oil spread reads
 * 1.7726. Undefined when a leg is not a price or the value has none yet.
 */
export function derivedValueDecimals(inputs: readonly ResolvedSeries[], points: readonly TimeSeriesPoint[]): number | undefined {
  let digits = 0;
  for (const input of inputs) {
    if (!isPriceGroup(input.unitGroup) || input.transform !== "raw") return undefined;
    const reference = latestScalarValue(input.points);
    if (reference === undefined) return undefined;
    digits = Math.max(digits, stablePriceFractionDigits({
      assetCategory: input.priceAssetCategory,
      currency: unitCurrencyToken(input.unit.split("/")[0] ?? "") ?? undefined,
      referencePrice: reference,
      sessionPrices: [reference],
    }));
  }
  const size = latestScalarValue(points);
  if (size === undefined) return undefined;
  return Math.min(size < 10 ? 4 : 2, Math.max(2, digits));
}

/** The size of a series' last nonzero value, which its decimals are read from. */
function latestScalarValue(points: readonly TimeSeriesPoint[]): number | undefined {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = scalarPointValue(points[index]!);
    if (value !== null && Number.isFinite(value) && value !== 0) return Math.abs(value);
  }
  return undefined;
}
