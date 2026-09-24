import { formatMarketPriceWithCurrency, stablePriceFractionDigits, type MarketFormatOptions } from "../../../market-data/market/format";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import type { CompositeAxisDomain, CompositePanelScene } from "./types";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
};

const CURRENCY_CODES = new Set(Intl.supportedValuesOf("currency"));

const HOUR_MS = 60 * 60 * 1_000;
const INTRADAY_SPAN_MAX_MS = 36 * HOUR_MS;

function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(absolute >= 10_000_000_000_000 ? 0 : 1)}T`;
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(absolute >= 10_000_000_000 ? 0 : 1)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(absolute >= 10_000_000 ? 0 : 1)}M`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(absolute >= 10_000 ? 0 : 1)}K`;
  if (absolute >= 100) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1);
  if (absolute >= 1) return value.toFixed(2);
  if (absolute === 0) return "0";
  return value.toPrecision(3);
}

function unitCurrencyCode(unit: string): string | null {
  const currency = unit.trim().toUpperCase().split(/[\s/]/)[0] ?? "";
  return CURRENCY_CODES.has(currency) ? currency : null;
}

function currencyPrefix(unit: string): string {
  const currency = unitCurrencyCode(unit);
  return currency ? CURRENCY_SYMBOLS[currency] ?? "" : "";
}

function formatFullCurrencyValue(
  value: number,
  unit: string,
  assetCategory?: string,
  options: MarketFormatOptions = {},
): string | null {
  const currency = unitCurrencyCode(unit);
  return currency ? formatMarketPriceWithCurrency(value, currency, { ...options, assetCategory }) : null;
}

function pointPriceValue(point: TimeSeriesPoint | undefined): number | undefined {
  const value = point && Number.isFinite(point.value) ? point.value : point?.close;
  return typeof value === "number" && Number.isFinite(value) && value !== 0 ? value : undefined;
}

/**
 * The value a live price label takes its decimals from: the last completed
 * bar, which holds still while the live one moves and sits near today's price
 * even on a ten-year chart. Only market prices have one; fundamentals such as
 * EPS keep formatting each value on its own.
 */
export function seriesPriceReference(series: ResolvedSeries): number | undefined {
  if (series.observationKind !== "market" && series.dataShape !== "ohlcv" && series.priceAssetCategory === undefined) {
    return undefined;
  }
  for (let index = series.points.length - 2; index >= 0; index -= 1) {
    const value = pointPriceValue(series.points[index]);
    if (value !== undefined) return value;
  }
  return pointPriceValue(series.points.at(-1));
}

/** A price label that moves with live data (the last price, the cursor, a
 * legend value) keeps one decimal count for its asset, read from a reference
 * price rather than the value itself: $150.10 does not become $150.1. */
function stablePriceOptions(unit: string, assetCategory: string | undefined, referencePrice: number | undefined): MarketFormatOptions {
  if (referencePrice === undefined) return {};
  return {
    referencePrice,
    fixedFractionDigits: stablePriceFractionDigits({
      assetCategory,
      currency: unitCurrencyCode(unit) ?? undefined,
      referencePrice,
      sessionPrices: [referencePrice],
    }),
  };
}

/** An axis can serve several price series. Keep the most precise value the
 * shared formatter produces, rather than inheriting the first asset's rounding. */
function formatAxisPriceValue(
  value: number,
  domain: CompositeAxisDomain,
  options: MarketFormatOptions | ((category: string | undefined) => MarketFormatOptions) = {},
): string {
  const categories = domain.priceAssetCategories?.length ? domain.priceAssetCategories : [undefined];
  return categories.reduce<string>((best, category) => {
    const categoryOptions = typeof options === "function" ? options(category) : options;
    const formatted = formatFullCurrencyValue(value, domain.unit, category, categoryOptions) ?? "";
    return formatted.length > best.length ? formatted : best;
  }, "");
}

const AXIS_TICK_COUNT = 3;
const DEFAULT_AXIS_MAX_TICKS = 5;
// How far a row-snapped label may sit from its value, as a share of the axis
// range: about half a row on a 12-row panel, near exact on a 3-row one.
const ROW_SNAP_TOLERANCE = 0.04;

function axisTickValue(domain: CompositeAxisDomain, ratio: number): number {
  return domain.scale === "log"
    ? Math.exp(Math.log(domain.max) + (Math.log(domain.min) - Math.log(domain.max)) * ratio)
    : domain.max + (domain.min - domain.max) * ratio;
}

/** How many labeled ticks a panel of this many rows can hold, two rows apart.
 * A short study panel gets fewer than the usual three rather than labels that
 * land on each other. */
export function compositeAxisMaxTicks(rows: number): number {
  return Math.max(2, Math.min(DEFAULT_AXIS_MAX_TICKS, 1 + Math.floor((rows - 1) / 2)));
}

/** The next 1, 2 or 5 times power-of-ten step above (or below) a nice step. */
function adjacentNiceStep(step: number, direction: 1 | -1): number {
  const power = 10 ** Math.floor(Math.log10(step) + 1e-9);
  const mantissa = Math.round(step / power);
  const next = direction > 0
    ? (mantissa === 1 ? 2 : mantissa === 2 ? 5 : 10) * power
    : (mantissa === 5 ? 2 : mantissa === 2 ? 1 : 0.5) * power;
  return Number(next.toPrecision(12));
}

/** The smallest 1, 2 or 5 times power-of-ten step at least as large as `raw`. */
function niceCeilStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  const error = raw / power;
  const factor = error <= 1 + 1e-9 ? 1 : error <= 2 ? 2 : error <= 5 ? 5 : 10;
  return Number((factor * power).toPrecision(12));
}

function stepMultiples(min: number, max: number, step: number): number[] {
  const tolerance = step * 1e-9;
  const first = Math.ceil((min - tolerance) / step);
  const last = Math.floor((max + tolerance) / step);
  const values: number[] = [];
  // Multiplying integer counts keeps float drift out of the labels.
  for (let index = last; index >= first && values.length <= 50; index -= 1) {
    values.push(Number((index * step).toPrecision(12)));
  }
  return values;
}

/** The top, middle and bottom of the axis. Row-snapped labels take the values
 * of the rows they sit on, so each reads exactly at its own row. */
function edgeTickValues(domain: CompositeAxisDomain): number[] {
  const rows = domain.tickRows;
  if (rows !== undefined && rows >= 1) {
    const lastRow = Math.max(rows - 1, 0);
    return [...new Set([0, Math.round(lastRow / 2), lastRow])]
      .map((row) => axisTickValue(domain, lastRow > 0 ? row / lastRow : 0));
  }
  // Labels placed at exact heights have no rows to keep them apart: a panel
  // too short for a middle label shows only its top and bottom.
  const count = Math.max(2, Math.min(AXIS_TICK_COUNT, domain.maxTicks ?? AXIS_TICK_COUNT));
  return Array.from(
    { length: count },
    (_, index) => axisTickValue(domain, index / (count - 1)),
  );
}

/** Terminal labels and gridlines snap to whole rows. A round tick only works
 * there if it gets a row of its own and that row's value stays close to it. */
function ticksFitRows(domain: CompositeAxisDomain, values: number[]): boolean {
  const rows = domain.tickRows;
  if (rows === undefined) return true;
  const lastRow = rows - 1;
  if (lastRow < 1) return false;
  const used = new Set<number>();
  for (const value of values) {
    const position = axisTickRatio(domain, value) * lastRow;
    const row = Math.round(position);
    if (used.has(row) || Math.abs(position - row) / lastRow > ROW_SNAP_TOLERANCE) return false;
    used.add(row);
  }
  return true;
}

/** Round values inside a linear domain, so every gridline carries a readable
 * value. A log axis, or a short terminal panel no round step fits, keeps its
 * top, middle and bottom values. */
function axisTickValues(domain: CompositeAxisDomain): number[] {
  const span = domain.max - domain.min;
  if (domain.scale === "log" || !Number.isFinite(span) || span <= 0) return edgeTickValues(domain);
  const maxTicks = Math.max(2, domain.maxTicks ?? DEFAULT_AXIS_MAX_TICKS);
  // Walk the 1-2-5 ladder around the target spacing and keep the step whose
  // tick count lands nearest the target, one extra tick allowed.
  let step = adjacentNiceStep(adjacentNiceStep(niceCeilStep(span / (maxTicks - 1)), -1), -1);
  let best: number[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const values = stepMultiples(domain.min, domain.max, step);
    if (values.length >= 2 && values.length <= maxTicks + 1
      && (best.length === 0 || Math.abs(values.length - maxTicks) < Math.abs(best.length - maxTicks))
      && ticksFitRows(domain, values)) {
      best = values;
    }
    step = adjacentNiceStep(step, 1);
  }
  // Round labels win only where they are at least as many as the exact ones.
  const edges = edgeTickValues(domain);
  return best.length >= Math.max(2, edges.length) ? best : edges;
}

/** The narrowest distance between neighbouring ticks. A log axis bunches its
 * lowest ticks together, so the tightest pair is what every label has to stay
 * legible against. */
function narrowestAxisTickGap(domain: CompositeAxisDomain): number | null {
  const values = axisTickValues(domain);
  const gap = Math.min(...values.slice(1).map((value, index) => Math.abs(value - values[index]!)));
  return Number.isFinite(gap) && gap > 0 ? gap : null;
}

/** What compactNumber's final digit is worth. Ticks nearer to each other than
 * this render as the same label. */
function compactResolution(value: number): number {
  const absolute = Math.abs(value);
  for (const divisor of [1e12, 1e9, 1e6, 1e3]) {
    if (absolute >= divisor) return absolute >= divisor * 10 ? divisor : divisor / 10;
  }
  if (absolute >= 100) return 1;
  if (absolute >= 10) return 0.1;
  if (absolute >= 1) return 0.01;
  // Sub-unit values keep three significant digits.
  return absolute > 0 ? 10 ** (Math.floor(Math.log10(absolute)) - 2) : 0;
}

/** `referencePrice` defaults to the series' own; a study on a price axis
 * passes the axis's reference so it shares the price's decimals. */
export function formatCompositeSeriesValue(
  value: number,
  series: ResolvedSeries,
  referencePrice = seriesPriceReference(series),
): string {
  return formatChartLegendValue(value, series.unit, series.unitGroup, series.priceAssetCategory, referencePrice);
}

export function formatChartLegendValue(
  value: number,
  unit: string,
  unitGroup = "",
  assetCategory?: string,
  /** Set for a live series: its price keeps the decimals this reference calls for. */
  referencePrice?: number,
): string {
  const trimmed = unit.trim();
  const group = unitGroup.toLowerCase();
  const compact = compactNumber(value);
  if (group.includes("percent") || trimmed === "%" || trimmed.toLowerCase().includes("percent")) {
    return `${compact}%`;
  }
  if (group.includes("ratio") || trimmed.toLowerCase() === "x") return `${compact}x`;
  if (group.startsWith("derived-unit:")) return `${compact} ${trimmed}`;
  if (group.split(":")[0] === "currency-total") {
    const scale = ([[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]] as const)
      .find(([divisor]) => Math.abs(value) >= divisor);
    if (scale) {
      const prefix = currencyPrefix(trimmed);
      const amount = `${Number(((prefix ? Math.abs(value) : value) / scale[0]).toFixed(2))}${scale[1]}`;
      return prefix ? `${value < 0 ? "-" : ""}${prefix}${amount}` : `${amount} ${trimmed}`.trim();
    }
  }
  const fullPrice = formatFullCurrencyValue(
    value,
    trimmed,
    assetCategory,
    referencePrice === undefined ? {} : stablePriceOptions(trimmed, assetCategory, referencePrice),
  );
  if (fullPrice) return fullPrice;
  return trimmed && trimmed.length <= 6 ? `${compact}${trimmed.startsWith("/") ? "" : " "}${trimmed}` : compact;
}

const COMPACT_LABEL = /^(-?\d+)(?:\.(\d+))?([KMBT]?)$/;

function trimmedDecimals(label: string): number {
  const match = COMPACT_LABEL.exec(label);
  return match ? (match[2] ?? "").replace(/0+$/, "").length : Number.POSITIVE_INFINITY;
}

/** Round ticks drop the trailing zeros compact formatting pads them with, down
 * to the digits the finest tick needs, so the column reads $0 / $50 / $100. */
function compactAxisNumber(value: number, domain: CompositeAxisDomain): string {
  const compact = compactNumber(value);
  if (domain.scale === "log") return compact;
  const ticks = axisTickValues(domain);
  if (!ticks.some((tick) => Math.abs(tick - value) <= Math.abs(tick) * 1e-9)) return compact;
  const decimals = Math.max(...ticks.map((tick) => trimmedDecimals(compactNumber(tick))));
  const match = COMPACT_LABEL.exec(compact);
  if (!match || !Number.isFinite(decimals)) return compact;
  const fraction = (match[2] ?? "").slice(0, decimals);
  return `${match[1]}${fraction ? `.${fraction}` : ""}${match[3]}`;
}

export function formatCompositeAxisValue(value: number, domain: CompositeAxisDomain): string {
  const compact = compactAxisNumber(value, domain);
  const group = domain.unitGroup.toLowerCase();
  if (group.includes("percent") || domain.unit === "%") return `${compact}%`;
  if (group.includes("ratio") || domain.unit.toLowerCase() === "x") return `${compact}x`;
  // Derived dimensions are included in the legend value. Axis labels stay
  // numeric so a narrow gutter cannot truncate USD/JPY into a false USD label.
  if (group.startsWith("derived-unit:")) return compact;
  // Compact labels suit a wide view, but a zoomed one can hold several ticks
  // inside a single rounding step and print one repeated price down the gutter.
  // Where that happens the axis spends the digits needed to tell them apart,
  // shared across every tick so the column reads as one scale.
  const gap = narrowestAxisTickGap(domain);
  if (gap !== null && gap < compactResolution(value)) {
    const resolved = formatAxisPriceValue(value, domain, {
      fixedFractionDigits: Math.max(0, Math.ceil(-Math.log10(gap))),
    });
    if (resolved) return resolved;
  }
  const prefix = currencyPrefix(domain.unit);
  return prefix && compact.startsWith("-") ? `-${prefix}${compact.slice(1)}` : `${prefix}${compact}`;
}

export function formatCompositeCursorValue(value: number, domain: CompositeAxisDomain): string {
  const group = domain.unitGroup.toLowerCase();
  if (group.startsWith("derived-unit:")) return compactNumber(value);
  if (group.split(":")[0] === "currency-total") {
    return formatChartLegendValue(value, domain.unit, domain.unitGroup);
  }
  const fullPrice = formatAxisPriceValue(value, domain, (category) => (
    stablePriceOptions(domain.unit, category, domain.priceReferences?.[category ?? ""])
  ));
  if (fullPrice) return fullPrice;
  return formatCompositeAxisValue(value, domain);
}

export type CompositeAxisValueFormatter = (value: number, domain: CompositeAxisDomain) => string;

export function compositeAxisTicks(
  domain: CompositeAxisDomain,
  format: CompositeAxisValueFormatter = formatCompositeAxisValue,
): Array<{ ratio: number; value: number; label: string }> {
  return axisTickValues(domain).map((value) => ({
    ratio: axisTickRatio(domain, value),
    value,
    label: format(value, domain),
  }));
}

/** Gridlines follow the ticks of the panel's labeled axis, left first. The
 * plot edges are not redrawn. */
export function compositeGridRatios(panel: Pick<CompositePanelScene, "axes">): number[] {
  const domain = panel.axes.left ?? panel.axes.right;
  if (!domain) return [0.25, 0.5, 0.75];
  return axisTickValues(domain)
    .map((value) => axisTickRatio(domain, value))
    .filter((ratio) => ratio > 0.01 && ratio < 0.99);
}

function axisTickRatio(domain: CompositeAxisDomain, value: number): number {
  if (domain.scale === "log") {
    const span = Math.log(domain.max) - Math.log(domain.min);
    return span > 0 ? (Math.log(domain.max) - Math.log(value)) / span : 0.5;
  }
  const span = domain.max - domain.min;
  return span > 0 ? (domain.max - value) / span : 0.5;
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcTime(date: Date): string {
  return date.toISOString().slice(11, 16);
}

function isIntradaySpan(startTime: number, endTime: number): boolean {
  return Number.isFinite(startTime)
    && Number.isFinite(endTime)
    && Math.abs(endTime - startTime) <= INTRADAY_SPAN_MAX_MS;
}

/** Shared-cursor timestamp using the chart's explicit UTC convention. */
export function formatCompositeCursorDate(date: Date, startTime: number, endTime: number): string {
  return isIntradaySpan(startTime, endTime)
    ? `${utcDate(date)} ${utcTime(date)} UTC`
    : utcDate(date);
}

function validUtcTimestamp(date: Date | undefined): string | null {
  if (!date || !Number.isFinite(date.getTime())) return null;
  return date.getUTCHours() === 0
      && date.getUTCMinutes() === 0
      && date.getUTCSeconds() === 0
      && date.getUTCMilliseconds() === 0
    ? utcDate(date)
    : `${utcDate(date)} ${utcTime(date)} UTC`;
}

/**
 * Concise, audit-friendly context for an observation. Kept separate from the
 * visible legend so fiscal-period and availability metadata is available on
 * demand without reducing chart density.
 */
export function formatCompositePointDetails(point: TimeSeriesPoint | null | undefined): string {
  if (!point) return "";
  const details: string[] = [];
  const periodLabel = point.periodLabel?.trim();
  const observedAt = validUtcTimestamp(point.observedAt);
  const availableAt = validUtcTimestamp(point.availableAt);

  if (periodLabel) details.push(periodLabel);
  const labelIncludesObservedDate = ["Quarter", "Year", "TTM"].some((period) => periodLabel === `${period} ended ${observedAt}`);
  if (observedAt && !labelIncludesObservedDate) {
    const isFiscalPeriod = periodLabel && periodLabel.toLowerCase() !== "current";
    details.push(`${isFiscalPeriod ? "Period ended" : "Observed"} ${observedAt}`);
  }
  if (availableAt && availableAt !== observedAt) details.push(`Available ${availableAt}`);

  const quality = point.provenance?.quality;
  if (quality) details.push(`${quality[0]!.toUpperCase()}${quality.slice(1)}`);
  const providerId = point.provenance?.providerId?.trim();
  if (providerId) details.push(`Source ${providerId}`);

  return details.join(" · ");
}

/** Compact UTC tick label selected from the full visible chart span. */
export function formatCompositeTimeAxisDate(date: Date, startTime: number, endTime: number): string {
  if (!isIntradaySpan(startTime, endTime)) return utcDate(date);
  const startDate = utcDate(new Date(startTime));
  const endDate = utcDate(new Date(endTime));
  return startDate === endDate
    ? `${utcTime(date)} UTC`
    : `${utcDate(date).slice(5)} ${utcTime(date)} UTC`;
}
