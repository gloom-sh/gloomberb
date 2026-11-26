import { MISSING_VALUE, formatCompact, formatPercentRaw } from "../../../utils/format";
import type { HoldingAction } from "./types";

export function formatMoneyCompact(value: number | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  return value < 0 ? `-$${formatCompact(-value, { fixedDecimals: true })}` : `$${formatCompact(value, { fixedDecimals: true })}`;
}

export function formatShares(value: number | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  return formatCompact(value, { fixedDecimals: true });
}

/** Two decimals at every size, so a column of them keeps one precision: 22.00% over 5.01%, never 22.0%. */
export function formatPercentMaybe(value: number | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

/** Portfolio weights are shares of a whole, so they carry no sign; two decimals at every size, as formatPercentMaybe. */
export function formatWeightMaybe(value: number | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  return `${(value * 100).toFixed(2)}%`;
}

export function formatRawPercentMaybe(value: number | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  return formatPercentRaw(value);
}


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
      return MISSING_VALUE;
  }
}

/** A holding's action, and when a split moved it to a new CUSIP, that: "Held, new CUSIP, 1-for-10 split". */
export function holdingActionLabel(row: { action: HoldingAction; cusipChange?: { label: string } }): string {
  return row.cusipChange ? `${actionLabel(row.action)}, ${row.cusipChange.label}` : actionLabel(row.action);
}

export function formatChangeShares(value: number | null | undefined): string {
  if (value == null) return MISSING_VALUE;
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${formatCompact(value)}`;
}
