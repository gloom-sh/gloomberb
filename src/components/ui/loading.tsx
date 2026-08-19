import { Box, SpinnerMark, Text } from "../../ui";
import { colors } from "../../theme/colors";
import { t } from "../../i18n";

export interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps) {
  return (
    <Box flexDirection="row" gap={1} data-gloom-status="loading">
      <SpinnerMark name="dots" color={colors.textDim} />
      {label && <Text fg={colors.textDim}>{t(label)}</Text>}
    </Box>
  );
}
