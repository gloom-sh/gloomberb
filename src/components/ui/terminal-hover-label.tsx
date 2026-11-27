import { Box, Text } from "../../ui";
import { colors } from "../../theme/colors";
import { displayWidth, truncateToDisplayWidth } from "../../utils/format";

/** A hover label shorter than this (its padding and a letter with the ellipsis) is not drawn. */
const HOVER_LABEL_MIN_WIDTH = 4;

/**
 * Terminal: which side of the controls under the pointer their name goes and
 * its text with a space either side, given the free cells before and after
 * them in the row: after when it fits, else before, else on the roomier side
 * cut to fit, else nowhere. It never covers the controls, which keep the
 * pointer. The desktop names a control in its tooltip instead.
 */
export function terminalHoverLabelSide(
  label: string,
  { before, after }: { before: number; after: number },
): { side: "before" | "after"; text: string } | null {
  const text = ` ${label} `;
  const textWidth = displayWidth(text);
  if (textWidth <= after) return { side: "after", text };
  if (textWidth <= before) return { side: "before", text };
  const room = Math.max(after, before);
  if (room < HOVER_LABEL_MIN_WIDTH) return null;
  const cut = ` ${truncateToDisplayWidth(label, room - 2)} `;
  return { side: after >= before ? "after" : "before", text: cut };
}

/**
 * Terminal: the name of the control under the pointer, drawn over its own
 * row `left` cells from the left of the box that places it, in the tooltip
 * surface. Nothing in the row moves for it.
 */
export function TerminalHoverLabel({ text, left, role }: { text: string; left: number; role: string }) {
  return (
    <Box
      position="absolute"
      top={0}
      left={left}
      height={1}
      width={displayWidth(text)}
      zIndex={1}
      backgroundColor={colors.panel}
      data-gloom-role={role}
    >
      <Text fg={colors.textBright} selectable={false}>{text}</Text>
    </Box>
  );
}
