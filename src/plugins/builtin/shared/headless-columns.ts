import type { HeadlessPaneColumn } from "../../../types/headless";
import { MISSING_VALUE, formatCompact, formatNumber, formatPercentRaw } from "../../../utils/format";

export type CellFormat = NonNullable<HeadlessPaneColumn["format"]>;
type UnaryCellFormat = (value: unknown) => string;

export const numCell = (format: (value: number) => string, fallback = MISSING_VALUE): UnaryCellFormat =>
  (value) => (typeof value === "number" && Number.isFinite(value) ? format(value) : fallback);

export const fixedCell = (digits: number, options?: { signed?: boolean; suffix?: string; fallback?: string }): UnaryCellFormat =>
  numCell((value) => `${options?.signed && value > 0 ? "+" : ""}${value.toFixed(digits)}${options?.suffix ?? ""}`, options?.fallback);

export const compactCell = (options?: { fixedDecimals?: boolean; prefix?: string; fallback?: string }): UnaryCellFormat =>
  numCell((value) => `${options?.prefix ?? ""}${formatCompact(value, options?.fixedDecimals ? { fixedDecimals: true } : undefined)}`, options?.fallback);

export const pctRawCell = (fallback = MISSING_VALUE): UnaryCellFormat =>
  numCell((value) => formatPercentRaw(value), fallback);

export const numberCell = (digits: number, options?: { suffix?: string; fallback?: string }): UnaryCellFormat =>
  numCell((value) => `${formatNumber(value, digits)}${options?.suffix ?? ""}`, options?.fallback);

export const dayCell = (fallback = MISSING_VALUE): UnaryCellFormat =>
  (value) => (typeof value === "string" ? value.slice(0, 10) : fallback);

export const textCell = (fallback = MISSING_VALUE): UnaryCellFormat =>
  (value) => (typeof value === "string" && value ? value : fallback);

export function numCol(
  key: string,
  header: string,
  format?: CellFormat,
  extra?: Omit<HeadlessPaneColumn, "key" | "header" | "align" | "format">,
): HeadlessPaneColumn {
  return { key, header, align: "right", ...(format ? { format } : {}), ...extra };
}

export function textCol(
  key: string,
  header: string,
  format?: CellFormat,
  extra?: Omit<HeadlessPaneColumn, "key" | "header" | "format">,
): HeadlessPaneColumn {
  return { key, header, ...(format ? { format } : {}), ...extra };
}

export function underRowCol(
  key: string,
  header: string,
  format?: CellFormat,
  extra?: Omit<HeadlessPaneColumn, "key" | "header" | "underRow" | "format">,
): HeadlessPaneColumn {
  return { key, header, underRow: true, ...(format ? { format } : {}), ...extra };
}
