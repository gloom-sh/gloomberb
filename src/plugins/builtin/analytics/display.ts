import { colors, glyphs } from "../../../theme/colors";
import { formatCompact } from "../../../utils/format";

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

export function formatSignedCompact(value: number): string {
  return `${value >= 0 ? "+" : ""}${formatCompact(value)}`;
}

export function formatWeight(weight: number): string {
  return `${(weight * 100).toFixed(1)}%`;
}

export function formatReturn(value: number): string {
  const pct = value * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

export function renderBar(weight: number, maxWidth: number): string {
  const filled = Math.round(weight * maxWidth);
  return glyphs.bar.full.repeat(Math.min(filled, maxWidth));
}
