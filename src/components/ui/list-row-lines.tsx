import type { CSSProperties, ReactNode } from "react";
import { Box, Text, TextAttributes } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";

/** Between a two-line row's name and the line under it, from the name's baseline to the next line's capitals. */
const LINE_GAP = "var(--gloom-space-sm)";

/** Room above the capitals and below the baseline for ascenders, accents and descenders. */
const INK_ROOM = "0.3em";

/**
 * Each line's box runs from its capitals to its baseline, so the block's top
 * and bottom are where its letters start and sit. The line clips for the
 * ellipsis, and WebKit clips both ways whatever the other axis says, so the
 * clip box reaches past the capitals and the baseline by padding, and an equal
 * negative margin keeps the line where it was: ascenders and descenders draw
 * uncut, and the row does not move.
 */
const LINE_STYLE = {
  display: "block",
  minWidth: 0,
  maxWidth: "100%",
  lineHeight: 1,
  textBox: "trim-both cap alphabetic",
  overflow: "hidden",
  paddingBlock: INK_ROOM,
  marginBlock: `calc(-1 * ${INK_ROOM})`,
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as CSSProperties;

/**
 * The art beside the two lines (a `LogoMark` of size `lead`) is a square as
 * tall as they are: two capitals and the gap, in the lines' own type, so its
 * top and bottom edges line up with the name's capitals and the baseline of
 * the line under it.
 */
const LEADING_STYLE: CSSProperties = {
  flexShrink: 0,
  fontSize: "var(--gloom-type-ui)",
  width: `calc(2cap + ${LINE_GAP})`,
  height: `calc(2cap + ${LINE_GAP})`,
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
      <Box flexDirection="column" minWidth={0} flexShrink={1} style={{ gap: LINE_GAP }}>
        <Text fg={labelColor ?? colors.text} attributes={labelBold ? TextAttributes.BOLD : 0} style={LINE_STYLE}>
          {label}
        </Text>
        {description ? <Text fg={colors.textMuted} style={LINE_STYLE}>{description}</Text> : null}
      </Box>
    </Box>
  );
}
