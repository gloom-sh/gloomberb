import { Box, Text, useUiCapabilities } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { tf } from "../../i18n";
import { displayWidth } from "../../utils/format";
import { ICON_GLYPHS, Icon } from "./icon";

/** The terminal's form of the mark: the clock and the delay, as the pane footer draws it (`◷15m`). */
function delayedMarkText(minutes: number): string {
  return `${ICON_GLYPHS.clock}${minutes}m`;
}

/** The delay the mark spells out after its clock: `15m`. */
function delayedMarkDelay(minutes: number): string {
  return `${minutes}m`;
}

/**
 * Cells the mark takes: `◷15m` in the terminal; on the desktop and the web the
 * clock icon and its gap (12px and 4px, three cells at the narrowest cell) and `15m`.
 */
export function delayedMarkWidth(minutes: number, nativePaneChrome: boolean): number {
  return nativePaneChrome ? 3 + displayWidth(delayedMarkDelay(minutes)) : displayWidth(delayedMarkText(minutes));
}

/**
 * The one mark for a price shown late, beside the price: what the pane
 * footer's clock is for a pane's data (`delayedFooterSegment`), for a price
 * outside a footer (the header's SPY, the status bar, a quote's headline).
 * It reads without hovering: a yellow clock and the delay (`15m`) in the dim
 * tone of the meta text around it on the desktop and the web, `◷15m` in the
 * terminal, with `15m delayed` in its tooltip. Callers decide when a price is
 * late with `freeQuoteDelayMinutes` (or `useFreeQuoteDelay`); it draws nothing else.
 */
export function DelayedMark({ minutes }: { minutes: number }) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const detail = tf("{delay} delayed", { delay: `${minutes}m` });
  if (!nativePaneChrome) {
    return <Text fg={colors.warning} flexShrink={0} selectable={false} aria-label={detail}>{delayedMarkText(minutes)}</Text>;
  }
  return (
    <Box
      role="img"
      aria-label={detail}
      title={detail}
      flexShrink={0}
      flexDirection="row"
      alignItems="center"
      data-gloom-role="delayed-mark"
      style={{ gap: "var(--gloom-space-xs)" }}
    >
      <Icon name="clock" color={colors.warning} />
      <Text fg={colors.textDim} selectable={false}>{delayedMarkDelay(minutes)}</Text>
    </Box>
  );
}
