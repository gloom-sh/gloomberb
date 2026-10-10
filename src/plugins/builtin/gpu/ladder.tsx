import { Box, Span, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { useThemeColors } from "../../../theme/theme-context";
import { blendHex } from "../../../theme/colors";
import { truncateToDisplayWidth } from "../../../utils/format";
import { gpuAxisLabels, gpuBasisColor, gpuBasisLabel, gpuPrice, type GpuAxisLabel, type GpuLadderRow } from "./model";

const LABEL_CELLS = 28;
const VALUE_CELLS = 17;

const position = (value: number, low: number, high: number) => high > low ? (value - low) / (high - low) : 0.5;
const percent = (ratio: number) => `${(Math.max(0, Math.min(1, ratio)) * 100).toFixed(2)}%`;

/** The domain every basis shares, padded so the ends never touch a band. */
function gpuLadderDomain(rows: readonly GpuLadderRow[]): { low: number; high: number } | null {
  if (!rows.length) return null;
  const min = Math.min(...rows.map((row) => row.min));
  const max = Math.max(...rows.map((row) => row.max));
  const pad = Math.max((max - min) * 0.04, max * 0.02, 0.05);
  return { low: Math.max(0, min - pad), high: max + pad };
}

/** Terminal cells of one track: thin rule for the range, heavy for the quartiles, a bar at the median. */
function trackCells(row: GpuLadderRow, low: number, high: number, cells: number, marker: number | null) {
  const at = (value: number) => Math.max(0, Math.min(cells - 1, Math.round(position(value, low, high) * (cells - 1))));
  const glyphs = Array.from({ length: cells }, () => ({ char: " ", kind: "none" as "none" | "range" | "iqr" | "median" | "marker" }));
  for (let i = at(row.min); i <= at(row.max); i++) glyphs[i] = { char: "─", kind: "range" };
  for (let i = at(row.p25); i <= at(row.p75); i++) glyphs[i] = { char: "━", kind: "iqr" };
  glyphs[at(row.median)] = { char: "┃", kind: "median" };
  if (marker !== null) glyphs[at(marker)] = { char: "◆", kind: "marker" };
  return glyphs;
}

/**
 * Where each basis prices one GPU model on a shared dollar axis: the full
 * range as a thin rule, the middle half as a band, the median as a tick, and
 * the selected row as a marker on its own basis. The desktop draws real
 * elements; the terminal draws box-drawing runs.
 */
export function GpuPriceLadder({ rows, width, height, selected }: {
  rows: readonly GpuLadderRow[]; width: number; height: number;
  selected?: { basis: string; price: number } | null;
}) {
  const colors = useThemeColors();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const domain = gpuLadderDomain(rows);
  if (!domain) return null;
  const shown = rows.slice(0, Math.max(1, height - 1));
  const wide = width >= 120;
  const labelCells = wide ? LABEL_CELLS : 14;
  const valueCells = wide ? VALUE_CELLS : 6;
  // Two cells of padding, two gaps, and one spare so the value never clips.
  const trackCellsWidth = Math.max(8, width - labelCells - valueCells - 5);
  const { low, high } = domain;
  // Labels may hang into the empty label and value columns of the axis row, so the end ticks stay centred.
  const room = { left: labelCells + 1, right: valueCells + 1 };
  const labels = gpuAxisLabels(low, high, trackCellsWidth, room);
  return (
    <Box flexDirection="column" width={width} height={shown.length + 1} paddingX={1} data-gloom-role="gpu-price-ladder">
      {shown.map((row) => {
        const color = gpuBasisColor(row.basis);
        const marker = selected && selected.basis === row.basis ? selected.price : null;
        const summary = `${gpuPrice(row.median)}`;
        const range = wide && row.n > 1 ? `${gpuPrice(row.min)}–${gpuPrice(row.max)}` : "";
        return (
          <Box key={row.basis} flexDirection="row" height={1} gap={1}>
            <Box width={labelCells} flexShrink={0} flexDirection="row" overflow="hidden">
              <Text fg={color}>●</Text>
              <Text fg={colors.text}>{` ${truncateToDisplayWidth(gpuBasisLabel(row.basis, !wide), labelCells - 6)}`}</Text>
              <Text fg={colors.textDim}>{` ${row.n}`}</Text>
            </Box>
            <Box width={trackCellsWidth} height={1} flexShrink={0} overflow="hidden">
              {desktop ? (
                <Box width={trackCellsWidth} height={1} style={{ position: "relative" }}>
                  <Box style={{ position: "absolute", left: percent(position(row.min, low, high)), width: percent(position(row.max, low, high) - position(row.min, low, high)),
                    top: "50%", height: "2px", marginTop: "-1px", borderRadius: "1px", backgroundColor: blendHex(colors.bg, color, 0.55) }} />
                  <Box style={{ position: "absolute", left: percent(position(row.p25, low, high)), width: percent(position(row.p75, low, high) - position(row.p25, low, high)),
                    top: "50%", height: "8px", marginTop: "-4px", minWidth: "3px", borderRadius: "2px", backgroundColor: blendHex(colors.bg, color, 0.85) }} />
                  <Box style={{ position: "absolute", left: percent(position(row.median, low, high)), top: "50%", width: "2px", height: "12px", marginTop: "-6px",
                    marginLeft: "-1px", borderRadius: "1px", backgroundColor: colors.textBright }} />
                  {marker !== null ? <Box style={{ position: "absolute", left: percent(position(marker, low, high)), top: "50%", width: "8px", height: "8px", marginTop: "-4px",
                    marginLeft: "-4px", borderRadius: "50%", backgroundColor: colors.bg, border: `2px solid ${colors.textBright}`, boxSizing: "border-box" }} /> : null}
                </Box>
              ) : (
                <Text>{trackCells(row, low, high, trackCellsWidth, marker).map((cell, index) => (
                  <Span key={index} fg={cell.kind === "median" || cell.kind === "marker" ? colors.textBright : cell.kind === "iqr" ? color : blendHex(colors.bg, color, 0.6)}>{cell.char}</Span>
                ))}</Text>
              )}
            </Box>
            <Box width={valueCells} flexShrink={0} flexDirection="row" justifyContent="flex-end" overflow="hidden">
              <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{summary}</Text>
              {range ? <Text fg={colors.textDim}>{` ${range}`}</Text> : null}
            </Box>
          </Box>
        );
      })}
      <GpuLadderAxis labels={labels} width={trackCellsWidth} room={room} desktop={desktop} />
    </Box>
  );
}

/**
 * Each label centred on its tick, on the scale the bands and markers use. The
 * desktop places real elements by percentage, as it does the markers; the
 * terminal writes the whole axis row so an end label can hang past the track.
 */
function GpuLadderAxis({ labels, width, room, desktop }: { labels: readonly GpuAxisLabel[]; width: number; room: { left: number; right: number }; desktop: boolean }) {
  const colors = useThemeColors();
  if (desktop) {
    return (
      <Box flexDirection="row" height={1}>
        <Box width={room.left} flexShrink={0} />
        <Box width={width} height={1} flexShrink={0} style={{ position: "relative" }}>
          {labels.map((label) => <Box key={label.value} style={{ position: "absolute", left: percent(label.ratio), transform: "translateX(-50%)", whiteSpace: "nowrap" }}>
            <Text fg={colors.textDim}>{label.text}</Text>
          </Box>)}
        </Box>
      </Box>
    );
  }
  const line = Array.from({ length: room.left + width + room.right }, () => " ");
  for (const label of labels) for (let i = 0; i < label.text.length; i++) line[room.left + label.start + i] = label.text[i]!;
  return <Box height={1} flexShrink={0}><Text fg={colors.textDim}>{line.join("").trimEnd()}</Text></Box>;
}
