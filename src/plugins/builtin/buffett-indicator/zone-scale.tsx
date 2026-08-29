import { Box, Text } from "../../../ui";
import { colors } from "../../../theme/colors";
import {
  PARITY_RATIO,
  ZONE_SCALE_MAX,
  ZONE_SCALE_TICKS,
  zoneScaleBands,
  zoneScaleMarkerColumn,
} from "./defs";

export function ZoneColorScale({
  value,
  width,
  markerColor,
}: {
  value: number;
  width: number;
  markerColor: string;
}) {
  const scaleWidth = Math.max(12, width);
  const bands = zoneScaleBands();
  const marker = zoneScaleMarkerColumn(value, scaleWidth);
  const cells: Array<{ char: string; color: string }> = [];

  for (let column = 0; column < scaleWidth; column += 1) {
    const ratio = scaleWidth === 1 ? 0 : (column / (scaleWidth - 1)) * ZONE_SCALE_MAX;
    const band = bands.find((entry) => ratio >= entry.from && ratio < entry.to) ?? bands[bands.length - 1]!;
    cells.push({
      char: column === marker ? "●" : "━",
      color: column === marker ? markerColor : band.color,
    });
  }

  const underLabel = scaleWidth >= 48 ? "undervalued" : scaleWidth >= 28 ? "under" : "";
  const overLabel = scaleWidth >= 48 ? "overvalued" : scaleWidth >= 28 ? "over" : "";
  const fairLabel = scaleWidth >= 64 ? "fair" : "";
  const captionCells: Array<{ char: string; color: string }> = Array.from(
    { length: scaleWidth },
    () => ({ char: " ", color: colors.textDim }),
  );
  const placeCaption = (label: string, start: number) => {
    for (let index = 0; index < label.length; index += 1) {
      const column = start + index;
      if (column < 0 || column >= scaleWidth) continue;
      captionCells[column] = { char: label[index]!, color: colors.textDim };
    }
  };
  if (underLabel) placeCaption(underLabel, 0);
  if (overLabel) placeCaption(overLabel, scaleWidth - overLabel.length);
  if (fairLabel) {
    const fairStart = zoneScaleMarkerColumn(PARITY_RATIO, scaleWidth) - Math.floor(fairLabel.length / 2);
    const underEnd = underLabel.length;
    const overStart = scaleWidth - overLabel.length;
    if (fairStart >= underEnd + 1 && fairStart + fairLabel.length <= overStart - 1) {
      placeCaption(fairLabel, fairStart);
    }
  }

  const ticks = scaleWidth >= 40
    ? ZONE_SCALE_TICKS
    : ZONE_SCALE_TICKS.filter((tick) => tick === 0 || tick === PARITY_RATIO || tick === ZONE_SCALE_MAX);
  const tickCells: Array<{ char: string; color: string }> = Array.from(
    { length: scaleWidth },
    () => ({ char: " ", color: colors.textDim }),
  );
  for (const tick of ticks) {
    const label = tick === PARITY_RATIO ? "100" : String(tick);
    const center = zoneScaleMarkerColumn(tick, scaleWidth);
    const start = Math.max(0, Math.min(scaleWidth - label.length, center - Math.floor(label.length / 2)));
    for (let index = 0; index < label.length; index += 1) {
      tickCells[start + index] = {
        char: label[index]!,
        color: tick === PARITY_RATIO ? colors.textMuted : colors.textDim,
      };
    }
  }

  const chunkRow = (row: Array<{ char: string; color: string }>) => {
    const chunks: Array<{ text: string; color: string }> = [];
    for (const cell of row) {
      const last = chunks[chunks.length - 1];
      if (last && last.color === cell.color) last.text += cell.char;
      else chunks.push({ text: cell.char, color: cell.color });
    }
    return chunks;
  };
  const captionChunks = chunkRow(captionCells);
  const barChunks = chunkRow(cells);
  const tickChunks = chunkRow(tickCells);

  return (
    <Box flexDirection="column" width={scaleWidth} gap={0}>
      {underLabel || overLabel ? (
        <Box flexDirection="row" height={1} overflow="hidden">
          {captionChunks.map((chunk, index) => (
            <Text key={`caption:${index}`} fg={chunk.color}>{chunk.text}</Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="row" height={1} overflow="hidden">
        {barChunks.map((chunk, index) => (
          <Text key={`bar:${index}`} fg={chunk.color}>{chunk.text}</Text>
        ))}
      </Box>
      <Box flexDirection="row" height={1} overflow="hidden">
        {tickChunks.map((chunk, index) => (
          <Text key={`tick:${index}`} fg={chunk.color}>{chunk.text}</Text>
        ))}
      </Box>
    </Box>
  );
}
