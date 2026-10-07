import type { ReactNode } from "react";
import { useMemo } from "react";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../../ui";
import type { PricePoint, Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import type { QueryEntry } from "../../../../market-data/result-types";
import { resolveEntryData } from "../../../../market-data/selectors";
import { useDoubleClickActivation } from "../../../../components/use-double-click-activation";
import { FigureText } from "../../../../components/ui/figure";
import { colors, priceColor } from "../../../../theme/colors";
import { formatPercentRaw } from "../../../../utils/format";
import { formatMarketPriceWithCurrency, formatSignedMarketPrice, liveQuoteFormatOptions } from "../../../../market-data/market/format";
import { getActiveQuoteDisplay } from "../../../../market-data/market/status";
import { isQuoteStaleForCurrentSession } from "../../../../market-data/quotes/freshness";
import { formatQuoteNavAsOf } from "../../../../market-data/quotes/time";
import { useQuoteFlashDirection } from "../../../../components/quote-flash";
import { appendLiveQuotePoint } from "../../../../time-series/chart-data";
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

/** A mistyped ticker and a broken provider are not the same problem. */
const UNKNOWN_SYMBOL_REASONS = new Set(["NOT_FOUND", "BAD_MAPPING"]);

interface QuoteStatus {
  failed: boolean;
  text: string;
  stale?: boolean;
}

function resolveQuoteStatus(entry: QueryEntry<Quote> | null, symbol: string, quote: Quote | null | undefined): QuoteStatus {
  const error = entry?.error;
  if (error) {
    return UNKNOWN_SYMBOL_REASONS.has(error.reasonCode)
      ? { failed: true, text: `${symbol} not recognized` }
      : { failed: true, text: error.message || "Quote unavailable" };
  }
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
}: {
  perpetuals?: ReactNode;
  symbol: string;
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
  const { nativePaneChrome } = useUiCapabilities();
  const quote = resolveEntryData(quoteEntry) ?? cachedFinancials?.quote;
  const queriedPriceHistory = resolveEntryData(chartEntry);
  const barHistory = queriedPriceHistory && queriedPriceHistory.length >= 2
    ? queriedPriceHistory
    : cachedFinancials?.priceHistory;
  const assetCategory = quote?.instrumentType ?? ticker?.metadata.assetCategory;
  // Completed bars end at the prior close; the live price closes the line and the stated range.
  const priceHistory = useMemo(() => barHistory && appendLiveQuotePoint(barHistory, quote, { assetCategory }),
    [assetCategory, barHistory, quote]);
  const flashFinancials = useMemo<TickerFinancials | null>(
    () => quote ? { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] } : null,
    [quote],
  );
  const flashDirection = useQuoteFlashDirection(flashFinancials, valueFlashingEnabled);
  const display = getActiveQuoteDisplay(quote);
  const quoteStatus = resolveQuoteStatus(quoteEntry, symbol, quote);
  const quoteFailed = quoteStatus.failed && !!display;
  const navAsOf = formatQuoteNavAsOf(quote);
  const changeColor = quoteFailed ? colors.textDim : priceColor(display?.change ?? 0);
  const flashing = !!flashDirection;
  const currency = quote?.currency || ticker?.metadata.currency || "USD";
  const stacked = width < 31;
  const compactQuoteFailure = quoteFailed && stacked && height <= 3;
  const compactNavAsOf = navAsOf && stacked && height <= 3;
  // One decimal count per instrument, so streamed ticks never narrow or widen the price column.
  const priceOptions = liveQuoteFormatOptions(quote, currency, assetCategory, cachedFinancials?.quoteMetadata?.instrumentType);
  const priceText = display ? formatMarketPriceWithCurrency(display.price, currency, priceOptions) : "";
  const changePercentText = display ? formatPercentRaw(display.changePercent) : "";
  const changeValueText = display ? formatSignedMarketPrice(display.change, priceOptions) : "";
  const priceColumnWidth = Math.max(priceText.length, changePercentText.length + changeValueText.length + 1);
  const nameMaxWidth = Math.max(10, width - priceColumnWidth - (nativePaneChrome ? 5 : 3));
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
  const showTerminalSparkline = (!quoteFailed && !navAsOf)
    || height >= (stacked ? 3 : 2) + statusRows + terminalSparklineHeight;
  // Figures sit over the sparkline, so the desktop rings them in the card colour.
  const figureHalo = { textShadow: `0 1px 2px ${colors.bg}` };
  const desktopSymbolStyle = nativePaneChrome
    ? {
        fontSize: "15px",
        lineHeight: "18px",
      }
    : undefined;

  const handleMouseDown = useDoubleClickActivation<string>({
    onSelect,
    onActivate: onOpen,
  });
  // The terminal marks the cursor on the symbol; the desktop rings the card.
  const symbolFg = selected && !nativePaneChrome ? colors.selectedText : colors.textBright;
  const symbolBg = selected && !nativePaneChrome ? colors.selected : undefined;

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
        paddingLeft: 10,
        paddingRight: 10,
        paddingTop: 6,
        paddingBottom: 4,
        borderRight: showRightDivider ? `1px solid ${colors.border}` : undefined,
        borderBottom: showBottomDivider ? `1px solid ${colors.border}` : undefined,
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
            {symbol}
          </Text>
          <Text fg={quoteStatus.failed ? colors.negative : colors.textDim}>{quoteStatus.text}</Text>
        </Box>
      ) : nativePaneChrome ? (
        <Box
          flexGrow={1}
          style={{
            position: "relative",
            zIndex: 1,
            display: "grid",
            // The name gives way first; the price keeps its natural width.
            gridTemplateColumns: "minmax(0, 1fr) auto",
            gridTemplateRows: "auto 1fr auto auto",
            columnGap: 12,
            width: "100%",
            height: "100%",
          }}
        >
          <Box
            flexDirection="column"
            minWidth={0}
            style={{
              gridColumn: "1",
              gridRow: "1 / span 2",
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            <Text attributes={TextAttributes.BOLD} fg={symbolFg} bg={symbolBg} style={desktopSymbolStyle}>
              {symbol}
            </Text>
            {quoteFailed && (
              <Text fg={colors.negative} style={{ fontSize: "12px", lineHeight: "14px" }}>
                {quoteStatus.text}
              </Text>
            )}
            {!quoteFailed && ticker?.metadata.name && (
              <Text
                fg={colors.textDim}
                style={{
                  fontSize: "12px",
                  lineHeight: "14px",
                  maxWidth: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {ticker.metadata.name}
              </Text>
            )}
            {navAsOf && (
              <Text fg={colors.textDim} style={{ fontSize: "12px", lineHeight: "14px" }}>
                {navAsOf}
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
              borderRadius: 4,
              boxShadow: `0 0 0 2px ${colors.bg}`,
              paddingLeft: 6,
              paddingBottom: 1,
            }}
          >
            <FigureText fg={changeColor} dim={flashing} style={figureHalo}>{priceText}</FigureText>
            <Box flexDirection="row" gap={1} justifyContent="flex-end">
              <FigureText part="sub" fg={changeColor} dim={flashing} style={figureHalo}>{changePercentText}</FigureText>
              <FigureText part="sub" fg={changeColor} dim={flashing} style={figureHalo}>{changeValueText}</FigureText>
            </Box>
          </Box>

          {perpetuals && <Box style={{ gridColumn: "1 / -1", gridRow: "4", alignSelf: "end" }}>{perpetuals}</Box>}
          {rangeLabel && (
            <Text
              fg={colors.textDim}
              style={{
                gridColumn: "2",
                gridRow: "3",
                justifySelf: "end",
                alignSelf: "end",
                fontSize: "11px",
                lineHeight: "13px",
                backgroundColor: colors.bg,
                paddingLeft: 6,
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
                  {symbol}
                </Text>
                {compactNavAsOf && <Text fg={colors.textDim}>{navAsOf}</Text>}
              </Box>
              <Box flexDirection="column">
                <FigureText fg={changeColor} dim={flashing} style={figureHalo}>
                  {compactQuoteFailure ? `${priceText} · ${quoteStatus.stale ? "STALE" : "ERROR"}` : priceText}
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
                  {symbol}
                </Text>
                {nativePaneChrome && ticker?.metadata.name && width >= 36 && (
                  <Text
                    fg={colors.textDim}
                    style={{
                      fontSize: "12px",
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
            <Box height={1} overflow="hidden"><Text fg={colors.negative}>{quoteStatus.text}</Text></Box>
          )}
          {navAsOf && !compactNavAsOf && (
            <Box height={1} overflow="hidden"><Text fg={colors.textDim}>{navAsOf}</Text></Box>
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
              <Text fg={colors.textDim} style={{ fontSize: "11px", lineHeight: "14px" }}>
                {rangeLabel}
              </Text>
            )}
          </Box>}
        </Box>
      )}
    </Box>
  );
}
