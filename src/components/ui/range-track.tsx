import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../ui";

export interface RangeTrackProps {
  /** Where the value sits between the low and the high, 0 to 1. */
  position: number;
  /** Cells the track spans. */
  width: number;
  markerColor: string;
  /**
   * Mark a value past either end with an arrow at that end (a square on the
   * desktop) instead of pinning the dot there, so it does not read as the low
   * or the high itself.
   */
  outside?: boolean;
}

/**
 * Where a value sits between a low and a high (a day range, a 52-week range):
 * a rule with a dot on it. The caller draws the endpoints. The terminal draws
 * a box-drawing rule; the desktop draws a real line and dot, never glyphs.
 */
export function RangeTrack({ position, width, markerColor, outside = false }: RangeTrackProps) {
  const colors = useThemeColors();
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const past = !outside ? null : position < 0 ? "below" : position > 1 ? "above" : null;
  const at = position > 0 ? Math.min(1, position) : 0;
  if (width <= 0) return null;
  if (isDesktopWeb) {
    return (
      <Box width={width} height={1} flexShrink={0} style={{ position: "relative", justifyContent: "center" }} data-gloom-role="range-track">
        <Box style={{ position: "absolute", left: 0, right: 0, height: "2px", borderRadius: "1px", backgroundColor: colors.border }} />
        <Box style={{
          position: "absolute",
          left: `${at * 100}%`,
          width: "8px",
          height: "8px",
          marginLeft: "-4px",
          borderRadius: past ? "1px" : "50%",
          backgroundColor: markerColor,
        }} />
      </Box>
    );
  }
  const marker = Math.min(width - 1, Math.round(at * (width - 1)));
  return (
    <Box width={width} height={1} flexShrink={0} flexDirection="row">
      <Text fg={colors.border}>{"─".repeat(marker)}</Text>
      <Text fg={markerColor}>{past === "below" ? "◂" : past === "above" ? "▸" : "●"}</Text>
      <Text fg={colors.border}>{"─".repeat(width - marker - 1)}</Text>
    </Box>
  );
}
