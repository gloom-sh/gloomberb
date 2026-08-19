import { Box, Text, useUiHost } from "../../../ui";
import { colors } from "../../../theme/colors";
import { moveBarRatio } from "./sector-model";

export interface SectorMoveBarProps {
  changePercent: number | null;
  width: number;
}

/**
 * The session move as a length, not as a number that is already in the 1D
 * column. Desktop draws a real element; the terminal falls back to block cells,
 * so box-drawing characters never reach the browser renderer.
 */
export function SectorMoveBar({ changePercent, width }: SectorMoveBarProps) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  if (changePercent == null || width <= 0) return <Text fg={colors.textDim}>{""}</Text>;

  const ratio = moveBarRatio(changePercent);
  const color = changePercent >= 0 ? colors.positive : colors.negative;

  if (isDesktopWeb) {
    return (
      <Box width={width} flexDirection="row" alignItems="center" overflow="hidden">
        <Box
          backgroundColor={color}
          style={{
            width: `${(ratio * 100).toFixed(2)}%`,
            height: "9px",
            borderRadius: "2px",
            minWidth: ratio > 0 ? "2px" : "0",
          }}
        />
      </Box>
    );
  }

  const cells = ratio * width;
  const full = Math.floor(cells);
  const half = cells - full >= 0.5;
  const bar = `${"█".repeat(full)}${half ? "▌" : ""}`;
  return <Text fg={color}>{bar}</Text>;
}
