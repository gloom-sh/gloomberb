import type { CSSProperties, ReactNode } from "react";
import { Box, Text, TextAttributes } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";

/**
 * Each line's height, in its own type: room for the font's ascent and descent,
 * so a line's letters sit inside its box in every engine, without relying on
 * `text-box` trimming (WebKit before 18.2 ignores it). Half of the space
 * above and below the letters also separates the name from the line under it.
 */
const LINE_HEIGHT = 1.2;

/** Room above and below a line for accents and descenders that reach past it. */
const INK_ROOM = "0.3em";

/**
 * The line clips for the ellipsis, and WebKit clips both ways whatever the
 * other axis says, so the clip box reaches past the line by padding, and an
 * equal negative margin keeps the line where it was.
 */
const LINE_STYLE = {
  display: "block",
  minWidth: 0,
  maxWidth: "100%",
  lineHeight: LINE_HEIGHT,
  overflow: "hidden",
  paddingBlock: INK_ROOM,
  marginBlock: `calc(-1 * ${INK_ROOM})`,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as CSSProperties;

/**
 * The art beside the two lines (a `LogoMark` of size `lead`) is a square
 * exactly as tall as the two lines, in their type, so the name and the line
 * under it always sit within its height, the block centred on it.
 */
const LEADING_STYLE: CSSProperties = {
  flexShrink: 0,
  fontSize: "var(--gloom-type-ui)",
  width: `${2 * LINE_HEIGHT}em`,
  height: `${2 * LINE_HEIGHT}em`,
};

export interface ListRowLinesProps {
  label: string;
  /** The muted line under the label, such as how a broker connects. */
  description?: string;
  /** Art before the lines, such as a broker's logo. Decoration: hidden from assistive technology. */
  leading?: ReactNode;
  /** The label's colour; the theme's text colour by default. */
  labelColor?: string;
  /** The label in bold, as a selected row's. */
  labelBold?: boolean;
}

/**
 * A desktop and web list row's name with one muted line under it, and its
 * logo before them, the block centred in the row. Every two-line row with
 * art uses it (`ListView`'s `rowDescriptions`, the first-run guide's list),
 * so the lines sit on the logo the same way everywhere.
 */
export function ListRowLines({ label, description, leading, labelColor, labelBold = false }: ListRowLinesProps) {
  const colors = useThemeColors();
  return (
    <Box
      flexDirection="row"
      alignItems="center"
      minWidth={0}
      flexShrink={1}
      data-gloom-role="list-row-lines"
      style={{ gap: "var(--gloom-space-sm)", fontSize: "var(--gloom-type-ui)" }}
    >
      {leading !== undefined && (
        <Box aria-hidden="true" data-gloom-role="list-row-leading" style={LEADING_STYLE}>
          {leading}
        </Box>
      )}
      <Box flexDirection="column" minWidth={0} flexShrink={1}>
        <Text fg={labelColor ?? colors.text} attributes={labelBold ? TextAttributes.BOLD : 0} style={LINE_STYLE}>
          {label}
        </Text>
        {description ? <Text fg={colors.textMuted} style={LINE_STYLE}>{description}</Text> : null}
      </Box>
    </Box>
  );
}
