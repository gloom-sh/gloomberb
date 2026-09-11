import { Prose } from "../../../components";
import { Box, ScrollBox } from "../../../ui";
import { colors } from "../../../theme/colors";
import { wrapTextLines } from "../../../utils/text-wrap";
import { optionMarketReferenceLines, type OptionMarketReference } from "./market-reference";

export function optionQuoteContextHeight(reference: OptionMarketReference | undefined, width: number, maximum: number): number {
  return reference ? Math.min(Math.max(1, maximum), optionMarketReferenceLines(reference)
    .reduce((height, line) => height + wrapTextLines(line, Math.max(8, width)).length, 0)) : 0;
}

/** Shared source context for the selected chain contract and its calculator snapshot. */
export function OptionQuoteContext({ reference, width, height, snapshot = false }: {
  reference: OptionMarketReference;
  width: number;
  height: number;
  snapshot?: boolean;
}) {
  return <ScrollBox key={JSON.stringify(reference)} height={height} flexShrink={0} scrollY focusable={false}>
    <Box flexDirection="column">
      {optionMarketReferenceLines(reference).map((line, index) => (
        <Prose key={index} text={snapshot && index === 0 ? `Snapshot: ${line}` : line} width={Math.max(8, width)} color={colors.textDim} />
      ))}
    </Box>
  </ScrollBox>;
}
