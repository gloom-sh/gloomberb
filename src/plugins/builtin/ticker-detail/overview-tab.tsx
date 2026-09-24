import { EmptyState, SectionHeading, usePaneNoticeFooter } from "../../../components";
import { CompositeChart, pricePointsToResolvedSeries } from "../../../components/chart/composite";
import { CompanyLogo } from "../../../components/company-logo";
import { PriceReturnStrip } from "../../../components/price-performance";
import { t } from "../../../i18n";
import { useFxRatesMap } from "../../../market-data/hooks";
import { formatMarketPriceWithCurrency, formatSignedMarketPrice, liveQuoteFormatOptions } from "../../../market-data/market/format";
import { exchangeShortName, marketStateColor, marketStateLabel } from "../../../market-data/market/status";
import { appendQuoteToPriceReturnHistory, buildPriceReturnFields } from "../../../market-data/performance";
import { useViewport } from "../../../react/input";
import { useAppSelector } from "../../../state/app/context";
import { colors, priceColor } from "../../../theme/colors";
import { appendLiveQuotePoint, hasUnknownBondHistoryBasis } from "../../../time-series/chart-data";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { Box, ScrollBox, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { selectEffectiveExchangeRates } from "../../../utils/exchange-rate-map";
import { resolveExchangeTimeZone } from "../../../utils/exchanges";
import { convertCurrency, displayWidth, formatPercentRaw, truncateToDisplayWidth } from "../../../utils/format";
import { CompactRangeBar, FundamentalsGrid, PositionTable, QuoteBook } from "./overview/components";
import { buildOverviewStats, buildPositionRows } from "./overview/model";
import { describeFundamentalMarketCap } from "../../../utils/market-capitalization";
import { liveFiftyTwoWeekRange, liveMarketCapitalization } from "../portfolio-list/live-valuation";

interface OverviewTabProps {
  width?: number;
  focused?: boolean;
  ticker: TickerRecord | null;
  financials: TickerFinancials | null;
  /** A click on the price chart opens the full chart. */
  onOpenChart?: () => void;
}

export function OverviewTab(props: OverviewTabProps) {
  if (!props.ticker) return <EmptyState title={t("No ticker selected.")} />;
  return <ResolvedOverviewTab {...props} ticker={props.ticker} />;
}

function ResolvedOverviewTab({ width, focused = false, ticker, financials, onOpenChart }: OverviewTabProps & { ticker: TickerRecord }) {
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const exchangeRatesState = useAppSelector((state) => state.exchangeRates);
  const { width: termWidth } = useViewport();
  const { fractionalViewport = false, nativePaneChrome } = useUiCapabilities();

  const quote = financials?.quote;
  const fundamentals = financials?.fundamentals;
  const capitalization = liveMarketCapitalization(quote, fundamentals);
  const profile = financials?.profile;
  const instrumentType = quote?.instrumentType?.trim()
    || financials?.quoteMetadata?.instrumentType?.trim()
    || ticker.metadata.assetCategory;
  const exchangeRates = useFxRatesMap([
    baseCurrency,
    ticker.metadata.currency,
    quote?.currency,
    capitalization?.currency,
    ...ticker.metadata.positions.map((position) => position.currency),
  ]);
  const effectiveExchangeRates = selectEffectiveExchangeRates(exchangeRates, exchangeRatesState);
  const quoteCurrency = quote?.currency ?? ticker.metadata.currency ?? baseCurrency;
  const toBase = (value: number, fromCurrency: string) =>
    convertCurrency(value, fromCurrency, baseCurrency, effectiveExchangeRates);
  const sector = ticker.metadata.sector ?? profile?.sector;
  const industry = ticker.metadata.industry ?? profile?.industry;
  const description = profile?.description?.trim();
  const listingVenue = exchangeShortName(
    quote?.listingExchangeName ?? quote?.exchangeName,
    quote?.listingExchangeFullName ?? quote?.fullExchangeName,
  );
  const routingVenue = exchangeShortName(quote?.routingExchangeName, quote?.routingExchangeFullName);
  const metadataParts = [
    routingVenue && routingVenue !== listingVenue ? `route ${routingVenue}` : "",
  ].filter((part) => part.length > 0);

  const contentWidth = Math.max((width || Math.floor(termWidth * 0.5)) - (fractionalViewport ? 2 : 4), 20);
  const chartWidth = contentWidth;
  const hasHistory = (financials?.priceHistory?.length ?? 0) > 2;
  const unknownHistoryBasis = hasUnknownBondHistoryBasis(quote, ticker.metadata.assetCategory, financials?.quoteMetadata?.instrumentType);
  const historyQuote = unknownHistoryBasis ? undefined : quote;
  const chartHistory = appendLiveQuotePoint(financials?.priceHistory ?? [], historyQuote);
  const chartDelta = (chartHistory.at(-1)?.close ?? 0) - (chartHistory[0]?.close ?? 0);
  const chartTimeZone = resolveExchangeTimeZone(
    ticker.metadata.exchange || quote?.listingExchangeName || quote?.exchangeName,
  );
  const priceSeries = pricePointsToResolvedSeries(chartHistory, {
    id: `${ticker.metadata.ticker}:price`,
    label: `${ticker.metadata.ticker} Price`,
    color: priceColor(chartDelta),
    unit: unknownHistoryBasis ? "unknown" : quoteCurrency,
    style: "area",
    axis: "right",
    panelId: "price",
    timeBasis: chartTimeZone ? { kind: "market", timeZone: chartTimeZone } : undefined,
  });
  usePaneNoticeFooter({
    registrationId: "overview-notices",
    notices: [
      ...(!quote && financials ? [t("Current quote unavailable. Other research data is still available.")] : []),
      ...(priceSeries.warning ? [priceSeries.warning] : []),
      ...(fundamentals?.unavailableFields?.includes("enterpriseValue")
        ? [t("Enterprise value unavailable: the source observation failed validation.")] : []),
      ...(capitalization?.provenance.kind === "fundamentals" && !capitalization.live
        ? [`Market cap: ${describeFundamentalMarketCap(capitalization.provenance)}.`] : []),
    ],
    focused,
  });
  const hasBidAsk = quote?.bid != null || quote?.ask != null;
  const quoteBookInline = hasBidAsk && contentWidth >= 68;
  const quoteBookWidth = quoteBookInline ? Math.min(32, Math.max(24, Math.floor(contentWidth * 0.3))) : Math.min(contentWidth, 32);
  const quoteSummaryWidth = quoteBookInline ? Math.max(20, contentWidth - quoteBookWidth - 2) : contentWidth;
  // Price, change and ranges keep the instrument's decimals on every streamed tick.
  const moneyOptions = liveQuoteFormatOptions(quote, quote?.currency, ticker.metadata.assetCategory, financials?.quoteMetadata?.instrumentType);
  const quotePriceText = quote ? formatMarketPriceWithCurrency(quote.price, quote.currency, moneyOptions) : "";
  const quoteChangeText = quote ? formatSignedMarketPrice(quote.change, moneyOptions) : "";
  const quotePercentText = quote ? `(${formatPercentRaw(quote.changePercent)})` : "";
  const quoteTextWidth = Math.max(1, quoteSummaryWidth - (nativePaneChrome ? 6 : 0));
  const stackQuoteChange = displayWidth(quoteChangeText) + 1 + displayWidth(quotePercentText) > quoteTextWidth;
  const stackQuoteSummary = displayWidth(quotePriceText) + 3 + displayWidth(quoteChangeText) + displayWidth(quotePercentText) > quoteTextWidth;
  // The pane title already names the ticker, so the line leads with the company.
  const companyName = ticker.metadata.name || quote?.name || ticker.metadata.ticker;
  const marketStateText = quote?.marketState ? t(marketStateLabel(quote.marketState)) : "";
  const companyNameWidth = Math.max(8, quoteSummaryWidth - (nativePaneChrome ? 6 : 0)
    - (listingVenue ? listingVenue.length + 3 : 0)
    - (marketStateText ? marketStateText.length + 1 : 0));
  const hasDayRange = quote?.low != null && quote?.high != null && quote.high > quote.low;
  const yearRange = liveFiftyTwoWeekRange(quote);
  const hasYearRange = yearRange != null;
  const rangeInline = contentWidth >= 70 && hasDayRange && hasYearRange;
  const rangeWidth = rangeInline
    ? Math.floor((contentWidth - 2) / 2)
    : contentWidth;
  const rangeMarkerColor = quote ? priceColor(quote.change) : colors.textDim;
  const stats = buildOverviewStats({
    quote,
    fundamentals,
    quoteCurrency,
    baseCurrency,
    toBase,
    marketCapExchangeRates: effectiveExchangeRates,
  });
  const performanceFields = buildPriceReturnFields(
    appendQuoteToPriceReturnHistory(financials?.priceHistory ?? [], historyQuote),
  );
  const hasPerformance = performanceFields.some((field) => field.value != null || field.unavailableReason);
  const positionRows = buildPositionRows({
    ticker,
    quote,
    quoteCurrency,
    baseCurrency,
    toBase,
  });

  return (
    <ScrollBox flexGrow={1} flexBasis={0} scrollY focusable={false}>
      <Box flexDirection="column" paddingX={1} paddingBottom={1} gap={1}>
        <Box flexDirection={quoteBookInline ? "row" : "column"} gap={quoteBookInline ? 2 : 0} width={contentWidth}>
          <Box flexDirection="row" width={quoteSummaryWidth} flexShrink={0} minWidth={0} overflow="hidden">
            <CompanyLogo
              symbol={ticker.metadata.ticker}
              assetCategory={ticker.metadata.assetCategory}
              name={ticker.metadata.name || quote?.name}
            />
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            <Box flexDirection="row" minWidth={0} overflow="hidden">
              <Text attributes={TextAttributes.BOLD} fg={colors.textBright}>
                {truncateToDisplayWidth(companyName, companyNameWidth)}
              </Text>
              {listingVenue && (
                <Text flexShrink={0} fg={colors.textDim}>{" "}({listingVenue})</Text>
              )}
              {quote?.marketState && (
                <Text flexShrink={0} fg={marketStateColor(quote.marketState)}>
                  {" "}{t(marketStateLabel(quote.marketState))}
                </Text>
              )}
            </Box>

            {quote && (
              <Box flexDirection={stackQuoteSummary ? "column" : "row"} gap={stackQuoteSummary ? 0 : 2}>
                <Text attributes={TextAttributes.BOLD} fg={colors.textBright}>
                  {quotePriceText}
                </Text>
                <Box flexDirection={stackQuoteChange ? "column" : "row"} gap={stackQuoteChange ? 0 : 1}>
                  <Text fg={priceColor(quote.change)}>{quoteChangeText}</Text>
                  <Text fg={priceColor(quote.change)}>{quotePercentText}</Text>
                </Box>
              </Box>
            )}
            {quote && (quote.marketState === "PRE" || quote.marketState === "PREPRE") && quote.preMarketPrice != null && (
              <Box flexDirection="row" gap={2}>
                <Text fg={colors.textDim}>{t("Pre-Market")}:</Text>
                <Text fg={priceColor(quote.preMarketChange ?? 0)}>
                  {formatMarketPriceWithCurrency(quote.preMarketPrice, quote.currency, moneyOptions)}
                </Text>
                <Text fg={priceColor(quote.preMarketChange ?? 0)}>
                  {formatSignedMarketPrice(quote.preMarketChange, moneyOptions)} ({formatPercentRaw(quote.preMarketChangePercent)})
                </Text>
              </Box>
            )}
            {quote && (quote.marketState === "POST" || quote.marketState === "POSTPOST") && quote.postMarketPrice != null && (
              <Box flexDirection="row" gap={2}>
                <Text fg={colors.textDim}>{t("After-Hours")}:</Text>
                <Text fg={priceColor(quote.postMarketChange ?? 0)}>
                  {formatMarketPriceWithCurrency(quote.postMarketPrice, quote.currency, moneyOptions)}
                </Text>
                <Text fg={priceColor(quote.postMarketChange ?? 0)}>
                  {formatSignedMarketPrice(quote.postMarketChange, moneyOptions)} ({formatPercentRaw(quote.postMarketChangePercent)})
                </Text>
              </Box>
            )}
            {metadataParts.length > 0 && (
              <Text fg={colors.textDim}>{metadataParts.join(" | ")}</Text>
            )}
            </Box>
          </Box>

          {quote && hasBidAsk && (
            <QuoteBook quote={quote} assetCategory={moneyOptions.assetCategory} width={quoteBookWidth} />
          )}
        </Box>

        {(hasDayRange || hasYearRange) && quote && (
          <Box flexDirection={rangeInline ? "row" : "column"} gap={rangeInline ? 2 : 0} width={contentWidth}>
            {hasDayRange && (
              <CompactRangeBar
                current={quote.price}
                low={quote.low!}
                high={quote.high!}
                label="Day Range"
                width={rangeWidth}
                currency={quoteCurrency}
                priceOptions={moneyOptions}
                markerColor={rangeMarkerColor}
              />
            )}
            {yearRange && (
              <CompactRangeBar
                current={quote.price}
                low={yearRange.low}
                high={yearRange.high}
                label="52W Range"
                width={rangeWidth}
                currency={quoteCurrency}
                priceOptions={moneyOptions}
                markerColor={rangeMarkerColor}
              />
            )}
          </Box>
        )}

        {hasHistory && (
          <Box
            onMouseDown={onOpenChart
              ? (event?: { button?: number }) => {
                if ((event?.button ?? 0) === 0) onOpenChart();
              }
              : undefined}
            cursor={onOpenChart ? "pointer" : undefined}
            data-gloom-interactive={onOpenChart ? "true" : undefined}
            data-gloom-role="overview-chart"
            data-gloom-label={onOpenChart ? "Open chart" : undefined}
          >
            <CompositeChart
              width={chartWidth}
              height={10}
              focused={false}
              interactive={false}
              series={[priceSeries]}
              panels={[{ id: "price" }]}
              axisWidth={8}
              showLegend={false}
            />
          </Box>
        )}

        {hasPerformance && (
          <Box flexDirection="column">
            <SectionHeading title={t("Price Return")} />
            <PriceReturnStrip fields={performanceFields} width={contentWidth} />
          </Box>
        )}

        {stats.length > 0 && (
          <Box flexDirection="column">
            <SectionHeading title={t("Fundamentals")} />
            <FundamentalsGrid fields={stats} width={contentWidth} />
          </Box>
        )}

        {positionRows.length > 0 && (
          <Box flexDirection="column">
            <SectionHeading title={t("Positions")} />
            <PositionTable rows={positionRows} width={contentWidth} />
          </Box>
        )}

        {/* Sector / Industry / Type */}
        {(sector || industry || instrumentType) && (
          <Box flexDirection="row" height={1} gap={3}>
            {instrumentType && (
              <Box flexDirection="row">
                <Text fg={colors.textDim}>{t("Type")}: </Text>
                <Text fg={colors.text}>{instrumentType}</Text>
              </Box>
            )}
            {sector && (
              <Box flexDirection="row">
                <Text fg={colors.textDim}>{t("Sector")}: </Text>
                <Text fg={colors.text}>{sector}</Text>
              </Box>
            )}
            {industry && (
              <Box flexDirection="row">
                <Text fg={colors.textDim}>{t("Industry")}: </Text>
                <Text fg={colors.text}>{industry}</Text>
              </Box>
            )}
          </Box>
        )}

        {/* ISIN */}
        {ticker.metadata.isin && (
          <Box flexDirection="row" height={1}>
            <Text fg={colors.textDim}>{t("ISIN")}: </Text>
            <Text fg={colors.text}>{ticker.metadata.isin}</Text>
          </Box>
        )}

        {/* Description — last, collapsed */}
        {description && (
          <Box flexDirection="column" width={contentWidth}>
            <SectionHeading title={t("Description")} />
            <Text fg={colors.text} width={contentWidth} wrapMode="word" wrapText>{description}</Text>
          </Box>
        )}
      </Box>
    </ScrollBox>
  );
}
