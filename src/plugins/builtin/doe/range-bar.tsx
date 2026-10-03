import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../../ui";

/** Where a marker sits on a track of `cells`, and whether it is past an end. */
function rangeMarker(position: number, cells: number): { index: number; outside: "below" | "above" | null } {
  const last = Math.max(0, cells - 1);
  if (position < 0) return { index: 0, outside: "below" };
  if (position > 100) return { index: last, outside: "above" };
  return { index: Math.round((position / 100) * last), outside: null };
}

/**
 * The value's place in its five-year range: the low at the left, the high at
 * the right, a marker past an end when the value is outside it. The desktop
 * draws real elements; the terminal a rule of cells, so box-drawing glyphs
 * never reach the browser renderer.
 */
export function DoeRangeBar({ position, width }: { position: number | null; width: number }) {
  const colors = useThemeColors();
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  if (position == null || width < 3) return <Text fg={colors.textDim}>{""}</Text>;
  const cells = Math.max(3, width - 1);
  const marker = rangeMarker(position, cells);
  const markerColor = marker.outside ? colors.warning : colors.textBright;
  if (isDesktopWeb) {
    const left = marker.outside === "below" ? 0 : marker.outside === "above" ? 100 : position;
    return (
      <Box width={cells} height={1} style={{ position: "relative", justifyContent: "center" }}>
        <Box style={{ position: "absolute", left: 0, right: 0, height: "2px", borderRadius: "1px", backgroundColor: colors.border }} />
        <Box style={{
          position: "absolute", left: `${left}%`, width: "8px", height: "8px", marginLeft: "-4px",
          borderRadius: marker.outside ? "1px" : "50%", backgroundColor: markerColor,
        }} />
      </Box>
    );
  }
  const glyph = marker.outside === "below" ? "◂" : marker.outside === "above" ? "▸" : "●";
  return (
    <Box width={cells} flexDirection="row">
      <Text fg={colors.border}>{"─".repeat(marker.index)}</Text>
      <Text fg={markerColor}>{glyph}</Text>
      <Text fg={colors.border}>{"─".repeat(Math.max(0, cells - marker.index - 1))}</Text>
    </Box>
  );
}
