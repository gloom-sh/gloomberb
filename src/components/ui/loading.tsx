import { t } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { Box, SpinnerMark, Text } from "../../ui";

export interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row" gap={1} data-gloom-status="loading" data-gloom-ui="spinner">
      <SpinnerMark name="dots" color={colors.textDim} />
      {label && <Text fg={colors.textDim} wrapText>{t(label)}</Text>}
    </Box>
  );
}
