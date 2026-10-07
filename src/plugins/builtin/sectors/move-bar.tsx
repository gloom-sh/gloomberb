import { RatioBar } from "../../../components/ui/ratio-bar";
import { Text } from "../../../ui";
import { colors } from "../../../theme/colors";
import { moveBarRatio } from "./sector-model";

export interface SectorMoveBarProps {
  changePercent: number | null;
  width: number;
}

/** The session move as a length, not as a number that is already in the 1D column. */
export function SectorMoveBar({ changePercent, width }: SectorMoveBarProps) {
  if (changePercent == null || width <= 0) return <Text fg={colors.textDim}>{""}</Text>;
  return (
    <RatioBar
      ratio={moveBarRatio(changePercent)}
      width={width}
      color={changePercent >= 0 ? colors.positive : colors.negative}
    />
  );
}
