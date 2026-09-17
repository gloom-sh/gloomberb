import { useMemo, useState } from "react";
import { Box, Text, TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import { useInlineTickers, type InlineTickerCatalogEntry } from "../../../state/hooks/inline-tickers";
import { displayWidth } from "../../../utils/format";
import { TickerBadge } from "./index";
import { getTickerBadgeText, type TickerBadgeStatus } from "./format";

/**
 * Rows scroll under the cursor, so a badge only starts resolving once its row
 * has settled in the visible range.
 */
const BADGE_LIST_SETTLE_MS = 180;
/** Padding inside a chip; the gap to the next chip is added per badge below. */
const BADGE_PADDING = 2;
/** The shortest a change can print: a space and something like `0%`. */
const MIN_CHANGE_WIDTH = 3;

export interface TickerBadgeListProps {
  symbols: readonly string[];
  width: number;
  fallbackColor?: string;
  liveQuote?: boolean;
}

function badgeStatus(entry: InlineTickerCatalogEntry | undefined): TickerBadgeStatus {
  if (entry?.status === "ambiguous") return "ambiguous";
  if (entry?.status === "loading") return "loading";
  return "ready";
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
  /**
   * Quotes are only worth fetching where they can be read. A column with no
   * room left after its symbols would subscribe to a live price and then print
   * the symbol anyway, so it stays a static badge instead.
   */
  const chrome = useMemo(
    () => named.map((_symbol, index) => BADGE_PADDING + (index < named.length - 1 ? 1 : 0)),
    [named],
  );
  const slack = useMemo(
    () => width - named.reduce(
      (total, symbol, index) => total + displayWidth(symbol) + chrome[index]!,
      0,
    ),
    [chrome, named, width],
  );
  const liveQuotes = liveQuote && slack >= MIN_CHANGE_WIDTH;
  const { catalog, openTicker } = useInlineTickers(tickerTexts, {
    liveQuotes,
    settleMs: BADGE_LIST_SETTLE_MS,
  });

  /**
   * Every symbol keeps its chip; only the spare columns buy prices. The budget
   * is spent left to right, so the first badges in a cell show their change and
   * the ones that would overflow quietly shrink back to the symbol.
   */
  const budgets = useMemo(() => {
    let remaining = slack;
    return named.map((symbol) => {
      const base = displayWidth(symbol);
      const budget = base + Math.max(0, remaining);
      const chosen = getTickerBadgeText({
        symbol,
        status: badgeStatus(catalog[symbol]),
        quote: catalog[symbol]?.quote ?? null,
        liveQuote: liveQuotes,
        hovered: hoveredSymbol === symbol,
        maxTextWidth: budget,
      });
      remaining -= displayWidth(chosen) - base;
      return budget;
    });
  }, [catalog, hoveredSymbol, liveQuotes, named, slack]);

  return (
    <Box flexDirection="row" width={width} height={1} overflow="hidden">
      {named.map((symbol, index) => {
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
            status={badgeStatus(entry)}
            quote={liveQuotes ? entry?.quote ?? null : null}
            liveQuote={liveQuotes}
            maxTextWidth={budgets[index]}
            trailingGap={index < named.length - 1}
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
