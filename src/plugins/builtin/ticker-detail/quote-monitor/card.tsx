import { useMemo } from "react";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../../ui";
import type { PricePoint, Quote, TickerFinancials } from "../../../../types/financials";
import type { TickerRecord } from "../../../../types/ticker";
import type { QueryEntry } from "../../../../market-data/result-types";
import { resolveEntryData } from "../../../../market-data/selectors";
import { useDoubleClickActivation } from "../../../../components/use-double-click-activation";
import { colors, priceColor } from "../../../../theme/colors";
import { formatPercentRaw } from "../../../../utils/format";
import { formatMarketPriceWithCurrency, formatSignedMarketPrice } from "../../../../market-data/market/format";
import { getActiveQuoteDisplay } from "../../../../market-data/market/status";
import { useQuoteFlashDirection } from "../../../../components/quote-flash";
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
}

function resolveQuoteStatus(entry: QueryEntry<Quote> | null, symbol: string): QuoteStatus {
  const error = entry?.error;
  if (error) {
    return UNKNOWN_SYMBOL_REASONS.has(error.reasonCode)
      ? { failed: true, text: `${symbol} not recognized` }
      : { failed: true, text: error.message || "Quote unavailable" };
  }
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
  onOpen,
}: {
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
  onOpen: (symbol: string) => void;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const quote = resolveEntryData(quoteEntry) ?? cachedFinancials?.quote;
  const queriedPriceHistory = resolveEntryData(chartEntry);
  const priceHistory = queriedPriceHistory && queriedPriceHistory.length >= 2
    ? queriedPriceHistory
    : cachedFinancials?.priceHistory;
  const flashFinancials = useMemo<TickerFinancials | null>(
    () => quote ? { quote, annualStatements: [], quarterlyStatements: [], priceHistory: [] } : null,
    [quote],
  );
  const flashDirection = useQuoteFlashDirection(flashFinancials, valueFlashingEnabled);
  const display = getActiveQuoteDisplay(quote);
  const quoteStatus = resolveQuoteStatus(quoteEntry, symbol);
  const changeColor = priceColor(display?.change ?? 0);
  const priceAttributes = flashDirection ? TextAttributes.DIM : TextAttributes.BOLD;
  const changeAttributes = flashDirection ? TextAttributes.DIM : TextAttributes.NONE;
  const currency = quote?.currency ?? ticker?.metadata.currency ?? "USD";
  const stacked = width < 31;
  const priceText = display
    ? formatMarketPriceWithCurrency(display.price, currency, { assetCategory: ticker?.metadata.assetCategory })
    : "";
  const changePercentText = display ? formatPercentRaw(display.changePercent) : "";
  const changeValueText = display ? formatSignedMarketPrice(display.change, { assetCategory: ticker?.metadata.assetCategory }) : "";
  const priceColumnWidth = Math.max(priceText.length, changePercentText.length + changeValueText.length + 1);
  const nameMaxWidth = Math.max(10, width - priceColumnWidth - (nativePaneChrome ? 5 : 3));
  const sparklineRange = resolvePriceSparklineRange(priceHistory, chartPeriod);
  const rangeLabel = sparklineRange
    ? `${chartPeriod} ${formatMarketPriceWithCurrency(sparklineRange.min, currency, { assetCategory: ticker?.metadata.assetCategory })}-${formatMarketPriceWithCurrency(sparklineRange.max, currency, { assetCategory: ticker?.metadata.assetCategory })}`
    : "";
  const sparklineWidth = Math.max(8, width - (nativePaneChrome ? rangeLabel.length + 5 : 2));
  const trend = quoteTrend(display?.change);
  const terminalSparklineHeight = !nativePaneChrome && !stacked && height >= 4 ? 2 : 1;
  const desktopPriceStyle = nativePaneChrome
    ? {
        fontSize: "22px",
        lineHeight: "1.05",
        fontWeight: 720,
        textShadow: `0 1px 2px ${colors.bg}`,
      }
    : undefined;
  const desktopChangeStyle = nativePaneChrome
    ? {
        fontSize: "12px",
        lineHeight: "1.1",
        fontWeight: 540,
        textShadow: `0 1px 2px ${colors.bg}`,
      }
    : undefined;
  const desktopSymbolStyle = nativePaneChrome
    ? {
        fontSize: "15px",
        lineHeight: "18px",
      }
    : undefined;

  const handleMouseDown = useDoubleClickActivation<string>({
    onActivate: onOpen,
  });

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
      } : undefined}
    >
      {nativePaneChrome && display && (
        <PriceAreaSparklineBackground priceHistory={priceHistory} trend={trend} period={chartPeriod} />
      )}
      {!display ? (
        <Box flexDirection="column" flexGrow={1} justifyContent="center">
          <Text attributes={TextAttributes.BOLD} fg={colors.textBright} style={desktopSymbolStyle}>
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
            gridTemplateColumns: "minmax(130px, 1fr) minmax(88px, auto)",
            gridTemplateRows: "auto 1fr auto",
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
            <Text attributes={TextAttributes.BOLD} fg={colors.textBright} style={desktopSymbolStyle}>
              {symbol}
            </Text>
            {ticker?.metadata.name && (
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
            <Text
              attributes={priceAttributes}
              fg={changeColor}
              style={desktopPriceStyle}
            >
              {priceText}
            </Text>
            <Box flexDirection="row" gap={1} justifyContent="flex-end">
              <Text fg={changeColor} attributes={changeAttributes} style={desktopChangeStyle}>{changePercentText}</Text>
              <Text fg={changeColor} attributes={changeAttributes} style={desktopChangeStyle}>{changeValueText}</Text>
            </Box>
          </Box>

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
              <Text attributes={TextAttributes.BOLD} fg={colors.textBright} style={desktopSymbolStyle}>
                {symbol}
              </Text>
              <Box flexDirection="column">
                <Text attributes={priceAttributes} fg={changeColor} style={desktopPriceStyle}>
                  {priceText}
                </Text>
                <Box flexDirection="row" gap={1}>
                  <Text fg={changeColor} attributes={changeAttributes} style={desktopChangeStyle}>{changePercentText}</Text>
                  <Text fg={changeColor} attributes={changeAttributes} style={desktopChangeStyle}>{changeValueText}</Text>
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
                <Text attributes={TextAttributes.BOLD} fg={colors.textBright} style={desktopSymbolStyle}>
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
                <Text
                  attributes={priceAttributes}
                  fg={changeColor}
                  style={desktopPriceStyle}
                >
                  {priceText}
                </Text>
                <Box flexDirection="row" gap={1} justifyContent="flex-end">
                  <Text fg={changeColor} attributes={changeAttributes} style={desktopChangeStyle}>{changePercentText}</Text>
                  <Text fg={changeColor} attributes={changeAttributes} style={desktopChangeStyle}>{changeValueText}</Text>
                </Box>
              </Box>
            </Box>
          )}

          <Box height={terminalSparklineHeight} flexDirection="row" alignItems="center" gap={1}>
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
          </Box>
        </Box>
      )}
    </Box>
  );
}
