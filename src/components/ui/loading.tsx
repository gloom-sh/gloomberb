import { t } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { Box, SpinnerMark, Text } from "../../ui";

export interface SpinnerProps {
  label?: string;
  /**
   * The spinner and its label in the text colour rather than dim: a line that
   * says what is happening now among text that is read (an answer coming
   * in), where a dim one would pass for the metadata around it.
   */
  emphasized?: boolean;
}

export function Spinner({ label, emphasized = false }: SpinnerProps) {
  const colors = useThemeColors();
  const color = emphasized ? colors.text : colors.textDim;
  return (
    <Box flexDirection="row" gap={1} data-gloom-status="loading" data-gloom-ui="spinner">
      <SpinnerMark name="dots" color={color} />
      {label && <Text fg={color} wrapText>{t(label)}</Text>}
    </Box>
  );
}
