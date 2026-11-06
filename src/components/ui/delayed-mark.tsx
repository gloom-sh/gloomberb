import { useEffect, useSyncExternalStore } from "react";
import { Box, Text, useUiCapabilities } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { tf } from "../../i18n";
import { displayWidth } from "../../utils/format";
import { useFreeQuoteDelay, type QuoteDelayFacts } from "../../api-client/plan-access";
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
 * How many status bar notes say, for the whole app, that this account's
 * prices are late. Counted rather than flagged so a note leaving as another
 * arrives never clears it.
 */
let statedCount = 0;
const statedListeners = new Set<() => void>();

function subscribeStated(listener: () => void): () => void {
  statedListeners.add(listener);
  return () => {
    statedListeners.delete(listener);
  };
}

function quoteDelayStated(): boolean {
  return statedCount > 0;
}

/**
 * For the status bar's delayed note: while `stating`, the app's prices are
 * said to be late once for the whole screen, so a price outside a pane
 * footer leaves its own mark out (`useDelayedMarkMinutes`).
 */
export function useStateQuoteDelay(stating: boolean): void {
  useEffect(() => {
    if (!stating) return;
    statedCount += 1;
    for (const listener of statedListeners) listener();
    return () => {
      statedCount -= 1;
      for (const listener of statedListeners) listener();
    };
  }, [stating]);
}

/**
 * The delay to mark beside a price shown outside a pane footer (a quote's
 * headline; not the header's market, which never carries it): this account's
 * (`useFreeQuoteDelay`) while
 * nothing else on screen says it, null while the price is live or the status
 * bar's delayed note says it for the whole app. The delay is said once per
 * screen: with the status bar hidden (presentation mode, `SB`), or in a
 * capture of the pane alone, the price carries the mark itself.
 */
export function useDelayedMarkMinutes(quote: QuoteDelayFacts | null | undefined): number | null {
  const minutes = useFreeQuoteDelay(quote);
  const stated = useSyncExternalStore(subscribeStated, quoteDelayStated, quoteDelayStated);
  return stated ? null : minutes;
}

/**
 * The one mark for a price shown late: what the pane footer's clock is for a
 * pane's data (`delayedFooterSegment`), for the status bar's delayed note and
 * for a price outside a footer where nothing else on screen says the delay
 * (`useDelayedMarkMinutes`). It reads without hovering: a yellow clock and the
 * delay (`15m`) in the dim tone of the meta text around it on the desktop and
 * the web, `◷15m` in the terminal, with `15m delayed` in its tooltip. It draws
 * nothing else.
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
