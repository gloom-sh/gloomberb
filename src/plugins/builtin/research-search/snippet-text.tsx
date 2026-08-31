import { Box, Text, TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { SnippetSegment } from "./snippet";

/**
 * Renders one line of text where matched terms are styled instead of shown as
 * literal `<mark>` tags. Marked runs are foreground-only so a selected table row
 * keeps its own background.
 */
export function SnippetText({
  segments,
  color = colors.text,
  dimColor,
  backgroundColor,
}: {
  segments: readonly SnippetSegment[];
  color?: string;
  /** Overrides the unmatched-run color, e.g. to dim context around a match. */
  dimColor?: string;
  backgroundColor?: string;
}) {
  return (
    <Box flexDirection="row" height={1} overflow="hidden" backgroundColor={backgroundColor}>
      {segments.map((segment, index) => (
        <Text
          key={index}
          fg={segment.marked ? colors.warning : dimColor ?? color}
          attributes={segment.marked ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {segment.text}
        </Text>
      ))}
    </Box>
  );
}
