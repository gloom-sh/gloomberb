import { BarSizeSetting } from "@stoqey/ib";
import type { TimeRange } from "gloomberb/time-series";
import {
  normalizeChartResolutionSupport,
  type ChartResolutionSupport,
  type ManualChartResolution,
} from "gloomberb/time-series";
import type { PricePoint } from "gloomberb/types/financials";
import { normalizeIbkrPriceValue } from "./price-normalization";

export interface IbkrHistoricalBar {
  time?: string | number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

export const IBKR_HISTORY_PARAMS: Record<TimeRange, { duration: string; size: BarSizeSetting }> = {
  "1D": { duration: "1 D", size: BarSizeSetting.MINUTES_FIVE },
  "1W": { duration: "7 D", size: BarSizeSetting.HOURS_ONE },
  "1M": { duration: "1 M", size: BarSizeSetting.HOURS_ONE },
  "3M": { duration: "3 M", size: BarSizeSetting.DAYS_ONE },
  "6M": { duration: "6 M", size: BarSizeSetting.DAYS_ONE },
  "1Y": { duration: "1 Y", size: BarSizeSetting.DAYS_ONE },
  "5Y": { duration: "5 Y", size: BarSizeSetting.WEEKS_ONE },
  "ALL": { duration: "10 Y", size: BarSizeSetting.MONTHS_ONE },
};

export const IBKR_RESOLUTION_SUPPORT: ChartResolutionSupport[] = normalizeChartResolutionSupport([
  { resolution: "1m", maxRange: "1W" },
  { resolution: "5m", maxRange: "1M" },
  { resolution: "15m", maxRange: "3M" },
  { resolution: "30m", maxRange: "6M" },
  { resolution: "1h", maxRange: "1Y" },
  { resolution: "1d", maxRange: "ALL" },
  { resolution: "1wk", maxRange: "ALL" },
  { resolution: "1mo", maxRange: "ALL" },
]);

export const IBKR_GENERIC_BAR_SIZE_MAP: Record<string, BarSizeSetting> = {
  "1m": BarSizeSetting.MINUTES_ONE,
  "5m": BarSizeSetting.MINUTES_FIVE,
  "15m": BarSizeSetting.MINUTES_FIFTEEN,
  "30m": BarSizeSetting.MINUTES_THIRTY,
  "1h": BarSizeSetting.HOURS_ONE,
  "1d": BarSizeSetting.DAYS_ONE,
  "1wk": BarSizeSetting.WEEKS_ONE,
  "1mo": BarSizeSetting.MONTHS_ONE,
};

export function getIbkrHistoryCapabilities(): ManualChartResolution[] {
  return IBKR_RESOLUTION_SUPPORT.map((entry) => entry.resolution);
}

export function parseIbkrHistoricalBarTime(value: string | number): Date {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return new Date(Number.NaN);

    const compactDate = String(Math.trunc(value));
    if (/^\d{8}$/.test(compactDate)) {
      return parseIbkrHistoricalBarTime(compactDate);
    }

    return new Date(value > 10_000_000_000 ? value : value * 1000);
  }

  const trimmed = value.trim();
  if (!trimmed) return new Date(Number.NaN);

  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed)) {
    return new Date(parsed);
  }

  const compactMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})(?:\D+(\d{2}):(\d{2}):(\d{2}))?/);
  if (!compactMatch) {
    return new Date(Number.NaN);
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = compactMatch;
  const year = Number(yearText);
  const month = Number(monthText) - 1;
  const day = Number(dayText);
  const hour = Number(hourText ?? "0");
  const minute = Number(minuteText ?? "0");
  const second = Number(secondText ?? "0");

  return new Date(year, month, day, hour, minute, second);
}

export function formatIbkrHistoricalEndDateTime(endDate: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${endDate.getFullYear()}${pad(endDate.getMonth() + 1)}${pad(endDate.getDate())} ${pad(endDate.getHours())}:${pad(endDate.getMinutes())}:${pad(endDate.getSeconds())}`;
}

export function getIbkrHistoryDuration(startDate: Date, endDate: Date): string {
  const spanMs = endDate.getTime() - startDate.getTime();
  const spanDays = Math.ceil(spanMs / (1000 * 60 * 60 * 24));

  if (spanDays <= 1) return `${Math.max(Math.ceil(spanMs / (1000 * 60 * 60)), 1)} hours`;
  if (spanDays <= 30) return `${spanDays} D`;
  if (spanDays <= 365) return `${Math.ceil(spanDays / 30)} M`;
  return `${Math.ceil(spanDays / 365)} Y`;
}

export function ibkrHistoricalBarsToPricePoints(
  bars: readonly IbkrHistoricalBar[],
  priceDivisor: number,
): PricePoint[] {
  return bars.map((bar) => ({
    date: parseIbkrHistoricalBarTime(bar.time ?? ""),
    open: normalizeIbkrPriceValue(bar.open, priceDivisor),
    high: normalizeIbkrPriceValue(bar.high, priceDivisor),
    low: normalizeIbkrPriceValue(bar.low, priceDivisor),
    close: normalizeIbkrPriceValue(bar.close ?? bar.open ?? bar.high ?? bar.low ?? 0, priceDivisor) ?? 0,
    volume: bar.volume,
  }));
}
