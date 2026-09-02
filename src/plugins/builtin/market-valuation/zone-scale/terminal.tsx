import { Box, Text } from "../../../../ui";
import { colors } from "../../../../theme/colors";
import { zoneScaleColumnValue } from "../defs";
import { zoneScaleGeometry, type ZoneScaleProps } from "./model";

interface Cell {
  char: string;
  color: string;
}

function chunkRow(row: readonly Cell[]): Array<{ text: string; color: string }> {
  const chunks: Array<{ text: string; color: string }> = [];
  for (const cell of row) {
    const last = chunks[chunks.length - 1];
    if (last && last.color === cell.color) last.text += cell.char;
    else chunks.push({ text: cell.char, color: cell.color });
  }
  return chunks;
}

function blankRow(width: number): Cell[] {
  return Array.from({ length: width }, () => ({ char: " ", color: colors.textDim }));
}

function placeText(row: Cell[], label: string, start: number, color: string): void {
  for (let index = 0; index < label.length; index += 1) {
    const column = start + index;
    if (column < 0 || column >= row.length) continue;
    row[column] = { char: label[index]!, color };
  }
}

export function TerminalZoneColorScale({ indicator, value, width, markerColor }: ZoneScaleProps) {
  const scaleWidth = Math.max(12, width);
  const geometry = zoneScaleGeometry(indicator, value, scaleWidth);
  const marker = Math.round(geometry.markerFraction * (scaleWidth - 1));

  const bar: Cell[] = [];
  for (let column = 0; column < scaleWidth; column += 1) {
    const columnValue = zoneScaleColumnValue(indicator, column, scaleWidth);
    const band = geometry.bands.find((entry) => columnValue >= entry.from && columnValue < entry.to)
      ?? geometry.bands[geometry.bands.length - 1]!;
    bar.push({
      char: column === marker ? "●" : "━",
      color: column === marker ? markerColor : band.color,
    });
  }

  const captions = blankRow(scaleWidth);
  if (geometry.underLabel) placeText(captions, geometry.underLabel, 0, colors.textDim);
  if (geometry.overLabel) {
    placeText(captions, geometry.overLabel, scaleWidth - geometry.overLabel.length, colors.textDim);
  }
  const fairBand = geometry.bands.find((band) => band.id === "fair");
  if (geometry.fairLabel && fairBand) {
    const center = Math.round(
      ((fairBand.startFraction + fairBand.endFraction) / 2) * (scaleWidth - 1),
    );
    const start = center - Math.floor((geometry.fairLabel.length - 1) / 2);
    const overStart = scaleWidth - geometry.overLabel.length;
    if (start >= geometry.underLabel.length + 1 && start + geometry.fairLabel.length <= overStart - 1) {
      placeText(captions, geometry.fairLabel, start, colors.textDim);
    }
  }

  const ticks = blankRow(scaleWidth);
  for (const tick of geometry.ticks) {
    const center = Math.round(tick.fraction * (scaleWidth - 1));
    const start = Math.max(
      0,
      Math.min(scaleWidth - tick.label.length, center - Math.floor((tick.label.length - 1) / 2)),
    );
    const isReference = indicator.reference != null
      && tick.label === indicator.formatValue(indicator.reference.value);
    placeText(ticks, tick.label, start, isReference ? colors.textMuted : colors.textDim);
  }

  const rows: Array<{ id: string; cells: Cell[] }> = [];
  if (geometry.underLabel || geometry.overLabel) rows.push({ id: "caption", cells: captions });
  rows.push({ id: "bar", cells: bar });
  rows.push({ id: "tick", cells: ticks });

  return (
    <Box flexDirection="column" width={scaleWidth} gap={0}>
      {rows.map((row) => (
        <Box key={row.id} flexDirection="row" height={1} overflow="hidden">
          {chunkRow(row.cells).map((chunk, index) => (
            <Text key={`${row.id}:${index}`} fg={chunk.color}>{chunk.text}</Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}
