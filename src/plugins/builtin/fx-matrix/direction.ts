import { colors } from "../../../theme/colors";
import { blendHex, contrastRatio } from "../../../theme/color-utils";

/** A cross that moved at least this many percent from its previous close earns the step. */
export const TINT_THRESHOLDS = [0.05, 0.15, 0.3, 0.6, 1] as const;
/**
 * A step holds until the move falls this far below the threshold that earned
 * it: a fifth of the threshold, and never less than 0.02% (about 2 pips on
 * EUR/USD, the size a quote jitters between ticks).
 */
const RELEASE_BAND_SHARE = 0.2;
const RELEASE_BAND_MIN = 0.02;
/** How far each step leans toward the theme's up or down colour. */
const TINT_STRENGTH = [0.14, 0.2, 0.27, 0.35, 0.44] as const;
const MIN_TEXT_CONTRAST = 4.5;

/**
 * The cross's move since the previous close, in percent: the row currency
 * against the column currency, so a positive move is the row currency gaining.
 * Each rate and reference is USD per unit.
 */
export function crossMovePercent(
  rowRate: number,
  rowReference: number,
  columnRate: number,
  columnReference: number,
): number | null {
  const move = (rowRate / rowReference / (columnRate / columnReference) - 1) * 100;
  return Number.isFinite(move) ? move : null;
}

/**
 * The signed tint step (0 for none, 1 to 5 up, -1 to -5 down) of a move.
 * `held` is the step the cell showed last: it stays while the move is still
 * within the release band of its threshold, so a rate ticking around a
 * boundary does not flicker between two shades. A move of the other sign
 * starts afresh.
 */
export function tintLevel(movePercent: number, held = 0): number {
  const sign = Math.sign(movePercent);
  if (sign === 0) return 0;
  const size = Math.abs(movePercent);
  const earned = TINT_THRESHOLDS.filter((threshold) => size >= threshold).length;
  const kept = sign === Math.sign(held) ? Math.abs(held) : 0;
  const heldThreshold = kept > 0 ? TINT_THRESHOLDS[kept - 1]! : 0;
  const holds = kept > earned && size >= heldThreshold - Math.max(heldThreshold * RELEASE_BAND_SHARE, RELEASE_BAND_MIN);
  const level = holds ? kept : earned;
  return level === 0 ? 0 : sign * level;
}

/** The step a cell shows now, remembering it under `key` for the next tick; null forgets it. */
export function nextTintLevel(held: Map<string, number>, key: string, movePercent: number | null): number {
  const level = movePercent === null ? 0 : tintLevel(movePercent, held.get(key) ?? 0);
  if (level === 0) held.delete(key);
  else held.set(key, level);
  return level;
}

const tints = new Map<string, string | undefined>();

/**
 * A cell background for a tint step: the theme's own up or down colour
 * blended into `background`. The strength comes down from the step's until
 * `text` reads as well on it as on the plain background (4.5 to 1 where the
 * theme allows), so the numbers stay the primary element in every theme.
 */
export function directionTint(level: number, surface: { background: string; text: string }): string | undefined {
  if (level === 0) return undefined;
  const hue = level > 0 ? colors.positive : colors.negative;
  const key = `${level}|${hue}|${surface.background}|${surface.text}`;
  if (tints.has(key)) return tints.get(key);
  const floor = Math.min(MIN_TEXT_CONTRAST, contrastRatio(surface.text, surface.background) * 0.9);
  let tint: string | undefined;
  for (let strength = TINT_STRENGTH[Math.abs(level) - 1]!; strength > 0; strength = Math.round((strength - 0.02) * 100) / 100) {
    const candidate = blendHex(surface.background, hue, strength);
    if (contrastRatio(surface.text, candidate) >= floor) { tint = candidate; break; }
  }
  if (tints.size > 512) tints.clear();
  tints.set(key, tint);
  return tint;
}
