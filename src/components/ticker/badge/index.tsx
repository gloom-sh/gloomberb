import { Box, Text, useTickerContextMenu, useUiCapabilities } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { colors, priceColor } from "../../../theme/colors";
import { getSharedRegistry } from "../../../plugins/registry";
import type { Quote } from "../../../types/financials";
import { useInlineTickerQuote, type InlineTickerCatalogEntry } from "../../../state/hooks/inline-tickers";
import { getTickerBadgeHoverText, getTickerBadgeText, tickerBadgeColors, type TickerBadgeStatus } from "./format";
import { displayWidth, padTo } from "../../../utils/format";
import { tf } from "../../../i18n";
import { usePaneLinkMenuEntry } from "../../ui/external-link";

export interface TickerBadgeProps {
  symbol: string;
  status: TickerBadgeStatus;
  quote: Quote | null;
  liveQuote?: boolean;
  hovered?: boolean;
  /** Text budget for the chip, so a narrow column drops the price, not the badge. */
  maxTextWidth?: number;
  /** Trailing gap to the next chip, which the last chip in a row does not need. */
  trailingGap?: boolean;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
  onOpen: (symbol: string) => void;
}

/** The one chip (display.tsx Badge): 16px in an 18px row, the small-mark radius. */
const NATIVE_CHIP_STYLE = { height: "calc(100% - 2px)", borderRadius: "var(--gloom-radius-sm)", position: "relative" };
/**
 * Desktop and web: under the pointer the resting text stays in the flow,
 * unseen, and the price is laid over it. The chip keeps the width its resting
 * text gives it, whatever the font draws the price with, and the pointer stays
 * over the same element, so nothing re-lays out and hover does not flicker.
 */
const NATIVE_RESTING_TEXT_UNDER_PRICE = { color: "transparent" };
const NATIVE_PRICE_OVER_RESTING_TEXT = { position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" };

export function TickerBadge({
  symbol,
  status,
  quote,
  liveQuote = true,
  hovered = false,
  maxTextWidth,
  trailingGap = true,
  onHoverStart,
  onHoverEnd,
  onOpen,
}: TickerBadgeProps) {
  const registry = getSharedRegistry();
  const { nativeContextMenu, nativePaneChrome } = useUiCapabilities();
  const ticker = typeof registry?.getTicker === "function" ? registry.getTicker(symbol) : null;
  const financials = typeof registry?.getData === "function" ? registry.getData(symbol) : null;
  const openTickerContextMenu = useTickerContextMenu({
    ticker,
    financials,
    onOpen,
  });
  const quoteForDisplay = liveQuote ? quote : null;
  const tone = status === "ready" && quoteForDisplay
    ? priceColor(quoteForDisplay.changePercent)
    : colors.borderFocused;
  const text = getTickerBadgeText({ symbol, status, quote, liveQuote, maxTextWidth });
  const price = hovered ? getTickerBadgeHoverText({ symbol, status, quote, liveQuote, maxTextWidth }) : null;
  const { fg: color, bg: backgroundColor } = tickerBadgeColors(tone, hovered);
  // An ambiguous symbol is worth opening: that is how the listing gets picked.
  const interactive = status !== "loading";
  usePaneLinkMenuEntry(interactive ? `ticker:${symbol}` : null, tf("Open {ticker}", { ticker: symbol }), () => onOpen(symbol));

  return (
    <Box paddingRight={trailingGap ? 1 : 0} flexShrink={0} justifyContent={nativePaneChrome ? "center" : undefined}>
      <Box
        paddingX={1}
        backgroundColor={backgroundColor}
        // A chip as tall as its row runs into the one below in a column of
        // badges; the desktop leaves a hairline of row above and below.
        justifyContent={nativePaneChrome ? "center" : undefined}
        style={nativePaneChrome ? NATIVE_CHIP_STYLE : undefined}
        role="button"
        aria-label={symbol}
        data-gloom-context-menu-surface="true"
        onMouseOver={() => {
          onHoverStart?.();
        }}
        onMouseOut={() => {
          onHoverEnd?.();
        }}
        onMouseDown={(event: any) => {
          if (event.button === 2) {
            if (nativeContextMenu !== true) {
              void openTickerContextMenu(event);
            }
            return;
          }
          event.stopPropagation?.();
          event.preventDefault?.();
          if (!interactive) return;
          onOpen(symbol);
        }}
        onContextMenu={(event: any) => {
          void openTickerContextMenu(event);
        }}
      >
        {nativePaneChrome ? (
          <>
            <Text fg={color} attributes={TextAttributes.BOLD} style={price ? NATIVE_RESTING_TEXT_UNDER_PRICE : undefined}>
              {text}
            </Text>
            {price ? (
              <Box flexDirection="row" justifyContent="center" alignItems="center" style={NATIVE_PRICE_OVER_RESTING_TEXT}>
                <Text fg={color} attributes={TextAttributes.BOLD}>{price}</Text>
              </Box>
            ) : null}
          </>
        ) : (
          // Cells are exact: the price, centred in the resting text's cells, takes as many.
          <Text fg={color} attributes={TextAttributes.BOLD}>
            {price ? padTo(price, displayWidth(text), "center") : text}
          </Text>
        )}
      </Box>
    </Box>
  );
}

export interface InlineTickerBadgeProps extends Omit<TickerBadgeProps, "status" | "quote"> {
  entry: InlineTickerCatalogEntry;
}

function inlineBadgeStatus(entry: InlineTickerCatalogEntry): TickerBadgeStatus {
  if (entry.status === "ambiguous" || entry.status === "loading") return entry.status;
  return "ready";
}

/**
 * The badge for one catalog entry in running text. A catalog built with
 * `badgeQuotes` leaves the price to this badge, which follows its own symbol's
 * quote, so a tick re-renders the chip instead of the message or document
 * around it.
 */
export function InlineTickerBadge({ entry, ...props }: InlineTickerBadgeProps) {
  const liveQuote = useInlineTickerQuote(entry.liveBadge ? props.symbol : null, entry.ticker);
  return <TickerBadge {...props} status={inlineBadgeStatus(entry)} quote={liveQuote ?? entry.quote} />;
}
