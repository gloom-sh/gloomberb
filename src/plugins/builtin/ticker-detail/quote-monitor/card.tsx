import type { ReactNode } from "react";
import { useMemo, useRef } from "react";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../../ui";
import type { PricePoint, Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import type { QueryEntry } from "../../../../market-data/result-types";
import { resolveEntryData } from "../../../../market-data/selectors";
import { useDoubleClickActivation } from "../../../../components/use-double-click-activation";
import { FigureText } from "../../../../components/ui/figure";
import { colors, priceColor } from "../../../../theme/colors";
import { displayWidth, formatPercentRaw } from "../../../../utils/format";
import { formatMarketPriceWithCurrency, formatSignedMarketPrice, liveQuoteFormatOptions } from "../../../../market-data/market/format";
import {
  getCompletedRegularSessionDisplay,
  getExtendedSessionDisplay,
  getRegularSessionDisplay,
  EXTENDED_SESSION_MARKS,
  extendedSessionLineLabel,
  type ExtendedSessionDisplay,
} from "../../../../market-data/market/status";
import { t } from "../../../../i18n";
import { isQuoteStaleForCurrentSession } from "../../../../market-data/quotes/freshness";
import { delistingLabel, delistingStateLabel } from "../../../../market-data/quotes/delisting";
import { formatQuoteNavAsOf, formatQuoteSessionAsOf } from "../../../../market-data/quotes/time";
import { ClippedText } from "../../../../components/ui/display";
import { useSelectionFill } from "../../../../components/ui/selection-fill";
import { useQuoteFlashDirection } from "../../../../components/quote-flash";
import { followLiveSparklinePrice } from "../../../../components/price-sparkline/model";
import {
  PriceAreaSparklineBackground,
  PriceSparkline,
  resolvePriceSparklineRange,
  type PriceSparklinePeriod,
  type PriceSparklineTrend,
} from "../../../../components/price-sparkline/view";

function quoteTrend(value: number | null | undefined): PriceSparklineTrend {
  if (value == null || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

/** Desktop body text is 12px in the card's monospace face, 0.6 of its size wide. */
const DESKTOP_DETAIL_CHAR_PX = 12 * 0.6;

/**
 * The extended print's line, "After-Hours $336.08 -0.17%": the full label
 * where the room allows, else "AH", "PM" or "ON" as the heat map marks them,
 * and no line where even that does not fit. Its move is never set without its
 * price: "AH +2.77%" beside the day's +2.33% read as a second day's move
 * (^N225 on a 70-column board, 9 Nov 2026), which a wide card's
 * "After-Hours 60,404.00 +2.77%" did not.
 */
function extendedLineParts(
  extended: ExtendedSessionDisplay,
  priceText: string,
  fits: (text: string) => boolean,
): { label: string; figures: string } | null {
  const mark = EXTENDED_SESSION_MARKS[extended.session];
  const percent = formatPercentRaw(extended.changePercent);
  const candidates = [
    { label: extendedSessionLineLabel(extended, t), figures: `${priceText} ${percent}` },
    { label: mark, figures: `${priceText} ${percent}` },
  ];
  return candidates.find(({ label, figures }) => fits(`${label} ${figures}`)) ?? null;
}

const DESKTOP_DETAIL_TEXT_STYLE = { fontSize: "var(--gloom-type-ui)", lineHeight: "14px", whiteSpace: "nowrap" };

/** The desktop card's muted lines: the name under its symbol, and what the price is as of. */
/** A line set over the sparkline, backed in the card's colour (the theme's, as drawn) so the line does not run through it. */
function backedLineStyle() {
  return { alignSelf: "start", maxWidth: "100%", backgroundColor: colors.bg, boxShadow: `0 0 0 2px ${colors.bg}`, paddingRight: 2 };
}

const DESKTOP_META_LINE_STYLE = {
  fontSize: "var(--gloom-type-ui)",
  lineHeight: "14px",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function ExtendedSessionLine({
  parts,
  color,
  dim,
  desktopStyle,
}: {
  parts: { label: string; figures: string };
  color: string;
  dim: boolean;
  /** Placement on the desktop card's grid; the terminal gives the line one row. */
  desktopStyle?: Record<string, string | number | undefined>;
}) {
  const textStyle = desktopStyle ? DESKTOP_DETAIL_TEXT_STYLE : undefined;
  return (
    <Box flexDirection="row" gap={1} height={desktopStyle ? undefined : 1} overflow="hidden" style={desktopStyle}>
      <Text fg={colors.textDim} style={textStyle}>{parts.label}</Text>
      <Text fg={color} attributes={dim ? TextAttributes.DIM : TextAttributes.NONE} style={textStyle}>{parts.figures}</Text>
    </Box>
  );
}

/** A mistyped ticker and a broken provider are not the same problem. */
const UNKNOWN_SYMBOL_REASONS = new Set(["NOT_FOUND", "BAD_MAPPING"]);

interface QuoteStatus {
  failed: boolean;
  text: string;
  stale?: boolean;
  /** DELISTED or INACTIVE: the listing no longer trades, and `text` says since when. */
  ended?: string;
}

function resolveQuoteStatus(entry: QueryEntry<Quote> | null, symbol: string, quote: Quote | null | undefined): QuoteStatus {
  const error = entry?.error;
  if (error) {
    return UNKNOWN_SYMBOL_REASONS.has(error.reasonCode)
      ? { failed: true, text: `${symbol} not recognized` }
      : { failed: true, text: error.message || "Quote unavailable" };
  }
  if (quote?.delisting) return { failed: true, text: delistingLabel(quote.delisting), stale: true, ended: delistingStateLabel(quote.delisting) };
  if (isQuoteStaleForCurrentSession(quote)) return { failed: true, text: "Stale quote", stale: true };
  if (entry?.phase === "ready") return { failed: false, text: "No quote data" };
  return { failed: false, text: "Loading quote..." };
}

export function QuoteMonitorCard({
  symbol,
  ticker,
  cachedFinancials,
  quoteEntry,
  chartEntry,
  width,
  height,
  showRightDivider,
  showBottomDivider,
  chartPeriod,
  valueFlashingEnabled,
  selected = false,
  onSelect,
  onOpen,
  perpetuals,
  label = symbol,
}: {
  perpetuals?: ReactNode;
  symbol: string;
  /** What the card is headed with, when not the symbol as saved: one form across the board (8058:JPX). */
  label?: string;
  ticker: TickerRecord | null;
  cachedFinancials: TickerFinancials | null;
  quoteEntry: QueryEntry<Quote> | null;
  chartEntry: QueryEntry<PricePoint[]> | null;
  width: number;
  height: number;
  showRightDivider: boolean;
  showBottomDivider: boolean;
  chartPeriod: PriceSparklinePeriod;
  valueFlashingEnabled: boolean;
  /** The board's keyboard cursor is on this card. */
  selected?: boolean;
  onSelect?: (symbol: string) => void;
  onOpen: (symbol: string) => void;
}) {
  const { nativePaneChrome, cellWidthPx = 8 } = useUiCapabilities();
  const selectionFill = useSelectionFill();
  const quote = resolveEntryData(quoteEntry) ?? cachedFinancials?.quote;
  const queriedPriceHistory = resolveEntryData(chartEntry);
  const barHistory = queriedPriceHistory && queriedPriceHistory.length >= 2
    ? queriedPriceHistory
    : cachedFinancials?.priceHistory;
  const assetCategory = quote?.instrumentType ?? ticker?.metadata.assetCategory;
  // Completed bars end at the prior close; the live price closes the line and the stated range.
  const sparklineRef = useRef<PricePoint[] | undefined>(undefined);
  const priceHistory = useMemo(() => {
    if (!barHistory) return undefined;
    const next = followLiveSparklinePrice(barHistory, quote, { assetCategory, period: chartPeriod, previous: sparklineRef.current });
    sparklineRef.current = next;
    return next;
  }, [assetCategory, barHistory, chartPeriod, quote]);
  const flashFinancials = useMemo<TickerFinancials | null>(
    () => quote ? { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] } : null,
    [quote],
  );
  const flashDirection = useQuoteFlashDirection(flashFinancials, valueFlashingEnabled);
  // The headline is the regular session, which holds at its close; a pre-market or
  // after-hours print is its own line, measured from that close, as on the Overview.
  const display = getRegularSessionDisplay(quote);
  const extended = getExtendedSessionDisplay(quote);
  // Once the close is in, a tick moves only the extended print, so only that line flashes.
  const headlineHolds = getCompletedRegularSessionDisplay(quote) != null;
  const quoteStatus = resolveQuoteStatus(quoteEntry, symbol, quote);
  const quoteFailed = quoteStatus.failed && !!display;
  const navAsOf = formatQuoteNavAsOf(quote);
  // Each card says what its own price is as of (`CLOSED · 08:09 UTC` beside `15 min delayed · 21:20 UTC`);
  // a fund says its NAV's date instead.
  const sessionAsOf = quoteStatus.ended ? null : formatQuoteSessionAsOf(quote);
  const desktopAsOf = nativePaneChrome ? navAsOf ?? sessionAsOf : null;
  const changeColor = quoteFailed ? colors.textDim : priceColor(display?.change ?? 0);
  const flashing = !!flashDirection && !headlineHolds;
  const currency = quote?.currency || ticker?.metadata.currency || "USD";
  const stacked = width < 31;
  const compactQuoteFailure = quoteFailed && stacked && height <= 3;
  const compactNavAsOf = navAsOf && stacked && height <= 3;
  // One decimal count per instrument, so streamed ticks never narrow or widen the price column.
  const priceOptions = liveQuoteFormatOptions(quote, currency, assetCategory, cachedFinancials?.quoteMetadata?.instrumentType);
  const priceText = display ? formatMarketPriceWithCurrency(display.price, currency, priceOptions) : "";
  // A listing that no longer trades shows its last close alone: no move, not even a dash for one.
  const changePercentText = display && !quote?.delisting ? formatPercentRaw(display.changePercent) : "";
  const changeValueText = display && !quote?.delisting ? formatSignedMarketPrice(display.change, priceOptions) : "";
  const priceColumnWidth = Math.max(priceText.length, changePercentText.length + changeValueText.length + 1);
  const nameMaxWidth = Math.max(10, width - priceColumnWidth - (nativePaneChrome ? 5 : 3));
  // The terminal sets the line beside the change, under the symbol (or after it in a
  // stacked card); the desktop gives it a row of its own under the name.
  const extendedRoom = nativePaneChrome
    ? (width * cellWidthPx - 24) / DESKTOP_DETAIL_CHAR_PX
    : stacked ? width - 3 - displayWidth(label) : width - 3 - priceColumnWidth;
  const extendedParts = display && extended
    ? extendedLineParts(extended, formatMarketPriceWithCurrency(extended.price, currency, priceOptions), (text) => displayWidth(text) <= extendedRoom)
    : null;
  // A desktop card says a listing no longer trades on a row of its own.
  const endedRow = nativePaneChrome && quoteFailed && !!quoteStatus.ended && !extendedParts;
  const extendedColor = quoteFailed ? colors.textDim : priceColor(extended?.change ?? 0);
  const extendedDim = !!flashDirection && headlineHolds;
  const sparklineRange = resolvePriceSparklineRange(priceHistory, chartPeriod);
  // A price in 32nds already has a hyphen (104-16½), so its range reads "to".
  const rangeSeparator = priceOptions.priceBasis === "thirty-seconds" ? " to " : "-";
  const rangeLabel = sparklineRange
    ? `${chartPeriod} ${formatMarketPriceWithCurrency(sparklineRange.min, currency, priceOptions)}${rangeSeparator}${formatMarketPriceWithCurrency(sparklineRange.max, currency, priceOptions)}`
    : "";
  const sparklineWidth = Math.max(8, width - (nativePaneChrome ? rangeLabel.length + 5 : 2));
  const trend = quoteTrend(display?.change);
  const terminalSparklineHeight = !nativePaneChrome && !stacked && height >= 4 ? 2 : 1;
  const statusRows = (quoteFailed && !compactQuoteFailure ? 1 : 0) + (navAsOf && !compactNavAsOf ? 1 : 0);
  const headerRows = stacked ? 3 : 2;
  const showTerminalSparkline = (!quoteFailed && !navAsOf)
    || height >= headerRows + statusRows + terminalSparklineHeight;
  // The terminal gives the as-of line a row only where the card has one to spare: the sparkline keeps its rows.
  const showTerminalSessionAsOf = !!sessionAsOf
    && height >= headerRows + statusRows + (perpetuals ? 1 : 0) + (showTerminalSparkline ? terminalSparklineHeight : 0) + 1;
  // Figures sit over the sparkline, so the desktop rings them in the card colour.
  const figureHalo = { textShadow: `0 1px 2px ${colors.bg}` };
  // The card's title: a heading over the app's 12px name, under the 20px price.
  const desktopSymbolStyle = nativePaneChrome
    ? {
        fontSize: "var(--gloom-type-heading)",
        lineHeight: "18px",
      }
    : undefined;

  const handleMouseDown = useDoubleClickActivation<string>({
    onSelect,
    onActivate: onOpen,
  });
  // The terminal marks the cursor on the symbol, quieter while the board does
  // not have the keys; the desktop rings the card.
  const symbolFg = selected && !nativePaneChrome && selectionFill.lit ? colors.selectedText : colors.textBright;
  const symbolBg = selected && !nativePaneChrome ? selectionFill.bg : undefined;

  return (
    <Box
      flexDirection="column"
      width={nativePaneChrome ? undefined : width}
      height={nativePaneChrome ? undefined : height}
      backgroundColor={colors.bg}
      paddingX={nativePaneChrome ? 0 : 1}
      paddingY={0}
      overflow="hidden"
      onMouseDown={(event: any) => {
        event.preventDefault?.();
        handleMouseDown(symbol, symbol, event);
      }}
      data-gloom-role="quote-monitor-card"
      style={nativePaneChrome ? {
        cursor: "pointer",
        position: "relative",
        width: "100%",
        height: "100%",
        padding: "var(--gloom-space-xs) var(--gloom-inset)",
        // The rules between the board's cards are the app's hairline.
        borderRight: showRightDivider ? "1px solid var(--gloom-hairline)" : undefined,
        borderBottom: showBottomDivider ? "1px solid var(--gloom-hairline)" : undefined,
        outline: selected ? `1px solid ${colors.borderFocused}` : undefined,
        outlineOffset: selected ? -1 : undefined,
      } : undefined}
    >
      {nativePaneChrome && display && (
        <PriceAreaSparklineBackground priceHistory={priceHistory} trend={trend} period={chartPeriod} insetTop={44} />
      )}
      {!display ? (
        <Box flexDirection="column" flexGrow={1} justifyContent="center">
          <Text attributes={TextAttributes.BOLD} fg={symbolFg} bg={symbolBg} style={desktopSymbolStyle}>
            {label}
          </Text>
          <Text fg={quoteStatus.ended ? colors.warning : quoteStatus.failed ? colors.negative : colors.textDim}>{quoteStatus.text}</Text>
        </Box>
      ) : nativePaneChrome ? (
        <Box
          flexGrow={1}
          style={{
            position: "relative",
            zIndex: 1,
            display: "grid",
            // The symbol and the price keep their natural widths; the name gives way first.
            gridTemplateColumns: "minmax(min-content, 1fr) auto",
            // The symbol and price, what the price is as of, an extended print, the range, a perpetual.
            gridTemplateRows: "auto auto 1fr auto auto",
            columnGap: "var(--gloom-space-md)",
            width: "100%",
            height: "100%",
          }}
        >
          <Box
            flexDirection="column"
            minWidth={0}
            style={{
              gridColumn: "1",
              gridRow: extendedParts || endedRow || desktopAsOf ? "1" : "1 / span 3",
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            <Text attributes={TextAttributes.BOLD} fg={symbolFg} bg={symbolBg} style={{ ...desktopSymbolStyle, whiteSpace: "nowrap" }}>
              {label}
            </Text>
            {quoteFailed && !endedRow && (
              <Text fg={quoteStatus.ended ? colors.warning : colors.negative} style={{ fontSize: "var(--gloom-type-ui)", lineHeight: "14px" }}>
                {quoteStatus.text}
              </Text>
            )}
            {!quoteFailed && ticker?.metadata.name && (
              // No width of its own: the column is the symbol's, and the name is cut to it.
              <Text fg={colors.textDim} style={{ ...DESKTOP_META_LINE_STYLE, contain: "inline-size" }}>
                {ticker.metadata.name}
              </Text>
            )}
          </Box>

          <Box
            flexDirection="column"
            alignItems="flex-end"
            style={{
              gridColumn: "2",
              gridRow: "1",
              justifySelf: "end",
              backgroundColor: colors.bg,
              borderRadius: "var(--gloom-radius-sm)",
              boxShadow: `0 0 0 2px ${colors.bg}`,
              paddingLeft: "var(--gloom-space-xs)",
              paddingBottom: 1,
            }}
          >
            <FigureText fg={changeColor} dim={flashing} style={figureHalo}>{priceText}</FigureText>
            <Box flexDirection="row" gap={1} justifyContent="flex-end">
              <FigureText part="sub" fg={changeColor} dim={flashing} style={figureHalo}>{changePercentText}</FigureText>
              <FigureText part="sub" fg={changeColor} dim={flashing} style={figureHalo}>{changeValueText}</FigureText>
            </Box>
          </Box>

          {desktopAsOf && (
            // Across the card under the name and the price, so the time is never cut beside a wide price.
            <Text
              fg={colors.textDim}
              style={{ ...DESKTOP_META_LINE_STYLE, gridColumn: "1 / -1", gridRow: "2", justifySelf: "start", ...backedLineStyle() }}
            >
              {desktopAsOf}
            </Text>
          )}

          {endedRow && (
            // Under the price, across the card, so the date is never cut on a narrow card;
            // backed like the price so the sparkline does not run through it.
            <Text
              fg={colors.warning}
              style={{
                gridColumn: "1 / -1",
                gridRow: "3",
                justifySelf: "start",
                alignSelf: "start",
                fontSize: "var(--gloom-type-ui)",
                lineHeight: "14px",
                whiteSpace: "nowrap",
                backgroundColor: colors.bg,
                borderRadius: "var(--gloom-radius-sm)",
                boxShadow: `0 0 0 2px ${colors.bg}`,
              }}
            >
              {quoteStatus.text}
            </Text>
          )}

          {extendedParts && (
            <ExtendedSessionLine
              parts={extendedParts}
              color={extendedColor}
              dim={extendedDim}
              desktopStyle={{
                gridColumn: "1 / -1",
                gridRow: "3",
                justifySelf: "start",
                alignSelf: "start",
                maxWidth: "100%",
                marginTop: 2,
                backgroundColor: colors.bg,
                boxShadow: `0 0 0 2px ${colors.bg}`,
                paddingRight: 2,
              }}
            />
          )}

          {perpetuals && <Box style={{ gridColumn: "1 / -1", gridRow: "5", alignSelf: "end" }}>{perpetuals}</Box>}
          {rangeLabel && (
            <Text
              fg={colors.textDim}
              style={{
                // Across the card, so a wide range never widens the price's column into the symbol's.
                gridColumn: "1 / -1",
                gridRow: "4",
                justifySelf: "end",
                alignSelf: "end",
                fontSize: "var(--gloom-type-ui)",
                lineHeight: "14px",
                backgroundColor: colors.bg,
                paddingLeft: "var(--gloom-space-xs)",
                paddingRight: 2,
                boxShadow: `0 0 0 2px ${colors.bg}`,
              }}
            >
              {rangeLabel}
            </Text>
          )}
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} justifyContent="flex-start">
          {stacked ? (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1} height={1} overflow="hidden">
                <Text attributes={TextAttributes.BOLD} fg={symbolFg} bg={symbolBg} style={desktopSymbolStyle}>
                  {label}
                </Text>
                {compactNavAsOf && <Text fg={colors.textDim}>{navAsOf}</Text>}
                {extendedParts && <ExtendedSessionLine parts={extendedParts} color={extendedColor} dim={extendedDim} />}
              </Box>
              <Box flexDirection="column">
                <FigureText fg={changeColor} dim={flashing} style={figureHalo}>
                  {compactQuoteFailure ? `${priceText} · ${quoteStatus.ended ?? (quoteStatus.stale ? "STALE" : "ERROR")}` : priceText}
                </FigureText>
                <Box flexDirection="row" gap={1}>
                  <FigureText part="sub" fg={changeColor} dim={flashing} style={figureHalo}>{changePercentText}</FigureText>
                  <FigureText part="sub" fg={changeColor} dim={flashing} style={figureHalo}>{changeValueText}</FigureText>
                </Box>
              </Box>
            </Box>
          ) : (
            <Box
              flexDirection="row"
              alignItems="flex-start"
              justifyContent="space-between"
              gap={1}
            >
              <Box flexDirection="column" flexGrow={1} minWidth={0}>
                <Text attributes={TextAttributes.BOLD} fg={symbolFg} bg={symbolBg} style={desktopSymbolStyle}>
                  {label}
                </Text>
                {extendedParts && <ExtendedSessionLine parts={extendedParts} color={extendedColor} dim={extendedDim} />}
                {nativePaneChrome && ticker?.metadata.name && width >= 36 && (
                  <Text
                    fg={colors.textDim}
                    style={{
                      fontSize: "var(--gloom-type-ui)",
                      lineHeight: "16px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    maxWidth={nameMaxWidth}
                  >
                    {ticker.metadata.name}
                  </Text>
                )}
              </Box>
              <Box flexDirection="column" alignItems="flex-end">
                <FigureText fg={changeColor} dim={flashing} style={figureHalo}>{priceText}</FigureText>
                <Box flexDirection="row" gap={1} justifyContent="flex-end">
                  <FigureText part="sub" fg={changeColor} dim={flashing} style={figureHalo}>{changePercentText}</FigureText>
                  <FigureText part="sub" fg={changeColor} dim={flashing} style={figureHalo}>{changeValueText}</FigureText>
                </Box>
              </Box>
            </Box>
          )}

          {quoteFailed && !compactQuoteFailure && (
            <Box height={1} overflow="hidden"><Text fg={quoteStatus.ended ? colors.warning : colors.negative}>{quoteStatus.text}</Text></Box>
          )}
          {navAsOf && !compactNavAsOf && (
            <Box height={1} overflow="hidden"><Text fg={colors.textDim}>{navAsOf}</Text></Box>
          )}
          {showTerminalSessionAsOf && (
            <Box height={1} overflow="hidden"><ClippedText text={sessionAsOf!} width={Math.max(1, width - 2)} fg={colors.textDim} /></Box>
          )}
          {perpetuals}
          {showTerminalSparkline && <Box height={terminalSparklineHeight} flexDirection="row" alignItems="center" gap={1}>
            <PriceSparkline
              priceHistory={priceHistory}
              width={sparklineWidth}
              height={terminalSparklineHeight}
              trend={trend}
              period={chartPeriod}
              area={!nativePaneChrome}
            />
            {nativePaneChrome && rangeLabel && (
              <Text fg={colors.textDim} style={{ fontSize: "var(--gloom-type-ui)", lineHeight: "14px" }}>
                {rangeLabel}
              </Text>
            )}
          </Box>}
        </Box>
      )}
    </Box>
  );
}
