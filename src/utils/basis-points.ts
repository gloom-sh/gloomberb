/**
 * A move or spread given in percentage points, in basis points: 0.044 is 4.4,
 * 0.44 is 44. `digits` keeps decimals (`1` for 4.4bp); float noise
 * (0.07 * 100 = 7.000000000000001) never reaches the result, and a rounded
 * zero is 0, never -0.
 */
export function toBasisPoints(percentagePoints: number, digits = 0): number {
  const scale = 10 ** digits;
  const rounded = Math.round(percentagePoints * 100 * scale) / scale;
  return rounded === 0 ? 0 : rounded;
}

/** A change in percentage points read in basis points, signed: `+7bp`, `-12bp`, `0bp`. */
export function formatBasisPoints(percentagePoints: number, digits = 0): string {
  const bp = toBasisPoints(percentagePoints, digits);
  return `${bp > 0 ? "+" : ""}${bp.toFixed(digits)}bp`;
}
