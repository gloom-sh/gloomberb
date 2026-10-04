import { TrendingSummary } from "../attention/trending";
import { EmptyState, PaneLinkMenu, SectionHeading, usePaneNoticeFooter } from "../../../components";
import { CompositeChart, pricePointsToResolvedSeries } from "../../../components/chart/composite";
import { CompanyLogo, resolveCompanyLogoSrc } from "../../../components/company-logo";
import { bodyLineInk, FigureText, figureLineInk, useFigureCells } from "../../../components/ui/figure";
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
import { Box, ScrollBox, Text, useUiCapabilities } from "../../../ui";
import { publicTickerKey, resolveExchangeTimeZone } from "../../../utils/exchanges";
import { convertCurrency, displayWidth, formatPercentRaw, truncateToDisplayWidth } from "../../../utils/format";
import { zonedDateKey } from "../../../utils/zoned-date-time";
import {
  CompactRangeBar,
  FundamentalsGrid,
  PositionTable,
  QuoteBook,
  rangeEndpointWidth,
  rangeRowChrome,
  textGridColumns,
} from "./overview/components";
import { buildOverviewStats, buildPositionRows, buildProfileFields } from "./overview/model";
import type { OverviewFunctionLink } from "./overview/types";
import { describeFundamentalMarketCap } from "../../../utils/market-capitalization";
import { liveFiftyTwoWeekRange, liveMarketCapitalization } from "../portfolio-list/live-valuation";

/** Cells between the Day and 52W ranges when they share a row. */
const RANGE_PAIR_GAP = 4;
/** Shortest track that still reads as a range; below it the two ranges stack. */
const RANGE_INLINE_MIN_TRACK = 10;
/** Desktop px between the logo and the name and price beside it. */
const LOGO_GAP_PX = 6;

interface OverviewTabProps {
  width?: number;
  focused?: boolean;
  ticker: TickerRecord | null;
  financials: TickerFinancials | null;
  /** A click on the price chart opens the full chart. */
  onOpenChart?: () => void;
  /** A click on a figure opens its research function (beta to GR, holders to HDS). */
  onOpenFunction?: (link: OverviewFunctionLink) => void;
}

export function OverviewTab(props: OverviewTabProps) {
  if (!props.ticker) return <EmptyState title={t("No ticker selected.")} />;
  return <ResolvedOverviewTab {...props} ticker={props.ticker} />;
}

function ResolvedOverviewTab({ width, focused = false, ticker, financials, onOpenChart, onOpenFunction }: OverviewTabProps & { ticker: TickerRecord }) {
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const { width: termWidth } = useViewport();
  const { fractionalViewport = false, nativePaneChrome, cellWidthPx = 8, cellHeightPx = 18, pixelRatio = 1 } = useUiCapabilities();
  const figureCells = useFigureCells();

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
  const quoteCurrency = quote?.currency || ticker.metadata.currency || baseCurrency;
  const toBase = (value: number, fromCurrency: string) =>
    convertCurrency(value, fromCurrency, baseCurrency, exchangeRates);
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
  // The pane title already names the ticker, so the line leads with the company and drops a name that only repeats it.
  const companyName = [ticker.metadata.name, quote?.name].find((name) => name && name !== ticker.metadata.ticker) ?? "";
  const venueText = listingVenue ? (companyName ? ` (${listingVenue})` : listingVenue) : "";
  const marketStateText = quote?.marketState ? t(marketStateLabel(quote.marketState)) : "";
  const hasIdentityLine = Boolean(companyName || venueText || marketStateText);
  // The desktop logo is a square from the top of the company name's capitals down to the
  // price's baseline, so its edges meet the text's and the three read as one block. The
  // extended-hours line hangs below, as it comes and goes with the session. Without a
  // price the logo keeps two rows.
  const hasLogo = nativePaneChrome === true
    && resolveCompanyLogoSrc({ symbol: ticker.metadata.ticker, assetCategory: ticker.metadata.assetCategory }) != null;
  const priceInk = figureLineInk();
  // The top snaps up to a whole px so it never starts below the capitals; the bottom lands
  // on the device pixel nearest the baseline.
  const logoTopPx = quote ? Math.floor(hasIdentityLine ? bodyLineInk(cellHeightPx).capTop : priceInk.capTop) : 0;
  const logoBottomPx = Math.round(((hasIdentityLine ? cellHeightPx : 0) + priceInk.baseline) * pixelRatio) / pixelRatio;
  const logoPx = quote ? logoBottomPx - logoTopPx : cellHeightPx * 2;
  const logoCells = hasLogo ? Math.ceil((logoPx + LOGO_GAP_PX) / cellWidthPx) : 0;
  const quoteTextWidth = Math.max(1, quoteSummaryWidth - logoCells);
  const quoteChangeCells = figureCells(quoteChangeText, "sub") + 1 + figureCells(quotePercentText, "sub");
  const stackQuoteChange = quoteChangeCells > quoteTextWidth;
  const stackQuoteSummary = figureCells(quotePriceText) + 2 + quoteChangeCells > quoteTextWidth;
  const companyNameWidth = Math.max(8, quoteTextWidth
    - displayWidth(venueText)
    - (marketStateText ? displayWidth(marketStateText) + 1 : 0));
  const hasDayRange = quote?.low != null && quote?.high != null && quote.high > quote.low;
  const yearRange = liveFiftyTwoWeekRange(quote);
  const dayRangeLabel = t("Day Range");
  const yearRangeLabel = t("52W Range");
  const rangeLabelWidth = Math.max(
    hasDayRange ? displayWidth(dayRangeLabel) : 0,
    yearRange ? displayWidth(yearRangeLabel) : 0,
  );
  // Both ranges share one endpoint width, so stacked tracks start and end in the same column.
  const rangeEndpointCells = rangeEndpointWidth([
    ...(hasDayRange ? [quote.low!, quote.high!] : []),
    ...(yearRange ? [yearRange.low, yearRange.high] : []),
  ], quoteCurrency, moneyOptions);
  const rangeHalfWidth = Math.floor((contentWidth - RANGE_PAIR_GAP) / 2);
  const rangeInline = hasDayRange && yearRange != null
    && rangeHalfWidth - rangeRowChrome(rangeLabelWidth, rangeEndpointCells) >= RANGE_INLINE_MIN_TRACK;
  const rangeWidth = rangeInline ? rangeHalfWidth : contentWidth;
  const stats = buildOverviewStats({
    quote,
    fundamentals,
    quoteCurrency,
    baseCurrency,
    toBase,
    marketCapExchangeRates: exchangeRates,
    nextEarnings: financials?.nextEarnings,
    // Report and ex-dividend dates are the listing's calendar days.
    today: zonedDateKey(Date.now(), chartTimeZone ?? "America/New_York"),
  });
  const profileFields = buildProfileFields({
    instrumentType,
    sector,
    industry,
    profile,
    isin: ticker.metadata.isin,
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
      <Box
        flexDirection="column"
        paddingX={1}
        paddingBottom={1}
        gap={1}
        // On the desktop the header keeps half a row clear of the tab bar's edge.
        style={nativePaneChrome ? { paddingTop: Math.round(cellHeightPx / 2) } : undefined}
      >
        <Box flexDirection={quoteBookInline ? "row" : "column"} gap={quoteBookInline ? 2 : 0} width={contentWidth}>
          <Box flexDirection="row" width={quoteSummaryWidth} flexShrink={0} minWidth={0} overflow="hidden">
            <CompanyLogo
              symbol={ticker.metadata.ticker}
              assetCategory={ticker.metadata.assetCategory}
              name={ticker.metadata.name || quote?.name}
              width={logoPx / cellWidthPx}
              height={logoPx / cellHeightPx}
              style={{ marginTop: logoTopPx, marginRight: LOGO_GAP_PX }}
            />
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
            {hasIdentityLine && (
              <Box flexDirection="row" minWidth={0} overflow="hidden">
                {companyName && (
                  <Text fg={colors.textDim}>{truncateToDisplayWidth(companyName, companyNameWidth)}</Text>
                )}
                {venueText && <Text flexShrink={0} fg={colors.textDim}>{venueText}</Text>}
                {quote?.marketState && (
                  <Text flexShrink={0} fg={marketStateColor(quote.marketState)}>
                    {companyName || venueText ? " " : ""}{marketStateText}
                  </Text>
                )}
              </Box>
            )}

            {quote && (
              <Box
                flexDirection={stackQuoteSummary ? "column" : "row"}
                gap={stackQuoteSummary ? 0 : 2}
                alignItems={stackQuoteSummary ? undefined : "baseline"}
              >
                <FigureText>{quotePriceText}</FigureText>
                <Box flexDirection={stackQuoteChange ? "column" : "row"} gap={stackQuoteChange ? 0 : 1}>
                  <FigureText part="sub" change={quote.change}>{quoteChangeText}</FigureText>
                  <FigureText part="sub" change={quote.change}>{quotePercentText}</FigureText>
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

        {(hasDayRange || yearRange) && quote && (
          <Box flexDirection={rangeInline ? "row" : "column"} gap={rangeInline ? RANGE_PAIR_GAP : 0} width={contentWidth}>
            {hasDayRange && (
              <CompactRangeBar
                current={quote.price}
                low={quote.low!}
                high={quote.high!}
                label={dayRangeLabel}
                shortLabel={t("Day")}
                labelWidth={rangeLabelWidth}
                endpointWidth={rangeEndpointCells}
                width={rangeWidth}
                currency={quoteCurrency}
                priceOptions={moneyOptions}
              />
            )}
            {yearRange && (
              <CompactRangeBar
                current={quote.price}
                low={yearRange.low}
                high={yearRange.high}
                label={yearRangeLabel}
                shortLabel={t("52W")}
                labelWidth={rangeLabelWidth}
                endpointWidth={rangeEndpointCells}
                width={rangeWidth}
                currency={quoteCurrency}
                priceOptions={moneyOptions}
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
            <PaneLinkMenu>
              <FundamentalsGrid fields={stats} width={contentWidth} onOpenLink={onOpenFunction} />
            </PaneLinkMenu>
          </Box>
        )}

        {positionRows.length > 0 && (
          <Box flexDirection="column">
            <SectionHeading title={t("Positions")} />
            <PositionTable rows={positionRows} width={contentWidth} />
          </Box>
        )}

        {profileFields.length > 0 && (
          <Box flexDirection="column">
            <SectionHeading title={t("Profile")} />
            <PaneLinkMenu>
              <FundamentalsGrid fields={profileFields} width={contentWidth} columns={textGridColumns(profileFields, contentWidth)} />
            </PaneLinkMenu>
          </Box>
        )}

        <TrendingSummary symbol={publicTickerKey(ticker.metadata.ticker, ticker.metadata.exchange)} onOpen={onOpenFunction ? () => onOpenFunction({ name: "Research attention", templateId: "attention-pane" }) : undefined} />

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
