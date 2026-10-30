import { Box, Text, useUiCapabilities } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { tf } from "../../i18n";
import { displayWidth } from "../../utils/format";
import { ICON_GLYPHS, Icon } from "./icon";

/** The terminal's form of the mark: the clock and the delay, as the pane footer draws it (`◷15m`). */
function delayedMarkText(minutes: number): string {
  return `${ICON_GLYPHS.clock}${minutes}m`;
}

/** Cells the mark takes: `◷15m` in the terminal, the clock icon (12px, two cells) on the desktop and the web. */
export function delayedMarkWidth(minutes: number, nativePaneChrome: boolean): number {
  return nativePaneChrome ? 2 : displayWidth(delayedMarkText(minutes));
}

/**
 * The one mark for a price shown late, beside the price: what the pane
 * footer's clock is for a pane's data (`delayedFooterSegment`), for a price
 * outside a footer (the header's SPY, the status bar, a quote's headline).
 * A yellow clock with the delay in its tooltip on the desktop and the web,
 * `◷15m` in the terminal. Callers decide when a price is late with
 * `freeQuoteDelayMinutes` (or `useFreeQuoteDelay`); it draws nothing else.
 */
export function DelayedMark({ minutes }: { minutes: number }) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const detail = tf("{delay} delayed", { delay: `${minutes}m` });
  if (!nativePaneChrome) {
    return <Text fg={colors.warning} flexShrink={0} selectable={false} aria-label={detail}>{delayedMarkText(minutes)}</Text>;
  }
  return (
    <Box role="img" aria-label={detail} title={detail} flexShrink={0} data-gloom-role="delayed-mark">
      <Icon name="clock" color={colors.warning} />
    </Box>
  );
}
