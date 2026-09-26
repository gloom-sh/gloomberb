import { Box, Text, useUiHost } from "../../../ui";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { BAR_CELLS_PER_QUARTER } from "./model";

/**
 * One bar per quarter, oldest first. Taller bars are brighter, so the peak
 * reads before the scale does. The terminal draws eighth-block glyphs; the
 * desktop draws real elements so heights are exact.
 */

const RAMP = "▁▂▃▄▅▆▇█";

export function terminalBarGlyph(level: number): string {
  return RAMP[Math.min(RAMP.length, Math.max(1, Math.round(level * RAMP.length))) - 1]!;
}

export function QuarterBars({
  levels,
  width,
  muted = false,
}: {
  levels: (number | null)[];
  width: number;
  /** Placeholder bars under the locked rows. */
  muted?: boolean;
}) {
  const colors = useThemeColors();
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const low = muted ? blendHex(colors.bg, colors.textMuted, 0.5) : blendHex(colors.bg, colors.textMuted, 0.75);
  const high = muted ? colors.textMuted : colors.textBright;
  const shade = (level: number) => blendHex(low, high, level);

  if (isDesktopWeb) {
    return (
      <Box
        width={width}
        height={1}
        flexDirection="row"
        alignItems="flex-end"
        style={{ gap: "3px", width: "100%", maxWidth: `${levels.length * 22}px`, height: "100%", paddingTop: "2px", paddingBottom: "2px", boxSizing: "border-box" }}
        data-gloom-role="revenue-quarter-bars"
      >
        {levels.map((level, index) => (
          <Box
            key={index}
            style={{
              flex: "1 1 0",
              height: level === null ? "0" : `${Math.max(8, level * 100).toFixed(1)}%`,
              backgroundColor: level === null ? "transparent" : shade(level),
              borderRadius: "1px",
            }}
          />
        ))}
      </Box>
    );
  }

  return (
    <Box width={width} height={1} flexDirection="row" overflow="hidden">
      {levels.map((level, index) => (
        <Text key={index} fg={level === null ? colors.textMuted : shade(level)} selectable={false}>
          {(level === null ? " " : terminalBarGlyph(level)).padEnd(BAR_CELLS_PER_QUARTER)}
        </Text>
      ))}
    </Box>
  );
}
