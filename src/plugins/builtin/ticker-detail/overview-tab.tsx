import { TrendingSummary } from "../attention/trending";
import { fundFactOverviewFields } from "../sec/fund-facts";
import { useFundFacts } from "../sec/fund-facts-view";
import { resolveTickerInstrumentKind } from "../../../tickers/instrument-kind";
import { mayBeUsEquityOrFundTicker } from "../../../utils/sec";
import { ResearchTradeActions, researchTradeMatches, useResearchTrading } from "../shared/research-trading";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { useCallback, useMemo, type ReactNode } from "react";
import { EmptyState, ExternalLinkText, PaneLinkMenu, PaneStatusBody, SectionHeading, unavailableText, usePaneMenuItems, usePaneNoticeFooter } from "../../../components";
import { CompositeChart, pricePointsToResolvedSeries } from "../../../components/chart/composite";
import { CompanyLogo, resolveCompanyLogoSrc } from "../../../components/company-logo";
import { bodyLineInk, FigureText, figureLineInk, useFigureCells } from "../../../components/ui/figure";
import { PriceReturnStrip } from "../../../components/price-performance";
import { t } from "../../../i18n";
import { useChartQueries, useFxRateObservations, useResolvedEntryValue, useTickerChangeNote, type TickerSnapshotState } from "../../../market-data/hooks";
import { formatMarketPriceWithCurrency, formatSignedMarketPrice, liveQuoteFormatOptions } from "../../../market-data/market/format";
import { priceSeriesUnit } from "../../../market-data/market/index-level";
import {
  exchangeShortName,
  extendedSessionLineLabel,
  getExtendedSessionDisplay,
  getRegularSessionDisplay,
  headlineCloseDate,
  quoteSessionColor,
  quoteSessionLabel,
} from "../../../market-data/market/status";
import { buildPriceReturnFields, headlinePriceReturnEnd, priceReturnDailyWindow, priceReturnIntegrityNotice } from "../../../market-data/performance";
import type { ChartRequest } from "../../../market-data/request-types";
import { buildChartKey } from "../../../market-data/selectors";
import { changeBasisLabel, changeBasisNote, closeDayLabel, futuresQuoteFromSettle, quoteChangeBasis, quoteSettleText } from "../../../market-data/market/change-basis";
import { formatExtendedPrintAsOf } from "../../../market-data/quotes/time";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { quoteObservation } from "../shared/report-freshness";
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
import { canonicalExchange, displayTickerKey, publicTickerKey, resolveExchangeTimeZone } from "../../../utils/exchanges";
import { convertCurrency, displayWidth, formatPercentRaw } from "../../../utils/format";
import {
  appTtmRate, baseCurrencyFiguresNote, enterpriseValueGapIsLarge, enterpriseValueReconciliationNote, trailingEpsFiscalYear, ttmAtAppRate,
  ttmConversionNote, withFinancialEnterpriseValue,
} from "../../../utils/fundamentals";
import { servedRatesNotMeaningful } from "../../../utils/served-rates";
import { atRegularSessionPrice, regularSessionMarketCapitalization } from "../../../market-data/quotes/regular-session-valuation";
import { balanceSheetRateWanted, enterpriseValueBridgeNote, listingEnterpriseValue } from "../../../market-data/quotes/listing-enterprise-value";
import { loadBalanceSheetRate } from "../../../market-data/quotes/balance-sheet-rate";
import { useAsyncResource } from "../../../react/async-resource";
import { zonedDateKey } from "../../../utils/zoned-date-time";
import { sharesOutstandingInReceipts } from "../../../utils/depositary-receipt";
import { isReceiptSide, listingCedearRatio, listingDepositaryPair } from "../../../market-data/depositary-pair";
import {
  CompactRangeBar,
  FundamentalsGrid,
  FunctionLinkRow,
  PositionTable,
  QuoteBook,
  rangeEndpointStyle,
  rangeEndpointWidth,
  rangeRowChrome,
  textGridColumns,
} from "./overview/components";
import { useFuturesContractTerms } from "./overview/futures-contract";
import type { OverviewDividendState } from "./overview/dividend";
import { optionContractFields, useOptionContractRow } from "./overview/option-contract";
import { resolveOptionsTarget } from "../../../utils/options";
import { buildOverviewStats, buildPositionRows, buildProfileFields, FINANCIALS } from "./overview/model";
import { hasStatementFinancials } from "./financials/model";
import type { OverviewFunctionLink, StatField } from "./overview/types";
import type { CryptoMarketAsset } from "../../../api-client/crypto-markets";
import { describeFundamentalMarketCap, marketCapBasisNote } from "../../../utils/market-capitalization";
import { liveFiftyTwoWeekRange } from "../../../market-data/quotes/live-valuation";
import { instrumentTypeLabel } from "../../../tickers/instrument-kind";
import { ClippedText } from "../../../components/ui/display";
import { DelayedMark, delayedMarkWidth, useDelayedMarkMinutes } from "../../../components/ui/delayed-mark";
import { safeExternalUrl } from "../../../utils/external-url";
import { burnsCash, cashRunway, runwayOfferingNote } from "../../../utils/cash-runway";
import { useRunwayOfferings } from "./financials/offerings";
import { taxEquivalentFields, useOverviewTaxEquivalent } from "./overview/tax-equivalent";
import { distributionBasis, type TaxRates } from "../../../market-data/tax-equivalent";
import { currentListingName } from "../../../tickers/listing-name";
import { isYieldIndexSymbol } from "../../../tickers/index-roots";
import { formatBasisPoints } from "../../../utils/basis-points";
import { coinPriceVenueText, quoteStatsBasisText } from "../../../market-data/quotes/export-identity";
import { hiddenOnLogScale, logScaleHiddenWarning } from "../../../time-series/log-scale";
import type { AhPairState } from "./adr-pair/ah";
import {
  autoOverviewChartScale, resolveOverviewChartScale, toggledOverviewChartScale, type OverviewChartScaleChoice,
} from "./overview/chart-scale";

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
  coin?: CryptoMarketAsset | null;
  /** A perpetual contract's own funding and premium, right under its price, given the width of the overview's content. */
  perpetuals?: ReactNode | ((contentWidth: number) => ReactNode);
  /**
   * The perpetual markets on a stock or a coin, one row per venue, given the width of the overview's content.
   * Another market on the security, not its own price: it follows the security's range, chart, returns and
   * figures, so those open the tab.
   */
  perpetualMarkets?: ReactNode | ((contentWidth: number) => ReactNode);
  /** The company's latest news, given the width of the overview's content; it draws nothing while there is none. */
  news?: ReactNode | ((contentWidth: number) => ReactNode);
  width?: number;
  /** The tab's height; a short one keeps fewer futures contract terms. */
  height?: number;
  focused?: boolean;
  ticker: TickerRecord | null;
  financials: TickerFinancials | null;
  beta?: StatField | null;
  /** A click on the price chart opens the full chart. */
  onOpenChart?: () => void;
  /** A click on a figure opens its research function (beta to GR, holders to HDS). */
  onOpenFunction?: (link: OverviewFunctionLink) => void;
  /** Opens a listing's DES (useOpenDescription): an A+H company's other line, from its row. */
  onOpenListing?: (ticker: string) => void;
  /** The history the dividend yield reads (useOverviewDividend): a trailing one's cash, a forward one's lapse; without it the yield stands. */
  dividend?: OverviewDividendState;
  /** An A+H company's other line and how the two prices compare (useAhPair); none for any other listing. */
  ah?: AhPairState | null;
  /** The shares one lot of an HKEX or SGX line trades in (useListingBoardLot); none elsewhere. */
  boardLot?: number | null;
  /** Where the ticker's snapshot load stands (useTickerSnapshotState), for the state shown before anything of it is in. */
  snapshot?: TickerSnapshotState;
  /** The rates `fn DES --tax-rate` set (taxRatesFromSettings): a fund's tax-equivalent yield and muni/Treasury ratio follow its facts. */
  tax?: { rates: TaxRates } | { error: string } | null;
  /** The price chart's value axis as the pane remembers it; auto picks log for a history of a wide range. */
  chartScale?: OverviewChartScaleChoice;
  /** Remembers the choice the pane menu's Log Scale switches to; without it the menu has no such item. */
  onChartScaleChange?: (choice: OverviewChartScaleChoice) => void;
}

/** Nothing of the ticker is in yet: no quote, profile, figures or history. */
function hasNothingToShow(financials: TickerFinancials | null): boolean {
  if (!financials) return true;
  return !financials.quote && !financials.profile && (financials.priceHistory?.length ?? 0) === 0
    && Object.keys(financials.fundamentals ?? {}).length === 0
    && financials.annualStatements.length === 0 && financials.quarterlyStatements.length === 0;
}

export function OverviewTab(props: OverviewTabProps) {
  if (!props.ticker) return <EmptyState title={t("No ticker selected.")} />;
  // Before anything of the ticker is in, the tab says it is loading, or why it could not, rather than standing empty.
  const { snapshot } = props;
  if (snapshot && (snapshot.loading || snapshot.error) && hasNothingToShow(props.financials)) {
    return (
      <PaneStatusBody
        loading={snapshot.loading}
        error={snapshot.loading ? null : snapshot.error}
        subject="overview"
        errorTitle={unavailableText(t("Overview"))}
        retry={{ onRetry: snapshot.retry }}
      />
    );
  }
  return <ResolvedOverviewTab {...props} ticker={props.ticker} />;
}

/** Where a fund's facts open: the ETF function, its facts over its filings. */
const FUND_FACTS_LINK: OverviewFunctionLink = { name: "Fund Facts", templateId: "sec-etf-pane" };

function ResolvedOverviewTab({
  width, height, focused = false, ticker, financials, beta, onOpenChart, onOpenFunction, onOpenListing, perpetuals, perpetualMarkets, news, coin, dividend, ah = null, boardLot = null, tax = null,
  chartScale: chartScaleChoice = "auto", onChartScaleChange,
}: OverviewTabProps & { ticker: TickerRecord }) {
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
  const quoteDelayMinutes = useDelayedMarkMinutes(quote);
  // `fn DES` and a capture are dated by the quote the header shows, as `quote` dates it: its last print,
  // its delay and its session, the time it was read after them.
  useRemoteUiNode(quote ? {
    role: "report-freshness",
    label: "Quote freshness",
    getMetadata: () => ({ observations: [quoteObservation(quote, Date.now())] }),
  } : null);
  const fundamentals = financials?.fundamentals;
  const capitalization = regularSessionMarketCapitalization({ quote, fundamentals });
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
  // A bank's or an insurer's EV reads n/m: its deposits or float are funding, not debt.
  const shownFundamentals = useMemo(
    () => (fundamentals ? ttmAtAppRate(withFinancialEnterpriseValue(fundamentals, profile), ttmRate) : fundamentals),
    [fundamentals, profile, ttmRate?.rate, ttmRate?.asOf],
  );
  const evFinancials = financials && { ...financials, quote, fundamentals: shownFundamentals };
  const { from: sheetCurrency, to: capCurrency, date: sheetDate } = evFinancials ? balanceSheetRateWanted(evFinancials) ?? {} : {};
  const loadEvRate = useCallback(() => sheetCurrency && capCurrency && sheetDate
    ? loadBalanceSheetRate({ from: sheetCurrency, to: capCurrency, date: sheetDate }) : Promise.resolve(null),
  [sheetCurrency, capCurrency, sheetDate]);
  const { data: evRate } = useAsyncResource(sheetDate ? loadEvRate : null);
  const evInputs = evFinancials && (evRate ? { ...evFinancials, balanceSheetRate: evRate } : evFinancials);
  const enterpriseValue = evInputs ? listingEnterpriseValue(evInputs) : undefined;
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
  const instrumentKind = resolveTickerInstrumentKind(ticker, financials);
  const fundFactsSymbol = instrumentKind === "fund" && mayBeUsEquityOrFundTicker(ticker) ? ticker.metadata.ticker : null;
  const fundFactsResource = useFundFacts(fundFactsSymbol);
  const fundFacts = fundFactsResource.data?.payload;
  // With --tax-rate: on the sponsor's SEC yield, else the distribution yield fundamentals states, as `fundamentals` reads it.
  const taxEquivalent = useOverviewTaxEquivalent({
    symbol: ticker.metadata.ticker,
    tax,
    bond: !fundFactsSymbol ? null : fundFacts ? (fundFacts.covered ? fundFacts.bond ?? null : null)
      : fundFactsResource.loading ? undefined : null,
    // A stock, or a fund listed abroad, has no bond figures to read, and says why once its quote says what it is.
    noBondFigures: !financials?.quote ? null : instrumentKind !== "fund" ? "not-a-fund" : !fundFactsSymbol ? "listed-abroad" : null,
    distribution: distributionBasis(financials?.fundamentals?.dividendYield, financials?.fundamentals?.dividendYieldBasis === "trailing" ? "trailing" : "forward"),
  });
  const taxFields = taxEquivalent ? taxEquivalentFields(taxEquivalent) : [];
  // Each figure dated; one older than it looks takes the warning colour, as in ETF.
  const fundFactFields: StatField[] = fundFacts?.covered
    ? fundFactOverviewFields(fundFacts).map(({ warn, ...field }) => ({ ...field, ...(warn ? { valueColor: colors.warning } : {}), link: FUND_FACTS_LINK }))
    : [];

  const contentWidth = Math.max((width || Math.floor(termWidth * 0.5)) - (fractionalViewport ? 2 : 4), 20);
  const chartWidth = contentWidth;
  const yieldIndex = isYieldIndexSymbol(quote?.symbol ?? ticker.metadata.ticker);
  const hasHistory = (financials?.priceHistory?.length ?? 0) > 2;
  const unknownHistoryBasis = hasUnknownBondHistoryBasis(quote, ticker.metadata.assetCategory, financials?.quoteMetadata?.instrumentType);
  const historyQuote = unknownHistoryBasis ? undefined : quote;
  const chartHistory = appendLiveQuotePoint(financials?.priceHistory ?? [], historyQuote);
  // Five years of daily closes, which the Price Return strip measures each horizon on: the chart's bars are weekly.
  const returnInstrument = useMemo(() => instrumentFromTicker(ticker), [ticker]);
  const returnWindowDay = new Date().toISOString().slice(0, 10);
  const dailyReturnsRequest = useMemo<ChartRequest | null>(() => {
    if (!returnInstrument || unknownHistoryBasis || yieldIndex) return null;
    const { start, end } = priceReturnDailyWindow(Date.parse(`${returnWindowDay}T12:00:00Z`));
    return { instrument: returnInstrument, bufferRange: "5Y", granularity: "detail", barSize: "1d", startDate: start, endDate: end };
  }, [returnInstrument, returnWindowDay, unknownHistoryBasis, yieldIndex]);
  const dailyReturnEntries = useChartQueries(dailyReturnsRequest ? [dailyReturnsRequest] : []);
  const dailyReturnBars = useResolvedEntryValue(dailyReturnsRequest ? dailyReturnEntries.get(buildChartKey(dailyReturnsRequest)) ?? null : null);
  const chartDelta = (chartHistory.at(-1)?.close ?? 0) - (chartHistory[0]?.close ?? 0);
  const chartTimeZone = resolveExchangeTimeZone(
    ticker.metadata.exchange || quote?.listingExchangeName || quote?.exchangeName,
  );
  const priceSeries = pricePointsToResolvedSeries(chartHistory, {
    id: `${ticker.metadata.ticker}:price`,
    label: `${displayTickerKey(ticker.metadata.ticker)} ${yieldIndex ? "Yield" : "Price"}`,
    color: priceColor(chartDelta),
    unit: yieldIndex ? "%" : unknownHistoryBasis ? "unknown" : priceSeriesUnit(quoteCurrency, instrumentType, quote?.priceBasis),
    ...(yieldIndex ? { unitGroup: "price:%" } : {}),
    style: "area",
    axis: "right",
    panelId: "price",
    timeBasis: chartTimeZone ? { kind: "market", timeZone: chartTimeZone } : undefined,
  });
  // Each horizon runs from the daily close on its start date to the headline's close, as CMP and `history` measure
  // it; the chart's weekly bars stand in until the daily ones are in. Bars and the quote are dated on the listing's clock.
  const returnVenue = ticker.metadata.exchange || quote?.listingExchangeName || quote?.exchangeName || undefined;
  const performanceFields = yieldIndex ? [] : buildPriceReturnFields(
    dailyReturnBars?.length ? dailyReturnBars : financials?.priceHistory ?? [],
    returnVenue,
    undefined,
    historyQuote ? headlinePriceReturnEnd(historyQuote, returnVenue) : null,
  );
  // Years of history from a few dollars to hundreds read on a log axis, the Chart tab's own, so the early ones do not lie flat.
  const autoChartScale = autoOverviewChartScale(priceSeries.points, { rate: yieldIndex });
  const chartScale = resolveOverviewChartScale(chartScaleChoice, autoChartScale);
  const hiddenOnLog = hasHistory && chartScale === "log"
    ? priceSeries.points.filter((point) => hiddenOnLogScale(point.value)).length : 0;
  usePaneMenuItems("overview:chart-scale", () => hasHistory && onChartScaleChange ? [{
    id: "overview-log-scale",
    label: t("Log Scale"),
    checked: chartScale === "log",
    onSelect: () => onChartScaleChange(toggledOverviewChartScale(chartScaleChoice, autoChartScale)),
  }] : null, [autoChartScale, chartScale, chartScaleChoice, hasHistory, onChartScaleChange]);
  // A provider EV well off market cap + debt - cash, or why a withdrawn one is unavailable, at the
  // regular session price the EV beside it is shown at. A gap of a few percent is the valuation panes' detail.
  const pricedForEnterpriseValue = atRegularSessionPrice({ quote, fundamentals: withFinancialEnterpriseValue(fundamentals, profile) }).fundamentals;
  const bridgeNote = enterpriseValue?.kind === "value" ? enterpriseValueBridgeNote(enterpriseValue) : null;
  const enterpriseValueNote = bridgeNote ?? (enterpriseValueGapIsLarge(pricedForEnterpriseValue)
    ? enterpriseValueReconciliationNote(pricedForEnterpriseValue, undefined, evInputs ?? undefined) : undefined);
  // Months of cash, for a company that burns it, and an offering since its balance sheet that the cash is not in yet.
  const unadjustedRunway = useMemo(() => financials ? cashRunway(financials) : null, [financials]);
  const offerings = useRunwayOfferings(ticker.metadata.ticker, ticker.metadata.exchange,
    burnsCash(unadjustedRunway) ? unadjustedRunway.periodEnd : null);
  const runway = financials && offerings.length ? cashRunway(financials, offerings) : unadjustedRunway;
  const offering = burnsCash(runway) ? runwayOfferingNote(offerings, runway.periodEnd, runway.currency) : null;
  // A converted TTM block names what it was converted from, at the pane's rate and its time.
  const ttmNote = [shownFundamentals?.revenue, shownFundamentals?.netIncome, shownFundamentals?.freeCashFlow].some((value) => value != null)
    ? ttmConversionNote(shownFundamentals) : undefined;
  // A cap shown in the base currency too (7.80T ARS, 5.03B USD) says at what rate, and when it was read.
  const capRateNote = capitalization ? baseCurrencyFiguresNote(capitalization.currency, baseCurrency, fxObservations) : undefined;
  const capBasisNote = marketCapBasisNote(capitalization);
  // FB lists a fund now, and Meta trades as META: said for someone who typed FB meaning the company, as `quote FB` says it.
  const changeNote = useTickerChangeNote(ticker.metadata.ticker, ticker, quote);
  const returnIntegrityNotice = priceReturnIntegrityNotice(performanceFields);
  usePaneNoticeFooter({
    registrationId: "overview-notices",
    notices: [
      ...(changeNote ? [changeNote] : []),
      ...(!quote && financials ? [t("Current quote unavailable. Other research data is still available.")] : []),
      ...(offering ? [offering] : []),
      // A bar with contradictory prices is said only where it leaves a shown return blank: on a chart of years one
      // bar's gap is a hairline that changes no figure, and a return reads only the bars at its ends.
      ...(returnIntegrityNotice ? [returnIntegrityNotice] : []),
      ...(hiddenOnLog > 0 ? [logScaleHiddenWarning(priceSeries.label, hiddenOnLog)] : []),
      ...(enterpriseValueNote ? [enterpriseValueNote] : []),
      ...(ttmNote ? [ttmNote] : []),
      ...(capRateNote ? [capRateNote] : []),
      ...(capBasisNote ? [capBasisNote] : []),
      ...(capitalization?.provenance.kind === "fundamentals"
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
  const moneyOptions = { ...liveQuoteFormatOptions(quote, quote?.currency, ticker.metadata.assetCategory, financials?.quoteMetadata?.instrumentType), yieldIndex };
  // The headline is the regular session, which stops at the close; extended trading is the line below it.
  // A future's move that nothing confirms is measured from its last confirmed settlement, as `quote` reads it.
  const movedQuote = futuresQuoteFromSettle(quote, contractTerms);
  const sessionQuote = getRegularSessionDisplay(movedQuote);
  const extendedQuote = yieldIndex ? null : getExtendedSessionDisplay(quote);
  // A price in cents says what it is per (314.95¢/lb), and the move what it is measured from (vs Fri 16 Oct close).
  const quotePriceText = sessionQuote
    ? `${yieldIndex ? `${t("Yield")} ` : ""}${formatMarketPriceWithCurrency(sessionQuote.price, quote?.currency, moneyOptions)}${futuresPricePer(contractTerms, quote?.currency)}` : "";
  // Nor a move: the close it ended on is where it stays.
  const quoteChangeText = sessionQuote && !delisted
    ? yieldIndex && sessionQuote.change != null ? formatBasisPoints(sessionQuote.change, 1) : formatSignedMarketPrice(sessionQuote.change, moneyOptions)
    : "";
  const quotePercentText = sessionQuote && !delisted && !yieldIndex ? `(${formatPercentRaw(sessionQuote.changePercent)})` : "";
  const changeBasis = delisted ? null : quoteChangeBasis(movedQuote, { terms: contractTerms });
  // Once the session is over the headline is its close, dated apart from the extended print below it:
  // "Tue 17 Nov close · vs Mon 16 Nov close". A future's settle is dated on its own line.
  const closeDate = contractTerms ? null : headlineCloseDate(movedQuote);
  const changeBasisText = [
    closeDate ? closeDayLabel(closeDate) : "",
    changeBasis ? changeBasisLabel(changeBasis) : "",
  ].filter(Boolean).join(" \u00b7 ");
  // The days the venue was closed since that close, under the move: "HKEX closed Mon 19 Oct, holiday".
  const changeBasisNoteText = changeBasisNote(changeBasis);
  // The pane title already names the ticker, so the line leads with the company and drops a name that only repeats it.
  // The listing's own quote names it first: BA on LSE is BAE Systems, whatever name a search gave the row it was saved from.
  const companyName = currentListingName(ticker, quote) ?? "";
  // A coin's price says where it is from and when, where a listing names its venue: the crypto venue's own code
  // would tell a reader nothing about whose price it is.
  const coinVenue = instrumentKind === "crypto" ? coinPriceVenueText(quote) : "";
  const shownVenue = coinVenue || listingVenue;
  const venueText = shownVenue ? (companyName ? ` (${shownVenue})` : shownVenue) : "";
  const sessionLabel = quoteSessionLabel(quote);
  const marketStateText = sessionLabel ? t(sessionLabel) : "";
  // Signed out or free, the headline price is the delayed one. The status bar says so for the
  // app; where it is hidden, or in a capture of the pane alone, the mark says so after the session.
  // A coin's venue already says when its price is held back.
  const delayMinutes = sessionQuote && !coinVenue ? quoteDelayMinutes : null;
  const delayCells = delayMinutes != null ? delayedMarkWidth(delayMinutes, nativePaneChrome === true) + 1 : 0;
  const hasIdentityLine = Boolean(companyName || venueText || marketStateText || delayMinutes != null);
  // The desktop logo is a square from the top of the company name's capitals down to the
  // price's baseline, so its edges meet the text's and the three read as one block. The
  // extended-hours line hangs below, as it comes and goes with the session. Without a
  // price the logo keeps two rows.
  const hasLogo = nativePaneChrome === true
    && resolveCompanyLogoSrc({ symbol: ticker.metadata.ticker, assetCategory: ticker.metadata.assetCategory, exchange: ticker.metadata.exchange }) != null;
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
  const settleText = contractTerms ? quoteSettleText(movedQuote, contractTerms) : "";
  const settleRoom = Math.max(1, quoteTextWidth - displayWidth(settleLabel) - 1);
  // European gas beside Henry Hub: "≈ $30.832/MMBtu at EUR/USD 1.1650", at the app's rate, a conversion that says so.
  const inUsdLabel = t("In USD");
  const gasCurrency = quote?.currency?.trim().toUpperCase() ?? "";
  const gasUsdPerUnit = gasCurrency ? convertCurrency(1, gasCurrency, "USD", exchangeRates) : Number.NaN;
  const gasInUsd = sessionQuote && gasCurrency ? usdPerMmbtu(sessionQuote.price, contractTerms, gasCurrency, gasUsdPerUnit) : null;
  const inUsdText = gasInUsd != null ? usdPerMmbtuText({ value: gasInUsd, currency: gasCurrency, usdPerUnit: gasUsdPerUnit }) : "";
  const inUsdRoom = Math.max(1, quoteTextWidth - displayWidth(inUsdLabel) - 1);
  // The extended session's line keeps its label and price whole on a narrow pane: the move gives
  // way to its percent, then goes, rather than wrapping a figure across two lines ("(+0." / "08%)").
  // The extended print says when it was observed (After-Hours 00:10 UTC), as the close above says its day.
  const extendedTime = extendedQuote ? formatExtendedPrintAsOf(quote) : null;
  const extendedLabelText = extendedQuote
    ? `${extendedSessionLineLabel(extendedQuote, t)}${extendedTime ? ` ${extendedTime}` : ""}:`
    : "";
  const extendedPriceText = extendedQuote ? formatMarketPriceWithCurrency(extendedQuote.price, quote?.currency, moneyOptions) : "";
  const extendedMoveText = extendedQuote
    ? [
      `${formatSignedMarketPrice(extendedQuote.change, moneyOptions)} (${formatPercentRaw(extendedQuote.changePercent)})`,
      formatPercentRaw(extendedQuote.changePercent),
    ].find((move) => displayWidth(extendedLabelText) + 2 + displayWidth(extendedPriceText) + 2 + displayWidth(move) <= quoteTextWidth) ?? ""
    : "";
  const quoteChangeCells = delisted ? 0 : figureCells(quoteChangeText, "sub") + (quotePercentText ? 1 + figureCells(quotePercentText, "sub") : 0);
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
  const nseRange = !delisted && quote && canonicalExchange(returnVenue) === "NSE";
  const rangeDay = nseRange ? quote.dayRangeSessionDate : null;
  const sessionRange = nseRange && quote.dayRangeBasis === "daily-bar";
  const rangeBasis = sessionRange ? t("Session Range") : rangeDay ? t("Quote Range") : null;
  const dayRangeLabel = delisted ? t("Last Session") : rangeBasis ?? t("Day Range");
  const yearRangeLabel = t("52W Range");
  const rangeLabelWidth = Math.max(
    hasDayRange ? displayWidth(dayRangeLabel) : 0,
    yearRange ? displayWidth(yearRangeLabel) : 0,
  );
  // Both ranges share one endpoint width, so stacked tracks start and end in the same column.
  const rangeValues: Array<[number, number]> = [
    ...(hasDayRange ? [[quote.low!, quote.high!] as [number, number]] : []),
    ...(yearRange ? [[yearRange.low, yearRange.high] as [number, number]] : []),
  ];
  const rangePriceCells = rangeEndpointWidth(rangeValues, quoteCurrency, moneyOptions);
  const rangeHalfWidth = Math.floor((contentWidth - RANGE_PAIR_GAP) / 2);
  const rangeInline = hasDayRange && yearRange != null
    && rangeHalfWidth - rangeRowChrome(rangeLabelWidth, rangePriceCells) >= RANGE_INLINE_MIN_TRACK;
  const rangeWidth = rangeInline ? rangeHalfWidth : contentWidth;
  // A pane too narrow for both priced ends beside a track writes them compact, both ranges alike.
  const rangeShortLabelWidth = Math.max(hasDayRange ? displayWidth(delisted ? t("Last") : t("Day")) : 0, yearRange ? displayWidth(t("52W")) : 0);
  const rangeEndpoints = rangeEndpointStyle(rangeWidth, rangeShortLabelWidth, rangePriceCells);
  const rangeEndpointCells = rangeEndpoints === "price" ? rangePriceCells
    : rangeEndpointWidth(rangeValues, quoteCurrency, moneyOptions, rangeEndpoints);
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
    ahPair: ah ? { other: ah.side === "h" ? ah.pair.a : ah.pair.h, side: ah.side, premiumPercent: ah.comparison?.premiumPercent ?? null } : null,
    quote,
    fundamentals: shownFundamentals,
    coin,
    financialCurrency: financials?.financialCurrency,
    statementFinancials: financials,
    quoteCurrency,
    baseCurrency,
    toBase,
    marketCapExchangeRates: exchangeRates,
    enterpriseValue,
    nextEarnings: financials?.nextEarnings,
    depositaryReceipt: sharesOutstandingInReceipts(quote, fundamentals, description),
    depositaryPair: depositaryPair ? { pair: depositaryPair, receiptSide: isReceiptSide(financials) } : null,
    cedearRatio: listingCedearRatio(financials),
    boardLot,
    // Report and ex-dividend dates are the listing's calendar days.
    today: zonedDateKey(Date.now(), chartTimeZone ?? "America/New_York"),
    dividend,
    bond: fundFacts?.bond ?? null,
    runway,
    trailingEpsYear: financials ? trailingEpsFiscalYear(financials) : undefined,
    notMeaningful: servedRatesNotMeaningful(shownFundamentals, financials),
  });
  const profileFields = buildProfileFields({
    // The contract section names an option's type.
    instrumentType: optionFields.length > 0 ? undefined : instrumentTypeLabel(instrumentType, quote?.name || ticker.metadata.name),
    sector,
    industry,
    profile,
    isin: ticker.metadata.isin,
  });
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
              exchange={ticker.metadata.exchange}
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
                    {quotePercentText && <FigureText part="sub" change={sessionQuote.change}>{quotePercentText}</FigureText>}
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
              <Box flexDirection="row" gap={2} minWidth={0} overflow="hidden">
                <Text flexShrink={0} fg={colors.textDim}>{extendedLabelText}</Text>
                <Text flexShrink={0} fg={priceColor(extendedQuote.change ?? 0)}>{extendedPriceText}</Text>
                {extendedMoveText ? <Text flexShrink={0} fg={priceColor(extendedQuote.change ?? 0)}>{extendedMoveText}</Text> : null}
              </Box>
            )}
            {settleText && (
              <Box flexDirection="row" gap={1} minWidth={0} overflow="hidden">
                <Text flexShrink={0} fg={colors.textDim}>{settleLabel}</Text>
                <ClippedText fg={colors.text} text={settleText} width={settleRoom} />
              </Box>
            )}
            {inUsdText && (
              <Box flexDirection="row" gap={1} minWidth={0} overflow="hidden">
                <Text flexShrink={0} fg={colors.textDim}>{inUsdLabel}</Text>
                <ClippedText fg={colors.textDim} text={inUsdText} width={inUsdRoom} />
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
                note={rangeDay ?? (quoteStatsBasisText(quote) || undefined)}
                shortLabel={delisted ? t("Last") : sessionRange ? t("Session") : rangeDay ? t("Quote") : t("Day")}
                labelWidth={rangeLabelWidth}
                endpointWidth={rangeEndpointCells}
                width={rangeWidth}
                grow={rangeInline}
                currency={quoteCurrency}
                priceOptions={moneyOptions}
                endpoints={rangeEndpoints}
              />
            )}
            {yearRange && (
              <CompactRangeBar
                current={sessionQuote?.price ?? quote.price}
                low={yearRange.low}
                high={yearRange.high}
                label={yearRangeLabel}
                shortLabel={t("52W")}
                // A range the service read from the stored daily bars, the source's being no year's, says so.
                note={quote.yearRangeBasis === "daily-bars" ? t("daily bars") : undefined}
                labelWidth={rangeLabelWidth}
                endpointWidth={rangeEndpointCells}
                width={rangeWidth}
                grow={rangeInline}
                currency={quoteCurrency}
                priceOptions={moneyOptions}
                endpoints={rangeEndpoints}
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
              panels={[{ id: "price", scale: chartScale }]}
              levels={trade && researchTradeMatches(trade, instrumentFromTicker(ticker)) ? { seriesId: priceSeries.id, items: trade.levels } : undefined}
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

        {(stats.length > 0 || beta) && (
          <Box flexDirection="column">
            <SectionHeading title={t("Fundamentals")} />
            <PaneLinkMenu>
              <FundamentalsGrid fields={stats} width={contentWidth} onOpenLink={onOpenFunction} onOpenListing={onOpenListing} />
              {beta && <FundamentalsGrid fields={[beta]} columns={1} width={contentWidth} onOpenLink={onOpenFunction} />}
              {/* The statements behind the figures, for a company that has them. */}
              {onOpenFunction && hasStatementFinancials(financials) ? <FunctionLinkRow link={FINANCIALS} onOpen={onOpenFunction} /> : null}
            </PaneLinkMenu>
          </Box>
        )}

        {taxFields.length > 0 && (
          <Box flexDirection="column">
            <SectionHeading title={t("Tax-Equivalent Yield")} />
            <FundamentalsGrid fields={taxFields} width={contentWidth} />
          </Box>
        )}

        {perpetualMarkets && <PaneLinkMenu>{typeof perpetualMarkets === "function" ? perpetualMarkets(contentWidth) : perpetualMarkets}</PaneLinkMenu>}

        {positionRows.length > 0 && (
          <Box flexDirection="column">
            <SectionHeading title={t("Positions")} />
            <PositionTable rows={positionRows} width={contentWidth} />
          </Box>
        )}

        {trade?.orders?.(contentWidth)}

        {typeof news === "function" ? news(contentWidth) : news}

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
