import { useMemo, useState } from "react";
import { Box, Text, TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import { useInlineTickers } from "../../../state/hooks/inline-tickers";
import { TickerBadge } from "./index";

export interface TickerBadgeListProps {
  symbols: readonly string[];
  width: number;
  fallbackColor?: string;
  liveQuote?: boolean;
}

export function TickerBadgeList({
  symbols,
  width,
  fallbackColor = colors.textBright,
  liveQuote = true,
}: TickerBadgeListProps) {
  const [hoveredSymbol, setHoveredSymbol] = useState<string | null>(null);
  /**
   * A blank symbol names nothing, and a badge is a filled chip: drawing one for
   * it puts an empty block where a reader expects a ticker, which looks like a
   * name that failed to load rather than like a row that simply has no ticker.
   * Filtered here so no caller has to remember that a row's ticker is optional —
   * and typed loosely on purpose, because upstream rows do carry a null through
   * a `string[]` in practice.
   */
  const named = useMemo(
    () => symbols.filter((symbol): symbol is string => (
      typeof symbol === "string" && symbol.trim().length > 0
    )),
    [symbols],
  );
  const tickerTexts = useMemo(
    () => named.map((symbol) => `$${symbol}`),
    [named],
  );
  const { catalog, openTicker } = useInlineTickers(tickerTexts, { liveQuotes: liveQuote });

  return (
    <Box flexDirection="row" width={width} height={1} overflow="hidden">
      {named.map((symbol) => {
        const entry = catalog[symbol];
        if (entry?.status === "missing") {
          return (
            <Box key={symbol} paddingRight={1} flexShrink={0}>
              <Text fg={fallbackColor} attributes={TextAttributes.BOLD}>{symbol}</Text>
            </Box>
          );
        }

        return (
          <TickerBadge
            key={symbol}
            symbol={symbol}
            status="ready"
            quote={liveQuote ? entry?.quote ?? null : null}
            liveQuote={liveQuote}
            hovered={hoveredSymbol === symbol}
            onHoverStart={() => setHoveredSymbol(symbol)}
            onHoverEnd={() => {
              setHoveredSymbol((current) => (current === symbol ? null : current));
            }}
            onOpen={openTicker}
          />
        );
      })}
    </Box>
  );
}
