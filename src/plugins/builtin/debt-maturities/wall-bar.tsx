import { RatioBar } from "../../../components/ui/ratio-bar";
import { Box, Text } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { BucketBar } from "./model";

const CAP = "▸";

/** Cells a capped bar keeps after its end for the cap. */
export const WALL_CAP_RESERVE = 2;

/**
 * One maturity bucket of the wall, inline in its table row. Dated buckets
 * share one scale; a bucket past it (Thereafter, open ended) runs to the end,
 * capped, so its length is never read as a measure; its PRINCIPAL cell says
 * how much.
 */
export function WallBar({ bar, width, reserve, selected }: {
  bar: BucketBar | null;
  width: number;
  /** Cells kept clear at the end so a capped bar outruns every dated one. */
  reserve: number;
  selected: boolean;
}) {
  if (!bar || width <= 0) return <Text fg={colors.textDim}>{""}</Text>;
  return (
    <Box width={width} flexDirection="row" alignItems="center" overflow="hidden">
      <RatioBar
        ratio={bar.capped ? 1 : bar.ratio}
        width={Math.max(1, width - reserve)}
        color={colors.warning}
        resolution="eighth"
      />
      {bar.capped ? <Text fg={selected ? colors.selectedText : colors.text}>{` ${CAP}`}</Text> : null}
    </Box>
  );
}
