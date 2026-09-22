import { Box, Text, useUiHost } from "../../ui";

export interface DisclosureMarkerProps {
  expanded: boolean;
  /** Text color; the caller passes the color of the label the marker leads. */
  color: string;
  /**
   * Cells the marker occupies on the desktop. `ActionRow` gives it the two
   * cells between the row's edge and its label; a table cell gives it one.
   */
  width?: 1 | 2;
}

/**
 * The open/closed chevron in front of anything that expands. The terminal
 * draws a glyph; the desktop draws a path, because a rotated square does not
 * keep its ink inside the box it spins in, so the open one leant over whatever
 * the row started against and the two states never lined up with each other.
 */
export function DisclosureMarker({ expanded, color, width = 1 }: DisclosureMarkerProps) {
  const desktop = useUiHost().kind === "desktop-web";
  if (!desktop) return <Text fg={color}>{expanded ? "\u25be" : "\u25b8"}</Text>;
  return (
    <Box width={width} marginRight={width === 2 ? -1 : 0} style={{ flexShrink: 0, alignItems: "center", justifyContent: "center" }}>
      <Box width={1} style={{ flexShrink: 0 }}>
        <svg viewBox="0 0 12 12" width="100%" fill="none" aria-hidden="true" style={{ display: "block", aspectRatio: "1" }}>
          <path
            d={expanded ? "M2 4 6 8 10 4" : "M4 2 8 6 4 10"}
            stroke={color}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Box>
    </Box>
  );
}
