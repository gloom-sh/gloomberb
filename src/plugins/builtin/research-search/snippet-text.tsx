import { Box, Span, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { colors } from "../../../theme/colors";
import { NATIVE_CLIP_STYLE } from "../../../components/ui/clip-style";
import { truncateSegments, type SnippetSegment } from "./snippet";

/** One run of text, so CSS ends the line in one ellipsis however many marked runs it holds. */
const LINE_STYLE = { ...NATIVE_CLIP_STYLE, flex: "0 1 auto" } as const;
const INLINE_STYLE = { display: "inline" } as const;

/**
 * Renders one line of text where matched terms are styled instead of shown as
 * literal `<mark>` tags. Marked runs are foreground-only so a selected table row
 * keeps its own background. With a `width`, a line too long for it ends in an
 * ellipsis: in the terminal at that many cells, on the desktop and the web by
 * CSS where its box ends.
 */
export function SnippetText({
  segments,
  width,
  color = colors.text,
  dimColor,
  backgroundColor,
}: {
  segments: readonly SnippetSegment[];
  /** The terminal's cells for the line. */
  width?: number;
  color?: string;
  /** Overrides the unmatched-run color, e.g. to dim context around a match. */
  dimColor?: string;
  backgroundColor?: string;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  if (nativePaneChrome) {
    return (
      <Box flexDirection="row" height={1} overflow="hidden" backgroundColor={backgroundColor}>
        <Text fg={dimColor ?? color} style={LINE_STYLE}>
          {segments.map((segment, index) => (
            <Span
              key={index}
              fg={segment.marked ? colors.warning : dimColor ?? color}
              attributes={segment.marked ? TextAttributes.BOLD : TextAttributes.NONE}
              style={INLINE_STYLE}
            >
              {segment.text}
            </Span>
          ))}
        </Text>
      </Box>
    );
  }
  const shown = width === undefined ? segments : truncateSegments([...segments], width);
  return (
    <Box flexDirection="row" height={1} overflow="hidden" backgroundColor={backgroundColor}>
      {shown.map((segment, index) => (
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
