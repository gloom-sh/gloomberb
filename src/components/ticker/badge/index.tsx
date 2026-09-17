import { Box, Text, useTickerContextMenu, useUiCapabilities } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { blendHex, colors, priceColor } from "../../../theme/colors";
import { getSharedRegistry } from "../../../plugins/registry";
import type { Quote } from "../../../types/financials";
import { getTickerBadgeText, type TickerBadgeStatus } from "./format";

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
  const { nativeContextMenu } = useUiCapabilities();
  const ticker = typeof registry?.getTickerFn === "function" ? registry.getTickerFn(symbol) : null;
  const financials = typeof registry?.getDataFn === "function" ? registry.getDataFn(symbol) : null;
  const openTickerContextMenu = useTickerContextMenu({
    ticker,
    financials,
    onOpen,
  });
  const quoteForDisplay = liveQuote ? quote : null;
  const tone = status === "ready" && quoteForDisplay
    ? priceColor(quoteForDisplay.changePercent)
    : colors.borderFocused;
  const text = getTickerBadgeText({ symbol, status, quote, liveQuote, hovered, maxTextWidth });
  const color = hovered ? colors.textBright : tone;
  const backgroundColor = hovered
    ? blendHex(colors.bg, tone, 0.42)
    : blendHex(colors.bg, tone, 0.18);
  // An ambiguous symbol is worth opening: that is how the listing gets picked.
  const interactive = status !== "loading";

  return (
    <Box paddingRight={trailingGap ? 1 : 0} flexShrink={0}>
      <Box
        paddingX={1}
        backgroundColor={backgroundColor}
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
        <Text fg={color} attributes={TextAttributes.BOLD}>
          {text}
        </Text>
      </Box>
    </Box>
  );
}
