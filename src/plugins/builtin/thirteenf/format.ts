import { formatCompact, formatPercentRaw } from "../../../utils/format";
import type { HoldingAction } from "./types";

export function formatMoneyCompact(value: number | null | undefined): string {
  if (value == null) return "--";
  return `$${formatCompact(value)}`;
}

export function formatShares(value: number | null | undefined): string {
  if (value == null) return "--";
  return formatCompact(value);
}

export function formatPercentMaybe(value: number | null | undefined): string {
  if (value == null) return "--";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(Math.abs(value) >= 0.1 ? 1 : 2)}%`;
}

export function formatRawPercentMaybe(value: number | null | undefined): string {
  if (value == null) return "--";
  return formatPercentRaw(value);
}

export function formatShortDate(value: string | null | undefined): string {
  if (!value) return "--";
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return "--";
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
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
      return "--";
  }
}

export function formatChangeShares(value: number | null | undefined): string {
  if (value == null) return "--";
  if (value === 0) return "0";
  return `${value > 0 ? "+" : ""}${formatCompact(value)}`;
}
