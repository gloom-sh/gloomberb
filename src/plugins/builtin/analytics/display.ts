import { formatCompactAmount } from "../../../utils/format";

// P&L moves with every streamed price; fixed decimals keep the percent detail after it still.
export function formatSignedCompact(value: number | null): string {
  return formatCompactAmount(value ?? undefined, { signed: true });
}

export function formatWeight(weight: number | null): string {
  if (weight == null || !Number.isFinite(weight)) return "—";
  return `${(weight * 100).toFixed(1)}%`;
}

export function formatReturn(value: number): string {
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function renderBar(weight: number | null, maxWidth: number): string {
  if (weight == null || !Number.isFinite(weight) || weight <= 0) return "";
  const filled = Math.round(weight * maxWidth);
  return "█".repeat(Math.min(filled, maxWidth));
}
