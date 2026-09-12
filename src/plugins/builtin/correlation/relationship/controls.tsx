import { Box, Text } from "../../../../ui";
import { colors } from "../../../../theme/colors";

export function RelationshipMetricsTable({
  rows,
  width,
  height,
}: {
  rows: Array<{ label: string; value: string }>;
  width: number;
  height: number;
}) {
  const labelWidth = Math.min(8, Math.max(5, Math.floor(width * 0.45)));
  const valueWidth = Math.max(4, width - labelWidth - 1);
  return (
    <Box width={width} height={height} flexDirection="column" overflow="hidden">
      <Box height={1} flexDirection="row">
        <Text fg={colors.textDim}>{"Metric".padEnd(labelWidth)}</Text>
        <Text fg={colors.textDim}>{"Value".padStart(valueWidth + 1)}</Text>
      </Box>
      {rows.slice(0, Math.max(0, height - 1)).map((row) => (
        <Box key={row.label} height={1} flexDirection="row">
          <Text fg={colors.text}>{row.label.padEnd(labelWidth)}</Text>
          <Text fg={colors.textBright}>{row.value.padStart(valueWidth + 1)}</Text>
        </Box>
      ))}
    </Box>
  );
}
