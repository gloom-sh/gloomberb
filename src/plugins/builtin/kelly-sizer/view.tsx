import type { KeyEventLike } from "../../../react/input";
import { formatNumber, formatPercentRaw } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";

export function formatPct(value: number, decimals = 1): string {
  return `${formatNumber(value * 100, decimals)}%`;
}

export function formatSignedPct(value: number): string {
  return formatPercentRaw(value * 100);
}

export function isPlainShortcut(event: KeyEventLike, ...names: string[]): boolean {
  if (isPlainKey(event, ...names)) return true;
  const key = event.key?.toLowerCase();
  return !event.ctrl && !event.meta && !event.super && !event.alt && names.includes(key);
}

export function buildKellyCurveXAxisLabels(maxFraction: number): string[] {
  if (!Number.isFinite(maxFraction) || maxFraction <= 0) return [];
  return [0, 0.25, 0.5, 0.75, 1].map((ratio) => formatPct(maxFraction * ratio, 0));
}
