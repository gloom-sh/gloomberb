import { fillRect, parseHex } from "../native/raster/primitives";
import type { CompositeVolumeProfile } from "./types";
import { clamp } from "../../../utils/math";

/** The busiest row reaches this share of the plot width from the right edge. */
const PROFILE_WIDTH_RATIO = 0.28;
const OUTSIDE_OPACITY = 0.16;
const VALUE_AREA_OPACITY = 0.3;
const POC_OPACITY = 0.5;

/**
 * Paints the profile against the right edge, before the series so the price
 * stays on top: faint outside the value area, stronger inside it, strongest
 * at the point of control, which also runs a dotted level across the plot.
 */
export function paintVolumeProfile(
  data: Uint8Array,
  width: number,
  height: number,
  profile: CompositeVolumeProfile,
): void {
  if (profile.maxVolume <= 0) return;
  const color = parseHex(profile.color);
  const maxY = Math.max(height - 1, 0);
  const maxLength = width * PROFILE_WIDTH_RATIO;
  const pocRow = profile.rows.reduce((best, row, index) => (
    row.volume > (profile.rows[best]?.volume ?? -1) ? index : best
  ), 0);
  profile.rows.forEach((row, index) => {
    if (row.volume <= 0) return;
    const top = Math.round(clamp(row.highRatio, 0, 1) * maxY);
    const edge = Math.round(clamp(row.lowRatio, 0, 1) * maxY);
    // A pixel between rows keeps tall bars apart; thin ones would vanish.
    const bottom = Math.max(top, edge - (edge - top >= 4 ? 1 : 0));
    const length = Math.max(1, maxLength * row.volume / profile.maxVolume);
    const opacity = index === pocRow ? POC_OPACITY : row.valueArea ? VALUE_AREA_OPACITY : OUTSIDE_OPACITY;
    fillRect(data, width, height, width - length, top, width - 1, bottom, color, opacity);
  });
  const y = Math.round(clamp(profile.pocRatio, 0, 1) * maxY);
  for (let x = 0; x < width; x += 5) {
    fillRect(data, width, height, x, y, Math.min(x + 1, width - 1), y, color, 0.7);
  }
}

/**
 * The terminal text plot's profile: one bar per text row from the right
 * edge, written into blank cells only so every price mark stays readable.
 * `▓` marks the point of control, `▒` the value area and `░` the rest.
 */
export function writeVolumeProfileText(
  rows: string[][],
  width: number,
  profile: CompositeVolumeProfile,
): void {
  const height = rows.length;
  if (height === 0 || profile.maxVolume <= 0) return;
  const volumes = new Array<number>(height).fill(0);
  const valueArea = new Array<boolean>(height).fill(false);
  for (const row of profile.rows) {
    const line = clamp(Math.round(((row.highRatio + row.lowRatio) / 2) * (height - 1)), 0, height - 1);
    volumes[line]! += row.volume;
    if (row.valueArea) valueArea[line] = true;
  }
  const peak = Math.max(...volumes);
  if (peak <= 0) return;
  const pocLine = clamp(Math.round(profile.pocRatio * (height - 1)), 0, height - 1);
  const maxLength = Math.max(1, Math.floor(width * PROFILE_WIDTH_RATIO));
  volumes.forEach((volume, line) => {
    if (volume <= 0) return;
    const glyph = line === pocLine ? "▓" : valueArea[line] ? "▒" : "░";
    const length = Math.max(1, Math.round(maxLength * volume / peak));
    for (let x = width - 1; x >= Math.max(0, width - length); x -= 1) {
      const current = rows[line]?.[x];
      if (current === " " || current === "·") rows[line]![x] = glyph;
    }
  });
}
