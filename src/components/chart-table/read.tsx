import { useThemeColors } from "../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../ui";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";
import { wrapTextLines } from "../../utils/text-wrap";
import { ClippedText } from "../ui/display";

/** The terminal wraps a read onto at most this many rows; a longer one ends in an ellipsis on the last. */
export const CHART_READ_MAX_ROWS = 3;
/** The read's inset on each side, as on the query bar and the legend above it. */
const READ_INSET = 1;

/**
 * The terminal's lines for a read under a chart at a pane `width`: the whole
 * sentence on one row when it fits, otherwise wrapped at words onto up to
 * `CHART_READ_MAX_ROWS` rows. None when there is no read or no room for one.
 */
export function chartReadLines(text: string | null | undefined, width: number): string[] {
  const room = Math.floor(width) - 2 * READ_INSET;
  const read = text?.trim();
  if (!read || room <= 0) return [];
  if (displayWidth(read) <= room) return [read];
  const lines = wrapTextLines(read, room);
  if (lines.length <= CHART_READ_MAX_ROWS) return lines;
  return [
    ...lines.slice(0, CHART_READ_MAX_ROWS - 1),
    truncateToDisplayWidth(lines.slice(CHART_READ_MAX_ROWS - 1).join(" "), room),
  ];
}

/**
 * The rows the longest of these reads needs under a chart at a pane `width`
 * (none when none has one). A pane puts it in `minRows` so the band does not
 * flip between a chart and a strip as the selection moves between a short
 * read and a long one. The desktop and the web cut a read by CSS on one row.
 */
export function useChartReadRows(texts: ReadonlyArray<string | null | undefined>, width: number): number {
  const { nativePaneChrome } = useUiCapabilities();
  let rows = 0;
  for (const text of texts) {
    const lines = chartReadLines(text, width).length;
    rows = Math.max(rows, nativePaneChrome ? Math.min(1, lines) : lines);
  }
  return rows;
}

export interface ChartReadProps {
  /** The plain sentence worked out from the numbers, as the server wrote it. */
  text: string | null | undefined;
  /** The pane's width: the read sits one cell in from each edge. */
  width: number;
}

/**
 * The plain read under a chart's axis. In the terminal the whole sentence is
 * wrapped onto up to `CHART_READ_MAX_ROWS` rows (take its rows from the chart
 * with `useChartReadRows`); the desktop and the web keep one row and cut it
 * by CSS where its box ends.
 */
export function ChartRead({ text, width }: ChartReadProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const lines = chartReadLines(text, width);
  if (lines.length === 0) return null;
  if (nativePaneChrome) {
    return <Box height={1} paddingX={READ_INSET}><ClippedText fg={colors.textMuted} text={text!.trim()} width={width - 2 * READ_INSET} /></Box>;
  }
  return (
    <Box flexDirection="column" height={lines.length} flexShrink={0}>
      {lines.map((line, index) => (
        <Box key={index} height={1} paddingX={READ_INSET}><Text fg={colors.textMuted}>{line}</Text></Box>
      ))}
    </Box>
  );
}
