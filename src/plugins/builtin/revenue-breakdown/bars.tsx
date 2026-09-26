import { Box, Text, useUiHost } from "../../../ui";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { BAR_CELLS_PER_QUARTER } from "./model";

/**
 * One bar per quarter, oldest first. Taller bars are brighter, so the peak
 * reads before the scale does. A quarter the company did not report draws a
 * faint baseline, so a gap reads as missing rather than as a broken chart.
 * The terminal draws eighth-block glyphs; the desktop draws real elements so
 * heights are exact. Each quarter is a full-height slot, so a short bar is as
 * easy to point at as a tall one.
 */

const RAMP = "▁▂▃▄▅▆▇█";
const TERMINAL_GAP = "·";

export function terminalBarGlyph(level: number): string {
  return RAMP[Math.min(RAMP.length, Math.max(1, Math.round(level * RAMP.length))) - 1]!;
}

/** Where the pointer rests: the quarter and, on the desktop, the page position. */
export interface BarHover {
  index: number;
  x?: number;
  y?: number;
}

export function QuarterBars({
  levels,
  width,
  muted = false,
  activeIndex = null,
  onHover,
}: {
  levels: (number | null)[];
  width: number;
  /** Placeholder bars under the locked rows. */
  muted?: boolean;
  /** The quarter under the pointer, drawn brighter. */
  activeIndex?: number | null;
  onHover?: (hover: BarHover | null) => void;
}) {
  const colors = useThemeColors();
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const low = muted ? blendHex(colors.bg, colors.textMuted, 0.5) : blendHex(colors.bg, colors.textMuted, 0.75);
  const high = muted ? colors.textMuted : colors.textBright;
  const shade = (level: number) => blendHex(low, high, level);
  const gap = blendHex(colors.bg, colors.textMuted, 0.8);
  const hoverable = !!onHover && !muted;

  if (isDesktopWeb) {
    return (
      <Box
        width={width}
        height={1}
        flexDirection="row"
        style={{ gap: "3px", width: "100%", maxWidth: `${levels.length * 22}px`, height: "100%", boxSizing: "border-box" }}
        data-gloom-role="revenue-quarter-bars"
        onMouseOut={hoverable ? () => onHover!(null) : undefined}
      >
        {levels.map((level, index) => (
          <Box
            key={index}
            onMouseOver={hoverable
              ? (event: { pixelX?: number; pixelY?: number }) => onHover!({ index, x: event.pixelX, y: event.pixelY })
              : undefined}
            style={{
              flex: "1 1 0",
              height: "100%",
              display: "flex",
              alignItems: "flex-end",
              paddingTop: "2px",
              paddingBottom: "2px",
              boxSizing: "border-box",
            }}
          >
            <Box
              style={level === null
                ? { width: "100%", height: "0", borderBottom: `2px dotted ${gap}` }
                : {
                  width: "100%",
                  height: `${Math.max(8, level * 100).toFixed(1)}%`,
                  backgroundColor: index === activeIndex ? colors.borderFocused : shade(level),
                  borderRadius: "1px",
                }}
            />
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box width={width} height={1} flexDirection="row" overflow="hidden" onMouseOut={hoverable ? () => onHover!(null) : undefined}>
      {levels.map((level, index) => (
        <Box
          key={index}
          width={BAR_CELLS_PER_QUARTER}
          onMouseOver={hoverable ? () => onHover!({ index }) : undefined}
        >
          <Text
            fg={index === activeIndex ? colors.borderFocused : level === null ? gap : shade(level)}
            selectable={false}
          >
            {level === null ? TERMINAL_GAP : terminalBarGlyph(level)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
