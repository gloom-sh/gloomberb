import { colors } from "../../../theme/colors";
import { formatCompactAmount } from "../../../utils/format";

export function sharpeColor(sharpe: number): string {
  if (sharpe > 1) return colors.positive;
  if (sharpe < 0) return colors.negative;
  return colors.textDim;
}

export function sharpeLabel(sharpe: number): string {
  if (sharpe > 1) return "good";
  if (sharpe >= 0) return "okay";
  return "poor";
}

export function betaLabel(beta: number): string {
  if (beta > 1.2) return "high vol";
  if (beta >= 0.8) return "market";
  return "defensive";
}

export function betaColor(beta: number): string {
  if (beta > 1.2) return colors.negative;
  if (beta >= 0.8) return colors.textMuted ?? colors.text;
  return colors.positive;
}

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
