import { formatMarketPriceWithCurrency } from "../../../market-data/market/format";
import type { ResolvedSeries, TimeSeriesPoint } from "../../../time-series/types";
import type { CompositeAxisDomain } from "./types";

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: "$",
  EUR: "€",
  GBP: "£",
  JPY: "¥",
  CNY: "¥",
};

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
  return CURRENCY_SYMBOLS[currency] ? currency : null;
}

function currencyPrefix(unit: string): string {
  const currency = unitCurrencyCode(unit);
  return currency ? CURRENCY_SYMBOLS[currency] ?? "" : "";
}

function formatFullCurrencyValue(value: number, unit: string): string | null {
  const currency = unitCurrencyCode(unit);
  return currency ? formatMarketPriceWithCurrency(value, currency) : null;
}

export function formatCompositeSeriesValue(value: number, series: ResolvedSeries): string {
  return formatChartLegendValue(value, series.unit, series.unitGroup);
}

export function formatChartLegendValue(value: number, unit: string, unitGroup = ""): string {
  const trimmed = unit.trim();
  const group = unitGroup.toLowerCase();
  const compact = compactNumber(value);
  if (group.includes("percent") || trimmed === "%" || trimmed.toLowerCase().includes("percent")) {
    return `${compact}%`;
  }
  if (group.includes("ratio") || trimmed.toLowerCase() === "x") return `${compact}x`;
  if (group.startsWith("derived-unit:")) return `${compact} ${trimmed}`;
  const fullPrice = formatFullCurrencyValue(value, trimmed);
  if (fullPrice) return fullPrice;
  return trimmed && trimmed.length <= 6 ? `${compact}${trimmed.startsWith("/") ? "" : " "}${trimmed}` : compact;
}

export function formatCompositeAxisValue(value: number, domain: CompositeAxisDomain): string {
  const compact = compactNumber(value);
  const group = domain.unitGroup.toLowerCase();
  if (group.includes("percent") || domain.unit === "%") return `${compact}%`;
  if (group.includes("ratio") || domain.unit.toLowerCase() === "x") return `${compact}x`;
  // Derived dimensions are included in the legend value. Axis labels stay
  // numeric so a narrow gutter cannot truncate USD/JPY into a false USD label.
  if (group.startsWith("derived-unit:")) return compact;
  return `${currencyPrefix(domain.unit)}${compact}`;
}

export function formatCompositeCursorValue(value: number, domain: CompositeAxisDomain): string {
  const group = domain.unitGroup.toLowerCase();
  if (group.startsWith("derived-unit:")) return compactNumber(value);
  const fullPrice = formatFullCurrencyValue(value, domain.unit);
  if (fullPrice) return fullPrice;
  return formatCompositeAxisValue(value, domain);
}

export type CompositeAxisValueFormatter = (value: number, domain: CompositeAxisDomain) => string;

export function compositeAxisTicks(
  domain: CompositeAxisDomain,
  count = 3,
  format: CompositeAxisValueFormatter = formatCompositeAxisValue,
): Array<{ ratio: number; value: number; label: string }> {
  const tickCount = Math.max(2, Math.floor(count));
  return Array.from({ length: tickCount }, (_, index) => {
    const ratio = index / (tickCount - 1);
    const value = domain.scale === "log"
      ? Math.exp(Math.log(domain.max) + (Math.log(domain.min) - Math.log(domain.max)) * ratio)
      : domain.max + (domain.min - domain.max) * ratio;
    return { ratio, value, label: format(value, domain) };
  });
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
  if (observedAt) {
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
