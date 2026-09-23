import {
  clampSurface3DCamera, DEFAULT_SURFACE3D_CAMERA, rotateSurface3DCamera, zoomSurface3DCamera,
  type Surface3DCamera, type Surface3DInput,
} from "../../../components/chart/surface3d/model";

/** Row-major decimal IV. Missing cells remain holes, including across tenors. */
export interface VolatilitySurfaceGrid {
  tenors: readonly number[];
  /**
   * Column coordinates: forward moneyness K/F (one marks the ATM-forward
   * ridge), or signed spot delta when `axis` is "delta" (negative puts, zero
   * ATM, positive calls), laid out evenly from the put wing to the call wing.
   */
  moneyness: readonly number[];
  volatilities: readonly (readonly (number | null)[])[];
  axis?: "moneyness" | "delta";
}
export type SurfaceCamera = Surface3DCamera;
export interface SurfaceCell { tenorIndex: number; moneynessIndex: number }
export const DEFAULT_SURFACE_CAMERA = DEFAULT_SURFACE3D_CAMERA;
export const clampSurfaceCamera = clampSurface3DCamera;
export const rotateSurfaceCamera = rotateSurface3DCamera;
export const zoomSurfaceCamera = zoomSurface3DCamera;

export function tenorLabel(years: number): string {
  const days = years * 365;
  if (days < 21) return `${Math.max(1, Math.round(days))}D`;
  if (days < 335) return `${Math.max(1, Math.round(days / 30.4))}M`;
  return `${Number(years.toFixed(years < 3 ? 1 : 0))}Y`;
}
export function deltaLabel(coordinate: number): string {
  if (Math.abs(coordinate) < 1e-9) return "ATM";
  return `${Math.round(Math.abs(coordinate) * 100)}${coordinate < 0 ? "P" : "C"}`;
}
/** Four to six round vol levels spanning the range. */
export function volatilityTicks(low: number, high: number): number[] {
  const span = Math.max(high - low, 1e-6);
  const step = [0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1].find((candidate) => span / candidate <= 6) ?? 1;
  const ticks: number[] = [];
  for (let value = Math.ceil(low / step - 1e-9) * step; value <= high + 1e-9; value += step) ticks.push(Number(value.toFixed(6)));
  return ticks;
}
const percent = (value: number) => `${Number((value * 100).toFixed(1))}%`;

/**
 * The vertical axis and colour follow the 2nd to 98th percentile of the
 * surface, so a few wild short-dated wing cells poke above the box instead of
 * flattening every other row.
 */
export function volatilitySurfaceInput(grid: VolatilitySurfaceGrid, selected: SurfaceCell | null): Surface3DInput {
  const deltaAxis = grid.axis === "delta";
  const columnCount = grid.moneyness.length, rowCount = grid.tenors.length;
  const samples = grid.volatilities.flat().filter((value): value is number => value != null && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const quantile = (fraction: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.round((samples.length - 1) * fraction)))] ?? 0;
  const minimum = quantile(0.02), maximum = quantile(0.98);
  const pad = Math.max(0.01, (maximum - minimum) * 0.12);
  const ticks = volatilityTicks(Math.max(0, minimum - pad), maximum + pad);
  const zMin = ticks[0] ?? 0, zMax = Math.max(ticks.at(-1) ?? 1, zMin + 0.02);
  const coordinates = grid.moneyness;
  const low = Math.min(...coordinates), high = Math.max(...coordinates);
  const columnPositions = coordinates.map((value, index) => deltaAxis || high === low
    ? (columnCount <= 1 ? 0.5 : index / (columnCount - 1)) : (value - low) / (high - low));
  const rowPositions = grid.tenors.map((_, index) => rowCount <= 1 ? 0.5 : index / (rowCount - 1));
  const xTicks = deltaAxis
    ? coordinates.flatMap((value, index) => [-0.1, -0.25, 0, 0.25, 0.1].some((target) => Math.abs(value - target) < 1e-9)
      ? [{ position: columnPositions[index]!, label: deltaLabel(value) }] : [])
    : (() => {
      const step = high - low > 0.3 ? 0.1 : 0.05;
      const result: { position: number; label: string }[] = [];
      for (let value = Math.ceil(low / step - 1e-9) * step; value <= high + 1e-9; value += step) {
        result.push({ position: high === low ? 0.5 : (value - low) / (high - low), label: `${Math.round(value * 100)}%` });
      }
      return result;
    })();
  const tickRows = [...new Set(Array.from({ length: Math.min(6, rowCount) }, (_, index) =>
    Math.round(index * (rowCount - 1) / Math.max(1, Math.min(6, rowCount) - 1))))];
  const yTicks = tickRows.flatMap((row) => Number.isFinite(grid.tenors[row]) && grid.tenors[row]! > 0
    ? [{ position: rowPositions[row]!, label: tenorLabel(grid.tenors[row]!) }] : []);
  const ridgeColumn = deltaAxis ? coordinates.findIndex((value) => Math.abs(value) < 1e-9) : (() => {
    const index = coordinates.findIndex((value) => value >= 1 - 1e-9);
    if (index <= 0) return index;
    return index - 1 + (1 - coordinates[index - 1]!) / (coordinates[index]! - coordinates[index - 1]!);
  })();
  return {
    values: grid.volatilities.map((row, r) => row.map((value) => value != null && Number.isFinite(value) && value >= 0
      && Number.isFinite(grid.tenors[r]) && grid.tenors[r]! > 0 ? value : null)),
    columnPositions, rowPositions, zMin, zMax, xTicks, yTicks,
    zTicks: ticks.map((value) => ({ value, label: percent(value) })),
    titles: { x: deltaAxis ? "DELTA" : "FORWARD MONEYNESS", y: "EXPIRY", z: "IMPLIED VOL" },
    ridgeColumn: ridgeColumn >= 0 ? ridgeColumn : null,
    ridgeLabel: "ATM",
    selected: selected && selected.tenorIndex >= 0 ? { row: selected.tenorIndex, column: selected.moneynessIndex } : null,
    formatValue: (value) => `${(value * 100).toFixed(1)}%`,
  };
}
