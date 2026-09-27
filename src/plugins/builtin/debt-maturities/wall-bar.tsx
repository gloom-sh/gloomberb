import { Box, Text, useUiCapabilities } from "../../../ui";
import { colors } from "../../../theme/colors";
import { displayWidth } from "../../../utils/format";
import type { BucketBar } from "./model";

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const CAP = "▸";

/** Cells the capped bar keeps after its end for the cap and the value. */
export function wallLabelReserve(label: string): number {
  return displayWidth(label) + 2;
}

function blocks(cells: number): string {
  const full = Math.floor(cells);
  const eighth = Math.round((cells - full) * 8);
  return eighth === 8 ? "█".repeat(full + 1) : `${"█".repeat(full)}${EIGHTHS[eighth]}`;
}

/**
 * One maturity bucket of the wall, inline in its table row. Dated buckets
 * share one scale; a bucket past it (Thereafter, open ended) runs to the end,
 * capped, with its value, so its length is never read as a measure. The
 * desktop draws an element; the terminal draws block cells.
 */
export function WallBar({ bar, width, reserve, label, selected }: {
  bar: BucketBar | null;
  width: number;
  /** Cells kept clear at the end so a capped bar outruns every dated one. */
  reserve: number;
  label: string;
  selected: boolean;
}) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  if (!bar || width <= 0) return <Text fg={colors.textDim}>{""}</Text>;
  const scale = Math.max(1, width - reserve);
  const labelColor = selected ? colors.selectedText : colors.text;

  if (isDesktopWeb) {
    return (
      <Box width={width} flexDirection="row" alignItems="center" gap={1} overflow="hidden">
        <Box flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row" alignItems="center">
          <Box
            backgroundColor={colors.warning}
            style={{
              width: bar.capped ? "100%" : `${((bar.ratio * scale) / width * 100).toFixed(2)}%`,
              height: "9px",
              borderRadius: "2px",
              minWidth: bar.ratio > 0 ? "2px" : "0",
            }}
          />
        </Box>
        {bar.capped ? <Text fg={labelColor}>{`${CAP} ${label}`}</Text> : null}
      </Box>
    );
  }

  if (bar.capped) {
    return (
      <Box flexDirection="row" width={width} overflow="hidden">
        <Text fg={colors.warning}>{"█".repeat(scale)}</Text>
        <Text fg={labelColor}>{`${CAP} ${label}`}</Text>
      </Box>
    );
  }
  return <Text fg={colors.warning}>{blocks(bar.ratio * scale)}</Text>;
}
