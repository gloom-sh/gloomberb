import type { ShortDateOptions } from "../../../utils/datetime-format";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import type { HoldingAction } from "./types";

export function formatMoneyCompact(value: number | null | undefined): string {
  if (value == null) return "--";
  return value < 0 ? `-$${formatCompact(-value, { fixedDecimals: true })}` : `$${formatCompact(value, { fixedDecimals: true })}`;
}

export function formatShares(value: number | null | undefined): string {
  if (value == null) return "--";
  return formatCompact(value, { fixedDecimals: true });
}

export function formatPercentMaybe(value: number | null | undefined): string {
  if (value == null) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(Math.abs(value) >= 0.1 ? 1 : 2)}%`;
}

/** Portfolio weights are shares of a whole, so they carry no sign. */
export function formatWeightMaybe(value: number | null | undefined): string {
  if (value == null) return "--";
  return `${(value * 100).toFixed(Math.abs(value) >= 0.1 ? 1 : 2)}%`;
}

export function formatRawPercentMaybe(value: number | null | undefined): string {
  if (value == null) return "--";
  return formatPercentRaw(value);
}

/** Filing dates are "YYYY-MM-DD" calendar days, shown as "Jan 5". */
export const FILING_DAY_FORMAT: ShortDateOptions = { year: false, utc: true, fallback: "--" };

export function actionLabel(action: HoldingAction): string {
  switch (action) {
    case "new":
      return "New";
    case "add":
      return "Add";
    case "trim":
      return "Trim";
    case "exit":
      return "Exit";
    case "held":
      return "Held";
    case "unknown":
      return "--";
  }
}

export function formatChangeShares(value: number | null | undefined): string {
  if (value == null) return "--";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${formatCompact(value)}`;
}
