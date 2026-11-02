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
  /**
   * The source names these as listed tickers (an SEC filer's ticker, the
   * pane's own symbol): each is drawn as a badge as it is, with no lookup
   * and no quote. A lookup that fails prints a symbol as plain text, so a
   * column of looked-up symbols can mix chips and bare words.
   */
  listed?: boolean;
  /**
   * The listing a symbol stands for when its own spelling names none: a
   * number-only Asian listing (`2330`) reads as money, so the source's venue
   * makes it `2330:TWSE`. The chip keeps the symbol as written and looks up,
   * prices and opens the listing, as it does for any other ticker. `null`
   * says the source names no listing the app can read: that symbol prints as
   * plain text, as one whose lookup fails does, never as a chip of another
   * look beside resolved ones. Symbols not listed here stand for themselves.
   */
  listings?: Readonly<Record<string, string | null>>;
  /** Opens a badge; by default the symbol is resolved and opened as a ticker link would be. */
  onOpen?: (symbol: string) => void;
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
  listed = false,
  listings,
  onOpen,
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
  /** What a symbol is looked up and opened by: its listing, else itself. */
  const keyOf = (symbol: string): string => listings?.[symbol] ?? symbol;
  const tickerTexts = useMemo(
    () => (listed ? [] : named.filter((symbol) => listings?.[symbol] !== null).map((symbol) => `$${listings?.[symbol] ?? symbol}`)),
    [listed, listings, named],
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
  const liveQuotes = liveQuote && !listed && slack >= MIN_CHANGE_WIDTH;
  const { catalog, openTicker } = useInlineTickers(tickerTexts, {
    liveQuotes,
    settleMs: BADGE_LIST_SETTLE_MS,
  });

  /**
   * Every symbol keeps its chip; only the spare columns buy prices. The budget
   * is spent left to right, so the first badges in a cell show their change and
   * the ones that would overflow quietly shrink back to the symbol. It is spent
   * on resting text only: a hovered chip keeps its width, so hovering one never
   * moves the others.
   */
  const budgets = useMemo(() => {
    let remaining = slack;
    return named.map((symbol) => {
      const base = displayWidth(symbol);
      const budget = base + Math.max(0, remaining);
      const entry = catalog[listings?.[symbol] ?? symbol];
      const chosen = getTickerBadgeText({
        symbol,
        status: badgeStatus(entry),
        quote: entry?.quote ?? null,
        liveQuote: liveQuotes,
        maxTextWidth: budget,
      });
      remaining -= displayWidth(chosen) - base;
      return budget;
    });
  }, [catalog, listings, liveQuotes, named, slack]);

  return (
    <Box flexDirection="row" width={width} height={1} overflow="hidden">
      {named.map((symbol, index) => {
        const key = keyOf(symbol);
        const entry = catalog[key];
        if (entry?.status === "missing" || (!listed && listings?.[symbol] === null)) {
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
            listing={listings?.[symbol] ?? undefined}
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
            onOpen={onOpen ?? openTicker}
          />
        );
      })}
    </Box>
  );
}
