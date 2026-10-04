import type { CreditHeadroom } from "../../../api-client/credit-documents";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { covenantUsage, headroomTone } from "./model";

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
/** Where the limit sits along the gauge; the rest shows how far a breach runs past it. */
const LIMIT_AT = 0.8;

function blocks(cells: number): string {
  const full = Math.floor(cells);
  const eighth = Math.round((cells - full) * 8);
  return eighth === 8 ? "█".repeat(full + 1) : `${"█".repeat(full)}${EIGHTHS[eighth]}`;
}

/**
 * How much of a covenant's limit the reported metric uses, against a marker at
 * the limit. Quiet while comfortable, amber when headroom is low, red past it.
 * Nothing draws when headroom could not be computed. The desktop draws
 * elements; the terminal draws block cells.
 */
export function HeadroomGauge({ covenant, width, selected }: { covenant: CreditHeadroom; width: number; selected: boolean }) {
  const colors = useThemeColors();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const usage = covenantUsage(covenant);
  if (usage === null || width < 4) return <Text>{""}</Text>;
  const tone = headroomTone(covenant);
  const fill = tone === "negative" ? colors.negative : tone === "warning" ? colors.warning : colors.textDim;
  const marker = selected ? colors.selectedText : colors.textBright;
  const ratio = Math.min(1, Math.max(0, usage * LIMIT_AT));

  if (desktop) {
    return (
      <Box width={width} height={1} flexDirection="row" alignItems="center">
        <Box flexGrow={1} style={{ position: "relative", height: "9px" }}>
          <Box style={{ position: "absolute", left: 0, right: 0, top: "4px", height: "1px", background: colors.border }} />
          <Box backgroundColor={fill} style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(ratio * 100).toFixed(2)}%`, minWidth: ratio > 0 ? "2px" : 0, borderRadius: "1px" }} />
          <Box backgroundColor={marker} style={{ position: "absolute", left: `${LIMIT_AT * 100}%`, top: "-2px", bottom: "-2px", width: "1px" }} />
        </Box>
      </Box>
    );
  }

  // In cells the limit is a whole column: usage 1 fills up to it, a breach runs through it.
  const limit = Math.min(width - 1, Math.round(width * LIMIT_AT));
  const cells = Math.min(width, Math.max(0, usage) * limit);
  const after = cells > limit + 1 ? blocks(cells - limit - 1) : "";
  return (
    <Box flexDirection="row" width={width} overflow="hidden">
      <Text fg={fill}>{blocks(Math.min(cells, limit)).padEnd(limit)}</Text>
      <Text fg={marker} bg={cells > limit ? fill : undefined}>│</Text>
      {after ? <Text fg={fill}>{after}</Text> : null}
    </Box>
  );
}
