import { RangeTrack } from "../../../components/ui/range-track";
import { useThemeColors } from "../../../theme/theme-context";
import { Text } from "../../../ui";

/**
 * The value's place in its five-year range (`position` 0 to 100): the low at
 * the left, the high at the right, an amber arrow past an end when the value
 * is outside it.
 */
export function DoeRangeBar({ position, width }: { position: number | null; width: number }) {
  const colors = useThemeColors();
  if (position == null || width < 3) return <Text fg={colors.textDim}>{""}</Text>;
  const outside = position < 0 || position > 100;
  return <RangeTrack position={position / 100} width={Math.max(3, width - 1)} markerColor={outside ? colors.warning : colors.textBright} outside />;
}
