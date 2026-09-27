import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { blendHex, colors } from "../../../theme/colors";
import { formatNumber, truncateToDisplayWidth } from "../../../utils/format";
import type { ShareBarRow } from "./model";
import { formatShare } from "./model";

/**
 * Horizontal share bars: label, bar sized against the largest row, count and
 * share, and the 30-day change when the history reaches back that far. The
 * terminal draws block runs at half-cell resolution; the desktop draws real
 * elements so length is fractional.
 */

export interface ShareBarsProps {
  rows: ShareBarRow[];
  width: number;
  color?: string;
  /** Show the 30d delta column when any row has one. */
  showDelta?: boolean;
}

const COUNT_WIDTH = 6;
const SHARE_WIDTH = 5;
const DELTA_WIDTH = 6;

function labelWidthFor(width: number): number {
  return Math.max(8, Math.min(18, Math.floor(width * 0.28)));
}

function deltaText(delta: number | null): string {
  if (delta == null || delta === 0) return "";
  return `${delta > 0 ? "+" : ""}${formatNumber(delta, 0)}`;
}

function deltaColor(delta: number | null): string {
  if (delta == null || delta === 0) return colors.textDim;
  return delta > 0 ? colors.positive : colors.negative;
}

function terminalBar(ratio: number, cells: number): string {
  const units = Math.round(ratio * cells * 2);
  const full = Math.floor(units / 2);
  return `${"█".repeat(full)}${units % 2 ? "▌" : ""}`;
}

export function ShareBars({ rows, width, color = colors.borderFocused, showDelta = false }: ShareBarsProps) {
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const hasDelta = showDelta && rows.some((row) => row.delta != null && row.delta !== 0);
  const labelWidth = labelWidthFor(width);
  const trailing = COUNT_WIDTH + SHARE_WIDTH + (hasDelta ? DELTA_WIDTH + 1 : 0) + 2;
  const barWidth = Math.max(4, width - labelWidth - trailing - 2);
  const track = blendHex(colors.bg, color, 0.16);

  return (
    <Box flexDirection="column" width={width} data-gloom-ui="share-bars">
      {rows.map((row) => (
        <Box key={row.key} flexDirection="row" height={1} alignItems="center">
          <Box width={labelWidth} flexShrink={0} overflow="hidden">
            <Text fg={row.key === "rest" ? colors.textDim : colors.text}>
              {truncateToDisplayWidth(row.label, labelWidth - 1)}
            </Text>
          </Box>
          <Box width={barWidth} flexShrink={0} overflow="hidden" flexDirection="row" alignItems="center">
            {isDesktopWeb ? (
              <Box
                flexDirection="row"
                style={{ width: "100%", height: "9px", background: track, borderRadius: "2px", overflow: "hidden" }}
              >
                <Box
                  backgroundColor={color}
                  style={{ width: `${(row.ratio * 100).toFixed(2)}%`, height: "100%", minWidth: row.count > 0 ? "2px" : "0", borderRadius: "2px" }}
                />
              </Box>
            ) : (
              <Text fg={color}>{terminalBar(row.ratio, barWidth)}</Text>
            )}
          </Box>
          <Box width={COUNT_WIDTH + 1} flexShrink={0} justifyContent="flex-end">
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{formatNumber(row.count, 0)}</Text>
          </Box>
          <Box width={SHARE_WIDTH + 1} flexShrink={0} justifyContent="flex-end">
            <Text fg={colors.textDim}>{formatShare(row.share)}</Text>
          </Box>
          {hasDelta ? (
            <Box width={DELTA_WIDTH + 1} flexShrink={0} justifyContent="flex-end">
              <Text fg={deltaColor(row.delta)}>{deltaText(row.delta)}</Text>
            </Box>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}
