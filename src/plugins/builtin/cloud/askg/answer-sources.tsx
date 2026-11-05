import { LinkText } from "../../../../components";
import { useThemeColors } from "../../../../theme/theme-context";
import { Box, Text } from "../../../../ui";
import { truncateWithEllipsis } from "../../../../utils/text-wrap";
import { formatSourceCommand, type ASKGAnswerSource } from "./sources";
import { describeToolRow, type ToolDisplayContext } from "./tool-display";

/** What one source reads as: `[2] HP NVDA --range 6M`, or what was read when no pane shows it. */
export function answerSourceLabel(source: ASKGAnswerSource, context: ToolDisplayContext): string {
  const ref = source.ref === null ? "" : `[${source.ref}] `;
  if (source.target.kind === "pane") return `${ref}${formatSourceCommand(source.target.command)}`;
  if (!source.row) return `${ref}not found`;
  const view = describeToolRow(source.row, context);
  return `${ref}${[view.title, view.subject].filter(Boolean).join(" ")}, no pane`;
}

/**
 * The sources under an answer: each one it cites, as the function, ticker and
 * options that show it, opened by a click. A cited read that no pane shows,
 * or a number no read carries, is said as such and opens nothing; an answer
 * with figures that read no data says that instead.
 */
export function AnswerSources({
  sources,
  readNothing,
  width,
  context,
  onOpen,
}: {
  sources: readonly ASKGAnswerSource[];
  readNothing: boolean;
  width: number;
  context: ToolDisplayContext;
  onOpen: (source: ASKGAnswerSource) => void;
}) {
  const colors = useThemeColors();
  if (sources.length === 0) {
    return readNothing ? (
      <Box paddingTop={1}>
        <Text fg={colors.textMuted}>No sources: this answer read no data</Text>
      </Box>
    ) : null;
  }
  const room = Math.max(8, width - 2);
  return (
    <Box flexDirection="row" flexWrap="wrap" paddingTop={1}>
      <Text fg={colors.textMuted}>{"Sources  "}</Text>
      {sources.map((source, index) => {
        const label = truncateWithEllipsis(answerSourceLabel(source, context), room);
        return (
          <Box key={`${source.ref ?? "read"}:${index}`} flexDirection="row" marginRight={2}>
            {source.target.kind === "pane"
              ? <LinkText label={label} onPress={() => onOpen(source)} />
              : <Text fg={colors.textMuted}>{label}</Text>}
          </Box>
        );
      })}
    </Box>
  );
}
