import { t } from "../../i18n";
import { useThemeTokens } from "../../theme/theme-context";
import { Box, SpinnerMark, Text } from "../../ui";

export interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps) {
  const tokens = useThemeTokens();
  return (
    <Box flexDirection="row" gap={1} data-gloom-status="loading" data-gloom-ui="spinner">
      <SpinnerMark name="dots" color={tokens.text.dim} />
      {label && <Text fg={tokens.text.dim} wrapText>{t(label)}</Text>}
    </Box>
  );
}
