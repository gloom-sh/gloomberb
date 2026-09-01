import { Box, Text } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import { getTradeTonePalette, type TradeTone } from "./utils";

interface TradeBadgeProps {
  label: string;
  value: string;
  tone?: TradeTone;
  onPress?: () => void;
}

export function TradeBadge({ label, value, tone = "neutral", onPress }: TradeBadgeProps) {
  const palette = getTradeTonePalette(tone);

  return (
    <Box
      backgroundColor={palette.background}
      paddingX={1}
      marginRight={1}
      marginBottom={1}
      onMouseDown={onPress}
    >
      <Text fg={colors.textDim}>{label}</Text>
      <Text fg={palette.text} attributes={TextAttributes.BOLD}>{` ${value}`}</Text>
    </Box>
  );
}
