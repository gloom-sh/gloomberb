import { blendHex } from "../../theme/colors";
import { perceivedLightness } from "../../theme/color-utils";
import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../ui";

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

/** A track's tint of the bar colour, where that already stands off the page. */
const TRACK_TINT = 0.16;
/** The lightness (L*) a track keeps from the page, so the bar's scale reads alike on every theme. */
export const TRACK_MIN_SEPARATION = 8;
const TRACK_MAX_TINT = 0.5;
const TRACK_TINT_STEP = 0.02;

/**
 * The unfilled length of a bar: the page tinted by the bar's colour, tinted
 * further where that would barely stand off the page, never past half the colour.
 */
export function ratioBarTrack(page: string, color: string): string {
  let tint = TRACK_TINT;
  let track = blendHex(page, color, tint);
  const separation = (color: string) => Math.abs(perceivedLightness(color) - perceivedLightness(page));
  while (separation(track) < TRACK_MIN_SEPARATION && tint < TRACK_MAX_TINT) {
    tint = Math.min(TRACK_MAX_TINT, tint + TRACK_TINT_STEP);
    track = blendHex(page, color, tint);
  }
  return track;
}

export interface RatioBarGlyphOptions {
  /** `end` grows the bar from the right, as the left half of a two-sided chart. */
  align?: "start" | "end";
  /**
   * The partial cell's step. Only a bar that grows from the start can use
   * eighths: a right-aligned bar has nothing finer than a right half block.
   */
  resolution?: "half" | "eighth";
}

/**
 * A ratio as terminal block glyphs: whole cells and one partial cell, rounded
 * to the nearest step and capped at the width. A ratio above zero keeps at
 * least one step, as the desktop bar keeps a 2px sliver, so a small value
 * never reads as none.
 */
export function ratioBarGlyphs(ratio: number, width: number, { align = "start", resolution = "half" }: RatioBarGlyphOptions = {}): string {
  const cells = Math.max(0, Math.floor(width));
  if (!(ratio > 0) || cells === 0) return "";
  const steps = align === "start" && resolution === "eighth" ? 8 : 2;
  const units = Math.min(cells * steps, Math.max(1, Math.round(Math.min(1, ratio) * cells * steps)));
  const full = "█".repeat(Math.floor(units / steps));
  const rest = units % steps;
  if (align === "end") return `${rest ? "▐" : ""}${full}`;
  return `${full}${steps === 8 ? EIGHTHS[rest] : rest ? "▌" : ""}`;
}

export interface RatioBarProps extends RatioBarGlyphOptions {
  /** The filled share of the bar, 0 to 1. */
  ratio: number;
  /** Cells the bar spans when full. */
  width: number;
  color: string;
  /** Tint the unfilled length on the desktop, so a short bar still reads against its scale. */
  track?: boolean;
  /** Bar height in pixels on the desktop. */
  thickness?: number;
}

/**
 * One value as a share of a scale: a count against the largest row, a move
 * against a full-scale move. The terminal draws block runs; the desktop draws
 * real elements, so the length is exact rather than cell-quantized.
 */
export function RatioBar({ ratio, width, color, align = "start", resolution = "half", track = false, thickness = 9 }: RatioBarProps) {
  const colors = useThemeColors();
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const justifyContent = align === "end" ? "flex-end" : "flex-start";
  if (width <= 0) return null;
  if (isDesktopWeb) {
    const filled = ratio > 0 ? Math.min(1, ratio) : 0;
    return (
      <Box width={width} height={1} flexShrink={0} flexDirection="row" alignItems="center" data-gloom-role="ratio-bar">
        <Box
          flexDirection="row"
          justifyContent={justifyContent}
          style={{
            width: "100%",
            height: `${thickness}px`,
            borderRadius: "2px",
            overflow: "hidden",
            background: track ? ratioBarTrack(colors.bg, color) : undefined,
          }}
        >
          <Box
            backgroundColor={color}
            style={{ width: `${(filled * 100).toFixed(2)}%`, height: "100%", minWidth: filled > 0 ? "2px" : "0", borderRadius: "2px" }}
          />
        </Box>
      </Box>
    );
  }
  return (
    <Box width={width} height={1} flexShrink={0} flexDirection="row" justifyContent={justifyContent} overflow="hidden">
      <Text fg={color}>{ratioBarGlyphs(ratio, width, { align, resolution })}</Text>
    </Box>
  );
}
