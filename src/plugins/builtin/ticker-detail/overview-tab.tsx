import { TrendingSummary } from "../attention/trending";
import { fundFactOverviewFields } from "../sec/fund-facts";
import { useFundFacts } from "../sec/fund-facts-view";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";
import { mayBeUsEquityOrFundTicker } from "../../../utils/sec";
import { ResearchTradeActions, researchTradeMatches, useResearchTrading } from "../shared/research-trading";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { useMemo, type ReactNode } from "react";
import { EmptyState, ExternalLinkText, PaneLinkMenu, SectionHeading, usePaneNoticeFooter } from "../../../components";
import { CompositeChart, pricePointsToResolvedSeries } from "../../../components/chart/composite";
import { CompanyLogo, resolveCompanyLogoSrc } from "../../../components/company-logo";
import { bodyLineInk, FigureText, figureLineInk, useFigureCells } from "../../../components/ui/figure";
import { PriceReturnStrip } from "../../../components/price-performance";
import { t } from "../../../i18n";
import { useFxRateObservations } from "../../../market-data/hooks";
import { formatMarketPriceWithCurrency, formatSignedMarketPrice, liveQuoteFormatOptions } from "../../../market-data/market/format";
import { priceSeriesUnit } from "../../../market-data/market/index-level";
import {
  exchangeShortName,
  extendedSessionLineLabel,
  getExtendedSessionDisplay,
  getRegularSessionDisplay,
  quoteSessionColor,
  quoteSessionLabel,
} from "../../../market-data/market/status";
import { appendQuoteToPriceReturnHistory, buildPriceReturnFields } from "../../../market-data/performance";
import { changeBasisLabel, changeBasisNote, quoteChangeBasis, quoteSettleText } from "../../../market-data/market/change-basis";
import {
  fitFuturesContractLines, futuresContractLines, isFuturesInstrument, futuresPricePer, usdPerMmbtu, usdPerMmbtuText,
  type FuturesContractLine,
} from "../../../market-data/futures-contract";
import { useViewport } from "../../../react/input";
import { useAppSelector } from "../../../state/app/context";
import { colors, priceColor } from "../../../theme/colors";
import { appendLiveQuotePoint, hasUnknownBondHistoryBasis } from "../../../time-series/chart-data";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import { Box, ScrollBox, Text, useUiCapabilities } from "../../../ui";
import { publicTickerKey, resolveExchangeTimeZone } from "../../../utils/exchanges";
import { convertCurrency, displayWidth, formatPercentRaw, truncateToDisplayWidth } from "../../../utils/format";
import { appTtmRate, enterpriseValueReconciliationNote, ttmAtAppRate, ttmConversionNote } from "../../../utils/fundamentals";
import { atRegularSessionPrice } from "../../../market-data/quotes/regular-session-valuation";
import { zonedDateKey } from "../../../utils/zoned-date-time";
import { sharesOutstandingInReceipts } from "../../../utils/depositary-receipt";
import { isReceiptSide, listingCedearRatio, listingDepositaryPair } from "../../../market-data/depositary-pair";
import {
  CompactRangeBar,
  FundamentalsGrid,
  PositionTable,
  QuoteBook,
  rangeEndpointWidth,
  rangeRowChrome,
  textGridColumns,
} from "./overview/components";
import { useFuturesContractTerms } from "./overview/futures-contract";
import type { OverviewDividendState } from "./overview/dividend";
import { optionContractFields, useOptionContractRow } from "./overview/option-contract";
import { resolveOptionsTarget } from "../../../utils/options";
import { buildOverviewStats, buildPositionRows, buildProfileFields } from "./overview/model";
import type { OverviewFunctionLink, StatField } from "./overview/types";
import { describeFundamentalMarketCap } from "../../../utils/market-capitalization";
import { liveFiftyTwoWeekRange, liveMarketCapitalization } from "../../../market-data/quotes/live-valuation";
import { instrumentTypeLabel } from "../../../tickers/instrument-kind";
import { ClippedText } from "../../../components/ui/display";
import { DelayedMark, delayedMarkWidth } from "../../../components/ui/delayed-mark";
import { useFreeQuoteDelay } from "../../../api-client/plan-access";
import { safeExternalUrl } from "../../../utils/external-url";
import { cashRunway, SHORT_RUNWAY_HISTORY } from "../../../utils/cash-runway";
import { useOfferingNote } from "./financials/offerings";

/** Cells between the Day and 52W ranges when they share a row. */
const RANGE_PAIR_GAP = 4;
/** Shortest track that still reads as a range; below it the two ranges stack. */
const RANGE_INLINE_MIN_TRACK = 10;
/** Desktop px between the logo and the name and price beside it. */
const LOGO_GAP_PX = 6;

/**
 * Grid rows a futures Contract block may take. It sits above the chart, so a
 * short pane keeps the chart in view by dropping the least useful terms.
 */
function contractRowBudget(height: number | undefined): number {
  if (height == null || height >= 32) return Number.POSITIVE_INFINITY;
  return height >= 24 ? 3 : 2;
}

function contractField(line: FuturesContractLine): StatField {
  return { label: line.label, value: line.value, ...(line.warning ? { valueColor: colors.warning } : {}) };
}

interface OverviewTabProps {
  /** The contracts on the security, given the width of the overview's content. */
  perpetuals?: ReactNode | ((contentWidth: number) => ReactNode);
  width?: number;
  /** The tab's height; a short one keeps fewer futures contract terms. */
  height?: number;
  focused?: boolean;
  ticker: TickerRecord | null;
  financials: TickerFinancials | null;
  /** A click on the price chart opens the full chart. */
  onOpenChart?: () => void;
  /** A click on a figure opens its research function (beta to GR, holders to HDS). */
  onOpenFunction?: (link: OverviewFunctionLink) => void;
  /** The history the dividend yield reads (useOverviewDividend): a trailing one's cash, a forward one's lapse; without it the yield stands. */
  dividend?: OverviewDividendState;
}

export function OverviewTab(props: OverviewTabProps) {
  if (!props.ticker) return <EmptyState title={t("No ticker selected.")} />;
  return <ResolvedOverviewTab {...props} ticker={props.ticker} />;
}

/** Where a fund's facts open: the ETF function, its facts over its filings. */
const FUND_FACTS_LINK: OverviewFunctionLink = { name: "Fund Facts", templateId: "sec-etf-pane" };

function ResolvedOverviewTab({ width, height, focused = false, ticker, financials, onOpenChart, onOpenFunction, perpetuals, dividend }: OverviewTabProps & { ticker: TickerRecord }) {
  const trade = useResearchTrading();
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const portfolios = useAppSelector((state) => state.config.portfolios);
  const brokerInstances = useAppSelector((state) => state.config.brokerInstances);
  const brokerAccounts = useAppSelector((state) => state.brokerAccounts);
  const accountNames = useMemo(
    () => ({ portfolios, brokerInstances, brokerAccounts }),
    [brokerAccounts, brokerInstances, portfolios],
  );
  const { width: termWidth } = useViewport();
  const { fractionalViewport = false, nativePaneChrome, cellWidthPx = 8, cellHeightPx = 18, pixelRatio = 1 } = useUiCapabilities();
  const figureCells = useFigureCells();

  const quote = financials?.quote;
  const quoteDelayMinutes = useFreeQuoteDelay(quote);
  const fundamentals = financials?.fundamentals;
  const capitalization = liveMarketCapitalization(quote, fundamentals);
  const profile = financials?.profile;
  const instrumentType = quote?.instrumentType?.trim()
    || financials?.quoteMetadata?.instrumentType?.trim()
    || ticker.metadata.assetCategory;
  // A futures symbol's settlement and contract terms load beside the quote, never in its way.
  const futuresSymbol = quote?.symbol || ticker.metadata.ticker;
  const contractTerms = useFuturesContractTerms(isFuturesInstrument(futuresSymbol, instrumentType) ? futuresSymbol : null);
  const optionRow = useOptionContractRow(ticker);
  const fxObservations = useFxRateObservations([
    baseCurrency,
    ticker.metadata.currency,
    quote?.currency,
    capitalization?.currency,
    // A converted TTM block is shown at the pane's own rate, the one `fx` reports.
    fundamentals?.ttmConversion?.from,
    fundamentals?.financialCurrency,
    ...ticker.metadata.positions.map((position) => position.currency),
  ]);
  const exchangeRates = useMemo(
    () => new Map([...fxObservations].map(([currency, observation]) => [currency, observation.rate])),
    [fxObservations],
  );
  const ttmRate = appTtmRate(fundamentals, (currency) => fxObservations.get(currency));
  const shownFundamentals = useMemo(
    () => (fundamentals ? ttmAtAppRate(fundamentals, ttmRate) : fundamentals),
    [fundamentals, ttmRate?.rate, ttmRate?.asOf],
  );
  const quoteCurrency = quote?.currency || ticker.metadata.currency || baseCurrency;
  const toBase = (value: number, fromCurrency: string) =>
    convertCurrency(value, fromCurrency, baseCurrency, exchangeRates);
  const sector = ticker.metadata.sector ?? profile?.sector;
  const industry = ticker.metadata.industry ?? profile?.industry;
  const description = profile?.description?.trim();
  // A description quoted from the fund's issuer or its exchange names where it is from.
  const descriptionSource = description && profile?.descriptionSource?.publisher
    && safeExternalUrl(profile.descriptionSource.url) ? profile.descriptionSource : null;
  const listingVenue = exchangeShortName(
    quote?.tradingExchangeName ?? quote?.listingExchangeName ?? quote?.exchangeName,
    quote?.listingExchangeFullName ?? quote?.fullExchangeName,
  );
  const routingVenue = exchangeShortName(quote?.routingExchangeName, quote?.routingExchangeFullName);
  const metadataParts = [
    routingVenue && routingVenue !== listingVenue ? `route ${routingVenue}` : "",
  ].filter((part) => part.length > 0);

  // A US-listed fund's facts (fee, NAV, premium, net assets) stand where a company's fundamentals would; each opens ETF.
  const fundFactsSymbol = resolveTickerInstrumentKind(ticker, financials) === "fund" && mayBeUsEquityOrFundTicker(ticker) ? ticker.metadata.ticker : null;
  const fundFacts = useFundFacts(fundFactsSymbol).data?.payload;
  // Each figure dated; one older than it looks takes the warning colour, as in ETF.
  const fundFactFields: StatField[] = fundFacts?.covered
    ? fundFactOverviewFields(fundFacts).map(({ warn, ...field }) => ({ ...field, ...(warn ? { valueColor: colors.warning } : {}), link: FUND_FACTS_LINK }))
    : [];

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
    // An index's axis reads in points: ^VIX at 20, never $20.
    unit: unknownHistoryBasis ? "unknown" : priceSeriesUnit(quoteCurrency, instrumentType),
    style: "area",
    axis: "right",
    panelId: "price",
    timeBasis: chartTimeZone ? { kind: "market", timeZone: chartTimeZone } : undefined,
  });
  // A provider EV off market cap + debt - cash, or why a withdrawn one is unavailable, at the
  // regular session price the EV beside it is shown at.
  const enterpriseValueNote = enterpriseValueReconciliationNote(atRegularSessionPrice({ quote, fundamentals }).fundamentals);
  // Months of cash, for a company that burns it, and an offering since its balance sheet that the cash is not in yet.
  const runway = useMemo(() => financials ? cashRunway(financials) : null, [financials]);
  const runwayOfferingNote = useOfferingNote(ticker.metadata.ticker, ticker.metadata.exchange, runway?.periodEnd ?? null, runway?.trailing?.kind === "months");
  // A converted TTM block names what it was converted from, at the pane's rate and its time.
  const ttmNote = [shownFundamentals?.revenue, shownFundamentals?.netIncome, shownFundamentals?.freeCashFlow].some((value) => value != null)
    ? ttmConversionNote(shownFundamentals) : undefined;
  usePaneNoticeFooter({
    registrationId: "overview-notices",
    notices: [
      ...(!quote && financials ? [t("Current quote unavailable. Other research data is still available.")] : []),
      ...(runwayOfferingNote ? [runwayOfferingNote] : []),
      ...(runway?.trailingGap === "short-history" ? [`Runway TTM: ${SHORT_RUNWAY_HISTORY}.`] : []),
      ...(priceSeries.warning ? [priceSeries.warning] : []),
      ...(enterpriseValueNote ? [enterpriseValueNote] : []),
      ...(ttmNote ? [ttmNote] : []),
      ...(capitalization?.provenance.kind === "fundamentals" && !capitalization.live
        ? [`Market cap: ${describeFundamentalMarketCap(capitalization.provenance)}.`] : []),
    ],
    focused,
  });
  // A listing that no longer trades has no book: its quote is its last session's close.
  const delisted = !!quote?.delisting;
  const hasBidAsk = !delisted && (quote?.bid != null || quote?.ask != null);
  const quoteBookInline = hasBidAsk && contentWidth >= 68;
  const quoteBookWidth = quoteBookInline ? Math.min(32, Math.max(24, Math.floor(contentWidth * 0.3))) : Math.min(contentWidth, 32);
  const quoteSummaryWidth = quoteBookInline ? Math.max(20, contentWidth - quoteBookWidth - 2) : contentWidth;
  // Price, change and ranges keep the instrument's decimals on every streamed tick.
  const moneyOptions = liveQuoteFormatOptions(quote, quote?.currency, ticker.metadata.assetCategory, financials?.quoteMetadata?.instrumentType);
  // The headline is the regular session, which stops at the close; extended trading is the line below it.
  const sessionQuote = getRegularSessionDisplay(quote);
  const extendedQuote = getExtendedSessionDisplay(quote);
  // A price in cents says what it is per (314.95¢/lb), and the move what it is measured from (vs Fri 16 Oct close).
  const quotePriceText = sessionQuote
    ? `${formatMarketPriceWithCurrency(sessionQuote.price, quote?.currency, moneyOptions)}${futuresPricePer(contractTerms, quote?.currency)}` : "";
  // Nor a move: the close it ended on is where it stays.
  const quoteChangeText = sessionQuote && !delisted ? formatSignedMarketPrice(sessionQuote.change, moneyOptions) : "";
  const quotePercentText = sessionQuote && !delisted ? `(${formatPercentRaw(sessionQuote.changePercent)})` : "";
  const changeBasis = delisted ? null : quoteChangeBasis(quote, { terms: contractTerms });
  const changeBasisText = changeBasis ? changeBasisLabel(changeBasis) : "";
  // The days the venue was closed since that close, under the move: "HKEX closed Mon 19 Oct, holiday".
  const changeBasisNoteText = changeBasisNote(changeBasis);
  // The pane title already names the ticker, so the line leads with the company and drops a name that only repeats it.
  const companyName = [ticker.metadata.name, quote?.name].find((name) => name && name !== ticker.metadata.ticker) ?? "";
  const venueText = listingVenue ? (companyName ? ` (${listingVenue})` : listingVenue) : "";
  const sessionLabel = quoteSessionLabel(quote);
  const marketStateText = sessionLabel ? t(sessionLabel) : "";
  // Signed out or free, the headline price is the delayed one: the mark says so after the session.
  const delayMinutes = sessionQuote ? quoteDelayMinutes : null;
  const delayCells = delayMinutes != null ? delayedMarkWidth(delayMinutes) + 1 : 0;
  const hasIdentityLine = Boolean(companyName || venueText || marketStateText || delayMinutes != null);
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
  // The exchange settlement, dated by its session: a futures price is its latest trade.
  const settleLabel = t("Settle");
  const settleText = contractTerms
    ? truncateToDisplayWidth(quoteSettleText(quote, contractTerms),
      Math.max(1, quoteTextWidth - displayWidth(settleLabel) - 1))
    : "";
  // European gas beside Henry Hub: "≈ $30.832/MMBtu at EUR/USD 1.1650", at the app's rate, a conversion that says so.
  const inUsdLabel = t("In USD");
  const gasCurrency = quote?.currency?.trim().toUpperCase() ?? "";
  const gasUsdPerUnit = gasCurrency ? convertCurrency(1, gasCurrency, "USD", exchangeRates) : Number.NaN;
  const gasInUsd = sessionQuote && gasCurrency ? usdPerMmbtu(sessionQuote.price, contractTerms, gasCurrency, gasUsdPerUnit) : null;
  const inUsdText = gasInUsd != null
    ? truncateToDisplayWidth(usdPerMmbtuText({ value: gasInUsd, currency: gasCurrency, usdPerUnit: gasUsdPerUnit }),
      Math.max(1, quoteTextWidth - displayWidth(inUsdLabel) - 1))
    : "";
  const quoteChangeCells = delisted ? 0 : figureCells(quoteChangeText, "sub") + 1 + figureCells(quotePercentText, "sub");
  const stackQuoteChange = quoteChangeCells > quoteTextWidth;
  const stackQuoteSummary = figureCells(quotePriceText) + 2 + quoteChangeCells > quoteTextWidth;
  // What the move is from follows it on its line when there is room; otherwise it takes the line
  // under the headline, so a narrow pane never splits the move itself to fit the words.
  const changeBasisInline = !!changeBasisText && (stackQuoteSummary ? 0 : figureCells(quotePriceText) + 2)
    + quoteChangeCells + 1 + displayWidth(changeBasisText) <= quoteTextWidth;
  const companyNameWidth = Math.max(8, quoteTextWidth
    - displayWidth(venueText)
    - (marketStateText ? displayWidth(marketStateText) + 1 : 0)
    - delayCells);
  // A listing that no longer trades keeps its delisting date whole on a narrow pane: the venue gives way, then the name.
  const delistedRoom = quote?.delisting && marketStateText ? quoteTextWidth - displayWidth(marketStateText) - 1 : null;
  const identityVenue = delistedRoom !== null && delistedRoom - displayWidth(venueText) < 8 ? "" : venueText;
  const identityNameWidth = delistedRoom !== null ? delistedRoom - displayWidth(identityVenue) : companyNameWidth;
  const identityName = identityNameWidth >= 4 ? companyName : "";
  const hasDayRange = quote?.low != null && quote?.high != null && quote.high > quote.low;
  const yearRange = liveFiftyTwoWeekRange(quote);
  // A listing that no longer trades: its range is its last session's, years ago perhaps, never today's.
  const dayRangeLabel = delisted ? t("Last Session") : t("Day Range");
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
  const contractLines = contractTerms ? futuresContractLines(contractTerms, futuresSymbol) : [];
  // Columns that keep every term whole; a narrow pane stacks them in one.
  const contractColumns = textGridColumns(contractLines.map(contractField), contentWidth);
  const futuresFields = fitFuturesContractLines(contractLines, contractColumns * contractRowBudget(height)).map(contractField);
  // An option contract states its own terms, and the chain's open interest and IV, where a stock has a profile.
  const optionTarget = resolveOptionsTarget(ticker);
  const optionFields = optionTarget?.isOptionTicker ? optionContractFields(optionTarget, optionRow, quoteCurrency) : [];
  const contractFields = futuresFields.length > 0 ? futuresFields : optionFields;
  const contractGridColumns = futuresFields.length > 0 ? contractColumns : textGridColumns(optionFields, contentWidth);
  const depositaryPair = listingDepositaryPair(financials);
  const stats = buildOverviewStats({
    quote,
    fundamentals: shownFundamentals,
    financialCurrency: financials?.financialCurrency,
    quoteCurrency,
    baseCurrency,
    toBase,
    marketCapExchangeRates: exchangeRates,
    nextEarnings: financials?.nextEarnings,
    depositaryReceipt: sharesOutstandingInReceipts(quote, fundamentals, description),
    depositaryPair: depositaryPair ? { pair: depositaryPair, receiptSide: isReceiptSide(financials) } : null,
    cedearRatio: listingCedearRatio(financials),
    // Report and ex-dividend dates are the listing's calendar days.
    today: zonedDateKey(Date.now(), chartTimeZone ?? "America/New_York"),
    dividend,
    bond: fundFacts?.bond ?? null,
    runway,
  });
  const profileFields = buildProfileFields({
    // The contract section names an option's type.
    instrumentType: optionFields.length > 0 ? undefined : instrumentTypeLabel(instrumentType, quote?.name || ticker.metadata.name),
    sector,
    industry,
    profile,
    isin: ticker.metadata.isin,
  });
  // Bars and the quote are dated on the listing's clock.
  const performanceFields = buildPriceReturnFields(
    appendQuoteToPriceReturnHistory(financials?.priceHistory ?? [], historyQuote),
    ticker.metadata.exchange || quote?.listingExchangeName || quote?.exchangeName || undefined,
  );
  const hasPerformance = performanceFields.some((field) => field.value != null || field.unavailableReason);
  const positionRows = buildPositionRows({
    ticker,
    quote,
    quoteCurrency,
    baseCurrency,
    toBase,
    accountNames,
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
        <Box
          flexDirection={quoteBookInline ? "row" : "column"}
          gap={quoteBookInline && !nativePaneChrome ? 2 : 0}
          width={nativePaneChrome ? undefined : contentWidth}
          style={nativePaneChrome && quoteBookInline ? { columnGap: "2ch" } : undefined}
        >
          <Box
            flexDirection="row"
            width={nativePaneChrome ? undefined : quoteSummaryWidth}
            // On the desktop the summary takes what the book beside it leaves, so the book keeps to the pane's right edge.
            flexGrow={nativePaneChrome && quoteBookInline ? 1 : undefined}
            flexShrink={nativePaneChrome && quoteBookInline ? 1 : 0}
            flexBasis={nativePaneChrome && quoteBookInline ? 0 : undefined}
            minWidth={0}
            overflow="hidden"
          >
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
              <Box flexDirection="row" alignItems="center" minWidth={0} overflow="hidden">
                {identityName && (
                  <ClippedText fg={colors.textDim} text={identityName} width={identityNameWidth} />
                )}
                {identityVenue && <Text flexShrink={0} fg={colors.textDim}>{identityVenue}</Text>}
                {marketStateText && (
                  <Text flexShrink={0} fg={quoteSessionColor(quote)}>
                    {identityName || identityVenue ? " " : ""}{marketStateText}
                  </Text>
                )}
                {delayMinutes != null && (
                  <Box flexShrink={0} paddingLeft={identityName || identityVenue || marketStateText ? 1 : 0}>
                    <DelayedMark minutes={delayMinutes} />
                  </Box>
                )}
              </Box>
            )}

            {sessionQuote && (
              <Box
                flexDirection={stackQuoteSummary ? "column" : "row"}
                gap={stackQuoteSummary ? 0 : 2}
                alignItems={stackQuoteSummary ? undefined : "baseline"}
              >
                <FigureText>{quotePriceText}</FigureText>
                {!delisted && (
                  <Box flexDirection={stackQuoteChange ? "column" : "row"} gap={stackQuoteChange ? 0 : 1}
                    alignItems={changeBasisInline ? "baseline" : undefined}>
                    <FigureText part="sub" change={sessionQuote.change}>{quoteChangeText}</FigureText>
                    <FigureText part="sub" change={sessionQuote.change}>{quotePercentText}</FigureText>
                    {changeBasisInline ? <Text flexShrink={0} fg={colors.textDim}>{changeBasisText}</Text> : null}
                  </Box>
                )}
              </Box>
            )}
            {sessionQuote && changeBasisText && !changeBasisInline ? (
              <Box minWidth={0} overflow="hidden">
                <ClippedText fg={colors.textDim} text={changeBasisText} width={quoteTextWidth} />
              </Box>
            ) : null}
            {sessionQuote && changeBasisNoteText ? (
              <Box minWidth={0} overflow="hidden">
                <ClippedText fg={colors.textDim} text={changeBasisNoteText} width={quoteTextWidth} />
              </Box>
            ) : null}
            {extendedQuote && (
              <Box flexDirection="row" gap={2}>
                <Text fg={colors.textDim}>{extendedSessionLineLabel(extendedQuote, t)}:</Text>
                <Text fg={priceColor(extendedQuote.change ?? 0)}>
                  {formatMarketPriceWithCurrency(extendedQuote.price, quote?.currency, moneyOptions)}
                </Text>
                <Text fg={priceColor(extendedQuote.change ?? 0)}>
                  {formatSignedMarketPrice(extendedQuote.change, moneyOptions)} ({formatPercentRaw(extendedQuote.changePercent)})
                </Text>
              </Box>
            )}
            {settleText && (
              <Box flexDirection="row" gap={1} minWidth={0} overflow="hidden">
                <Text flexShrink={0} fg={colors.textDim}>{settleLabel}</Text>
                <Text fg={colors.text}>{settleText}</Text>
              </Box>
            )}
            {inUsdText && (
              <Box flexDirection="row" gap={1} minWidth={0} overflow="hidden">
                <Text flexShrink={0} fg={colors.textDim}>{inUsdLabel}</Text>
                <Text fg={colors.textDim}>{inUsdText}</Text>
              </Box>
            )}
            {metadataParts.length > 0 && (
              <Text fg={colors.textDim}>{metadataParts.join(" | ")}</Text>
            )}
            </Box>
          </Box>

          {quote && hasBidAsk && (
            <QuoteBook
              quote={quote}
              assetCategory={moneyOptions.assetCategory}
              width={quoteBookWidth}
              // The terminal's 30% of the width between 24 and 32 cells, in characters.
              desktopWidth={quoteBookInline ? "clamp(24ch, 30%, 32ch)" : "min(100%, 32ch)"}
            />
          )}
        </Box>

        {perpetuals && <PaneLinkMenu>{typeof perpetuals === "function" ? perpetuals(contentWidth) : perpetuals}</PaneLinkMenu>}

        {(hasDayRange || yearRange) && quote && (
          <Box flexDirection={rangeInline ? "row" : "column"} gap={rangeInline ? RANGE_PAIR_GAP : 0} width={nativePaneChrome ? undefined : contentWidth}>
            {hasDayRange && (
              <CompactRangeBar
                current={sessionQuote?.price ?? quote.price}
                low={quote.low!}
                high={quote.high!}
                label={dayRangeLabel}
                shortLabel={delisted ? t("Last") : t("Day")}
                labelWidth={rangeLabelWidth}
                endpointWidth={rangeEndpointCells}
                width={rangeWidth}
                grow={rangeInline}
                currency={quoteCurrency}
                priceOptions={moneyOptions}
              />
            )}
            {yearRange && (
              <CompactRangeBar
                current={sessionQuote?.price ?? quote.price}
                low={yearRange.low}
                high={yearRange.high}
                label={yearRangeLabel}
                shortLabel={t("52W")}
                labelWidth={rangeLabelWidth}
                endpointWidth={rangeEndpointCells}
                width={rangeWidth}
                grow={rangeInline}
                currency={quoteCurrency}
                priceOptions={moneyOptions}
              />
            )}
          </Box>
        )}

        {contractFields.length > 0 && (
          <Box flexDirection="column">
            <SectionHeading title={t("Contract")} />
            <FundamentalsGrid fields={contractFields} width={contentWidth} columns={contractGridColumns} />
          </Box>
        )}

        <ResearchTradeActions focused={focused} />
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
              levels={trade && researchTradeMatches(trade, instrumentFromTicker(ticker)) ? { seriesId: priceSeries.id, items: trade.levels } : undefined}
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

        {fundFactFields.length > 0 && (
          <Box flexDirection="column">
            <SectionHeading title={t("Fund Facts")} />
            <PaneLinkMenu>
              <FundamentalsGrid fields={fundFactFields} width={contentWidth} onOpenLink={onOpenFunction} />
            </PaneLinkMenu>
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

        {trade?.orders?.(contentWidth)}

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
          <Box flexDirection="column" width={nativePaneChrome ? undefined : contentWidth}>
            <SectionHeading title={t("Description")} />
            {/* The desktop wraps it at the pane's own width, so it follows a resize to the pixel. */}
            <Text fg={colors.text} width={nativePaneChrome ? undefined : contentWidth} wrapMode="word" wrapText>{description}</Text>
            {descriptionSource && (
              <PaneLinkMenu>
                <Box flexDirection="row" width={nativePaneChrome ? undefined : contentWidth}>
                  <Text flexShrink={0} fg={colors.textDim}>{`${t("Source")}: `}</Text>
                  <ExternalLinkText url={descriptionSource.url} label={descriptionSource.publisher} />
                </Box>
              </PaneLinkMenu>
            )}
          </Box>
        )}
      </Box>
    </ScrollBox>
  );
}
