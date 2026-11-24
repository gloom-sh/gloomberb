import { Prose } from "../../../components";
import { Box, ScrollBox } from "../../../ui";
import { colors } from "../../../theme/colors";
import { wrapTextLines } from "../../../utils/text-wrap";
import { optionMarketReferenceLines, type OptionMarketReference } from "./market-reference";

/** The reference's lines, marked a snapshot when it is one, then any notes on how it is valued. */
function quoteContextLines(reference: OptionMarketReference | undefined, snapshot: boolean, notes: readonly string[]): string[] {
  const lines = reference ? optionMarketReferenceLines(reference).map((line, index) => snapshot && index === 0 ? `Snapshot: ${line}` : line) : [];
  return [...lines, ...notes];
}

export function optionQuoteContextHeight(reference: OptionMarketReference | undefined, width: number, maximum: number, snapshot = false,
  notes: readonly string[] = []): number {
  const lines = quoteContextLines(reference, snapshot, notes);
  return lines.length ? Math.min(Math.max(1, maximum), lines
    .reduce((height, line) => height + wrapTextLines(line, Math.max(8, width)).length, 0)) : 0;
}

/**
 * Shared source context for the selected chain contract and its calculator
 * snapshot, with any notes on how the calculator values it (from when, and
 * why its IV differs from the chain's).
 */
export function OptionQuoteContext({ reference, width, height, snapshot = false, scrollable = true, notes = [] }: {
  reference?: OptionMarketReference;
  width: number;
  height: number;
  snapshot?: boolean;
  /** A parent scrolling the full result body can own overflow instead. */
  scrollable?: boolean;
  notes?: readonly string[];
}) {
  const content = <Box flexDirection="column">
    {quoteContextLines(reference, snapshot, notes).map((line, index) => (
      <Prose key={index} text={line} width={Math.max(8, width)} color={colors.textDim} />
    ))}
  </Box>;
  return scrollable
    ? <ScrollBox key={JSON.stringify(reference)} height={height} flexShrink={0} scrollY focusable={false}>{content}</ScrollBox>
    : content;
}
