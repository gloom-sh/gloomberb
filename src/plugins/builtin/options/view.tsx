import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCloudDisplayScope } from "../../../api-client/plan-access";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { usePaneAppConfig, usePaneSettingValue, usePaneTicker, useUpdatePaneSettings } from "../../../state/app/context";
import { colors, priceColor } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { MISSING_VALUE, formatCompact, formatPercentRaw } from "../../../utils/format";
import { formatShortDate } from "../../../utils/datetime-format";
import { formatMarketPrice, formatSignedMarketPrice, liveQuoteFormatOptions } from "../../../market-data/market/format";
import { getRegularSessionDisplay } from "../../../market-data/market/status";
import { chainOptionContract, formatExpDate, formatStrikeLabel, optionContractName, resolveOptionsTarget } from "../../../utils/options";
import {
  expiryIsoDate, findListedExpiry, formatDaysToExpiry, isLiveOptionExpiry, missingExpiryMessage, missingExpiryText, optionExpiryVenue,
  readOptionExpiration,
} from "../../../utils/option-expiry";
import { canonicalTickerKey, displayTickerKey } from "../../../utils/exchanges";
import {
  COIN_OPTIONS_HINT, coinOptionsAlternativesText, isCoinWithoutOptions, isOptionsUnavailableError, listedOptionsAlternative,
  optionsUnavailableDetails, optionsUnavailableHint, optionsUnavailableTitle,
} from "../../../market-data/options-alternatives";
import { useChartQueries, useOptionsQuery, useResolvedEntryValue, useTickerFinancials } from "../../../market-data/hooks";
import { savedCopyEntryAt } from "../../../market-data/coordinator";
import {
  Button,
  DataTableView,
  EmptyState,
  usePaneFooter,
  usePaneMenuItems,
  usePaneNoticeFooter,
  QueryBar,
  Spinner,
  StatGrid,
  statGridColumns,
  statGridRows,
  type StatItem,
  type QueryBarFilter,
  type DataTableVisibleRange,
} from "../../../components";
import { createDataTableCsv } from "../../../components/data-table/export";
import { statGridWithin } from "../../../components/ui/stat-grid";
import { useShortcut } from "../../../react/input";
import { useOptionalDialog, type AlertContext } from "../../../ui/dialog";
import { useLiveQuoteEntries, useQuoteUpdates } from "../../../state/hooks/quote-streaming";
import { buildChartKey } from "../../../market-data/selectors";
import type { ChartRequest } from "../../../market-data/request-types";
import { quoteSubscriptionTargetFromTicker } from "../../../market-data/request-types";
import { usePluginAppActions, usePluginBrokerActions, usePluginTickerActions } from "../../runtime";
import { brokerCanTrade, openTradeTicket } from "../broker-trading/command";
import type { OptionContract } from "../../../types/financials";
import { OPTIONS_CALCULATOR_TEMPLATE_ID } from "../options-calculator/model";
import { buildChainCalcParams, resolveCalcSide } from "./calc-seed";
import { useOptionsCatalogue } from "./expiry-catalogue";
import { calculateOptionGreeks, calculateOptionsSummary, IV_FILLED_DETAIL, IV_FILLED_NOTE, IV_FILLED_SHORT, solveChainVolatilities, type OptionsSummary } from "./analytics";
import {
  DEFAULT_OPTION_FIELD_IDS,
  OPTION_FIELD_DEFS,
  buildStrikeList,
  createOptionColumns,
  fitOptionFieldIds,
  OPTION_COLUMN_DROP_ORDER,
  findNearestStrikeIndex,
  formatIv,
  optionColumnColor,
  renderOptionCell,
  resolveDefaultStrikeTarget,
  resolveOptionFieldIds,
} from "./table";
import type { OptionColumn, OptionFieldId, OptionTableRow, OptionsViewProps } from "./types";
import {
  buildOptionQuoteTargets,
  isRealtimeOptionsChain,
  overlayOptionChainQuotes,
  resolveOptionQuoteCoverage,
  resolveChainRefreshIntervalMs,
} from "./live-quotes";
import { useOptionsAccessFooter } from "./footer";
import { optionExpiryFacts, optionSnapshotFreshness } from "../shared/volatility/option-snapshot";
import { AnalyticsAsOfDialog, analyticsAsOfRows } from "./analytics-as-of";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { signedPositionDirection } from "../../../portfolio/position-metrics";
import { optionMarketReference } from "./market-reference";
import { useOptionsEnrichment } from "./enrichment";
import type { OptionsEnrichmentSnapshot } from "./enrichment-model";
import { optionMid, withQuotesUnderIntrinsicMarked, type OptionSide } from "../shared/volatility";
import type { TickerRecord } from "../../../types/ticker";
import type { TickerFinancials } from "../../../types/financials";
import type { IvStats } from "../iv-history/client";
import { useIvRank } from "../iv-history/rank";
import { useOptionsSessionOpen, useThrottledValue } from "../shared/volatility/live-session";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { optionCarry, optionCostOfSpot } from "./carry";
import {
  formatModelSpotPrice, formatSpotTime, modelSpotExtendedPrint, modelSpotLabel, modelSpotStamp, modelSpotStampVariants, optionModelSpot,
  type OptionModelSpot,
} from "./model-spot";
import { chainOpenInterestAsOf, loadListedOpenInterest, openInterestAsOfLabel, readListedOpenInterest, statedOpenInterestAsOf, volumeSessionLabel } from "./open-interest-as-of";
import { optionQuoteSession } from "../shared/volatility/quote-session";
import { useAsyncResource } from "../../../react/async-resource";
import {
  ALL_STRIKES,
  STRIKE_WINDOW_PRESETS,
  STRIKE_WINDOW_SETTING,
  applyStrikeWindow,
  chainDeltasByStrike,
  resolveStrikeWindow,
  strikeWindowNotice,
  strikeWindowShortLabel,
  strikeWindowValue,
} from "./strike-window";
import { logFailure } from "../../../utils/log-failure";

/** The summary strip and analytics recompute from live quotes at most this often. */
const OPTIONS_SUMMARY_THROTTLE_MS = 1_000;
/** Step the expiry strip; h/l and the arrows do too when no parent tab strip owns them. */
const EXPIRY_PREVIOUS_KEY = "[";
const EXPIRY_NEXT_KEY = "]";
/** Switches the cursor row between its call and its put, as clicking either side does. */
const SIDE_KEY = "x";

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function formatRatio(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? MISSING_VALUE : value.toFixed(2);
}

/** The minimal record the chain needs for a symbol that is bound but not saved in any list. */
function transientTicker(symbol: string, exchange: string, currency: string): TickerRecord {
  return { metadata: { ticker: symbol, exchange, currency, name: symbol, portfolios: [], watchlists: [], positions: [], custom: {}, tags: [] } };
}

/**
 * The underlying's price: the level every strike is read against. A chain
 * priced at a session's close or an extended-session print shows that spot
 * with its stamp (`modelSpotStamp`), and any extended print after it named by
 * its session; the regular session's live price shows its day change. A stale
 * quote stays on screen, muted, while the footer says why.
 */
function spotItem(
  underlying: TickerFinancials | null | undefined,
  assetCategory: string | undefined,
  modelSpot: OptionModelSpot | null,
): StatItem {
  const quote = underlying?.quote;
  if (!quote || !Number.isFinite(quote.price)) return { id: "spot", label: "Spot", value: MISSING_VALUE };
  const options = liveQuoteFormatOptions(quote, quote.currency, assetCategory, underlying?.quoteMetadata?.instrumentType);
  const stamp = modelSpot ? modelSpotStamp(modelSpot) : null;
  if (modelSpot && stamp) {
    const move = modelSpot.basis === "close" ? getRegularSessionDisplay(quote)?.change : quote.change;
    const extended = modelSpotExtendedPrint(quote, modelSpot, (price) => formatMarketPrice(price, options));
    // The band keeps its columns: the extended print, then the stamp's day, give way first.
    const shorter = modelSpotStampVariants(modelSpot);
    return {
      id: "spot",
      label: "Spot",
      value: formatMarketPrice(modelSpot.price, options),
      detail: extended ? `${stamp} · ${extended}` : stamp,
      detailVariants: extended ? [stamp, ...shorter] : shorter,
      color: quote.stale ? colors.textDim : priceColor(Number.isFinite(move) ? move! : 0),
    };
  }
  const change = Number.isFinite(quote.change) ? quote.change : 0;
  return {
    id: "spot",
    label: "Spot",
    value: formatMarketPrice(quote.price, options),
    detail: Number.isFinite(quote.change) && Number.isFinite(quote.changePercent)
      ? `${formatSignedMarketPrice(quote.change, options)} ${formatPercentRaw(quote.changePercent)}` : undefined,
    color: quote.stale ? colors.textDim : priceColor(change),
  };
}

/** The chain's volatility, expected move and flow figures, in the order the stat band reads them. */
function optionsSummaryItems({ spot, summary, enrichment, currency, ivRank }: {
  spot: StatItem;
  summary: OptionsSummary | null;
  enrichment: OptionsEnrichmentSnapshot | null;
  currency: string;
  ivRank?: { stats: IvStats | null } | null;
}): StatItem[] {
  // The chain columns draw an empty IV as a dash; a summary figure reads "--" like its neighbours.
  const iv = (value: number | null | undefined) => value == null || !(value > 0) ? MISSING_VALUE : formatIv(value);
  const whole = (value: number | null | undefined) => value == null ? MISSING_VALUE : String(Math.round(value));
  const rank = ivRank?.stats ?? null;
  const move = (amount: number | null | undefined, percent: number | null | undefined): Pick<StatItem, "value" | "detail"> =>
    amount == null || percent == null ? { value: MISSING_VALUE } : { value: `${amount.toFixed(2)} ${currency}`.trim(), detail: `${percent.toFixed(2)}%` };
  const points = (value: number | null | undefined) => value == null ? null : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}`;
  const skew = points(enrichment?.skew25);
  const slope = points(enrichment?.termSlope);
  const slopeAnnualized = enrichment?.termSlopeAnnualized === true;
  // The selected expiry is the active choice in the bar above, so the slope names only the one it runs to.
  const slopeTo = enrichment?.neighbourExpiration == null ? undefined : `to ${formatExpDate(enrichment.neighbourExpiration)}`;
  // A blank flow figure says why. A contract sent without a count leaves its total unknown, not zero;
  // with every contract counted, a blank ratio has no calls to divide by.
  const uncounted = (count: number, what: string, short: string): Pick<StatItem, "detail" | "detailVariants"> =>
    ({ detail: `${count} ${count === 1 ? "contract" : "contracts"} without ${what}`, detailVariants: [`${count} without ${short}`] });
  const volumeBlank = summary && summary.expirationVolume == null && summary.uncounted.volume
    ? uncounted(summary.uncounted.volume, "a volume count", "volume") : {};
  const putCallVolumeBlank = summary && summary.putCallVolumeRatio == null && summary.expirationVolume != null ? { detail: "no call volume" } : {};
  const putCallOpenInterestBlank = !summary || summary.putCallOpenInterestRatio != null ? {}
    : summary.uncounted.openInterest ? uncounted(summary.uncounted.openInterest, "an OI count", "OI") : { detail: "no call OI" };
  return [
    spot,
    { id: "atm-iv", label: "ATM IV", value: iv(summary?.atmImpliedVolatility) },
    { id: "hv30", label: "HV30", value: iv(summary?.historicalVolatility30d) },
    { id: "iv-hv", label: "IV/HV", value: formatRatio(summary?.impliedHistoricalRatio) },
    ...(ivRank ? [{
      id: "ivr", label: "IVR", value: whole(rank?.rank),
      detail: rank ? `pctl ${whole(rank.percentile)} · ${formatShortDate(rank.date, { year: false, utc: true })}` : undefined,
    }] : []),
    { id: "straddle", label: "Straddle", ...move(enrichment?.expectedMove.straddle, enrichment?.expectedMove.straddlePercent) },
    { id: "sigma", label: "1σ fit", ...move(enrichment?.expectedMove.sigma, enrichment?.expectedMove.sigmaPercent) },
    { id: "skew", label: "Skew", value: skew == null ? MISSING_VALUE : `${skew} pp`, detail: "25d P-C" },
    { id: "slope", label: "Slope", value: slope == null ? MISSING_VALUE : `${slope} ${slopeAnnualized ? "pp/y" : "pp"}`, detail: slopeTo },
    { id: "volume", label: "Volume", value: summary?.expirationVolume == null ? MISSING_VALUE : formatCompact(summary.expirationVolume, { fixedDecimals: true }),
      ...volumeBlank },
    { id: "pc-volume", label: "P/C vol", value: formatRatio(summary?.putCallVolumeRatio), ...putCallVolumeBlank },
    { id: "pc-oi", label: "P/C OI", value: formatRatio(summary?.putCallOpenInterestRatio), ...putCallOpenInterestBlank },
  ];
}

export function OptionsView({ width, height, focused, nestedInTabs = false, ivRank: showIvRank = false }: OptionsViewProps) {
  const { ticker: savedTicker, symbol: boundSymbol, financials } = usePaneTicker();
  // A shared layout binds a bare symbol; without a saved record the chain still has its underlying.
  const fallbackExchange = financials?.quote?.listingExchangeName ?? financials?.quote?.exchangeName ?? "";
  const fallbackCurrency = financials?.quote?.currency ?? "USD";
  const ticker = useMemo(() => savedTicker ?? (boundSymbol ? transientTicker(boundSymbol, fallbackExchange, fallbackCurrency) : null),
    [savedTicker, boundSymbol, fallbackExchange, fallbackCurrency]);
  const { createPaneFromTemplate } = usePluginAppActions();
  const { pinTicker } = usePluginTickerActions();
  const { getBrokerAdapter } = usePluginBrokerActions();
  const appConfig = usePaneAppConfig();
  const liveStreaming = useLiveStreamingSetting();
  // A number from the app, or the date or seconds `fn OMON --expiration` took as text.
  const [seededSetting] = usePaneSettingValue<unknown>("expiration", undefined);
  const [expirationTargetKey] = usePaneSettingValue<string | null>("expirationTargetKey", null);
  const updatePaneSettings = useUpdatePaneSettings();
  const [calcSide, setCalcSide] = useState<OptionSide | null>(null);
  const [strikeIdx, setStrikeIdx] = useState(0);
  const [contractSelection, setContractSelection] = useState<{
    context: string; strike: number; side: OptionSide; contractSymbol: string;
  } | null>(null);
  const [autoScrollVersion, setAutoScrollVersion] = useState(0);
  const [scrollToIndexAlign, setScrollToIndexAlign] = useState<"nearest" | "center">("nearest");
  const [visibleStrikeViewport, setVisibleStrikeViewport] = useState<{
    key: string;
    range: DataTableVisibleRange;
  } | null>(null);
  const userSelectedStrikeRef = useRef(false);
  const target = resolveOptionsTarget(ticker);
  const isOpt = target?.isOptionTicker ?? false;
  const parsed = target?.parsedOption ?? null;
  const effectiveTicker = target?.effectiveTicker ?? "";
  const ivRank = useIvRank(showIvRank ? effectiveTicker : null);
  const effectiveExchange = target?.effectiveExchange ?? "";
  const selectionTargetKey = `${ticker?.metadata.ticker ?? ""}|${target?.cacheKey ?? ""}`;
  const underlyingQuoteTarget = isOpt
    ? effectiveTicker ? { symbol: effectiveTicker, exchange: effectiveExchange, route: "provider" as const } : null
    : quoteSubscriptionTargetFromTicker(ticker, effectiveTicker, "provider");
  // A standalone chain has no parent research pane to subscribe to its stock.
  // Its spot, ATM selection and Greeks must update independently of other panes.
  useQuoteUpdates(underlyingQuoteTarget ? [{
    ...underlyingQuoteTarget, surface: "options", visible: true, selected: true, weight: 100,
  }] : [], { liveStreaming });
  const underlyingFinancials = useTickerFinancials(isOpt ? effectiveTicker : null, null);
  const underlying = isOpt ? underlyingFinancials : financials;
  const underlyingStale = underlying?.quote?.stale === true;
  const spot = underlyingStale ? undefined : underlying?.quote?.price;
  const dividendYield = underlying?.fundamentals?.dividendYield;
  const instrument = target?.instrument ?? null;
  const baseRequest = target
    ? {
      instrument: {
        symbol: effectiveTicker,
        exchange: effectiveExchange,
        brokerId: instrument?.brokerId,
        brokerInstanceId: instrument?.brokerInstanceId,
        instrument,
      },
    }
    : null;
  const dailyHistoryRequest: ChartRequest | null = baseRequest
    ? { instrument: baseRequest.instrument, bufferRange: "1Y", granularity: "resolution", resolution: "1d" } : null;
  const historyEntries = useChartQueries(dailyHistoryRequest ? [dailyHistoryRequest] : []);
  const dailyHistoryEntry = dailyHistoryRequest ? historyEntries.get(buildChartKey(dailyHistoryRequest)) ?? null : null;
  const dailyHistory = useResolvedEntryValue(dailyHistoryEntry);
  const [chainRefreshMinutes] = usePaneSettingValue<string>("chainRefreshMinutes", "");
  const { nativePaneChrome } = useUiCapabilities();
  const [storedOptionFieldIds] = usePaneSettingValue<OptionFieldId[]>("optionColumnIds", DEFAULT_OPTION_FIELD_IDS);
  const optionFieldIds = useMemo(() => resolveOptionFieldIds(storedOptionFieldIds), [storedOptionFieldIds]);
  // The terminal chain keeps both sides on screen, giving up fields to fit (the
  // table's width less its scrollbar); the desktop's table gives up the same
  // fields in the same order as whole columns and names them (OPTION_COLUMN_DROP_ORDER).
  const chainWidth = Math.max(1, width - 3);
  const shownFieldIds = useMemo(() => nativePaneChrome ? optionFieldIds : fitOptionFieldIds(optionFieldIds, chainWidth),
    [chainWidth, nativePaneChrome, optionFieldIds]);
  const [storedStrikeWindow] = usePaneSettingValue<unknown>(STRIKE_WINDOW_SETTING, ALL_STRIKES);
  const strikeWindow = useMemo(() => resolveStrikeWindow(storedStrikeWindow), [storedStrikeWindow]);
  const strikeWindowText = strikeWindowValue(strikeWindow);
  const initialChainEntry = useOptionsQuery(baseRequest);
  const initialChain = useResolvedEntryValue(initialChainEntry);
  // A listing can still carry a date whose last session has closed. The chain
  // never opens there, nor on a saved date that has since passed: it takes the nearest live one.
  const now = Date.now();
  // Expiries close on the listing's clock: a coin's options (Deribit) settle at 08:00 UTC on any day.
  const expiryVenue = optionExpiryVenue(effectiveTicker, effectiveExchange);
  const liveExpiration = (expiration: number) => isLiveOptionExpiry(expiration, now, expiryVenue);
  const listedExpirations = initialChain?.expirationDates ?? [];
  const openingExpirations = listedExpirations.some(liveExpiration) ? listedExpirations.filter(liveExpiration) : listedExpirations;
  const initialExpiration = openingExpirations.length === 0 ? undefined : openingExpirations.reduce((best, expiration) => (
    parsed && Math.abs(expiration - parsed.expTs) < Math.abs(best - parsed.expTs) ? expiration : best
  ), openingExpirations[0]!);
  // A typed date names a day; the catalogue's stamp for that day is the expiry.
  const seededDate = readOptionExpiration(seededSetting);
  const seededListed = seededDate == null ? undefined : findListedExpiry(seededDate, listedExpirations) ?? seededDate;
  const seededExpiration = seededListed != null && (liveExpiration(seededListed) || !openingExpirations.some(liveExpiration))
    ? seededListed : undefined;
  const selectedExpiration = expirationTargetKey == null || expirationTargetKey === selectionTargetKey
    ? seededExpiration ?? initialExpiration : initialExpiration;
  const viewportKey = `${effectiveTicker}:${selectedExpiration ?? "initial"}`;
  const strikeSelectionKey = `${selectionTargetKey}|${selectedExpiration ?? "initial"}`;
  const selectedContract = contractSelection?.context === strikeSelectionKey ? contractSelection : null;
  // In the regular session a real-time chain refetches its snapshot every 15
  // seconds while visible, bypassing the local chain cache; otherwise it keeps
  // the configured cadence. The refresh is gated on visibility by the query.
  const optionsSessionOpen = useOptionsSessionOpen(liveStreaming);
  // The catalogue response carries the account's entitlement for every slice.
  const liveChainEligible = isRealtimeOptionsChain(initialChain);
  const expirationChainEntry = useOptionsQuery(
    baseRequest && selectedExpiration != null
      ? { ...baseRequest, expirationDate: selectedExpiration }
      : null,
    { refreshIntervalMs: resolveChainRefreshIntervalMs(chainRefreshMinutes, liveStreaming && optionsSessionOpen && liveChainEligible) },
  );
  const expirationChain = useResolvedEntryValue(expirationChainEntry);
  // Either query can refresh the expiry catalogue. The selected date remains
  // an identity even when an earlier date disappears or the catalogue reorders.
  const { chain, expirationDates: availableExpirations } = useOptionsCatalogue(
    selectionTargetKey, initialChainEntry, expirationChainEntry,
  );
  const selectedExpirationMissing = selectedExpiration != null && chain != null
    && !availableExpirations.includes(selectedExpiration);
  const matchesSelectedExpiration = (candidate: typeof initialChain) => candidate != null
    && selectedExpiration != null
    && [...candidate.calls, ...candidate.puts].every((contract) => contract.expiration === selectedExpiration);
  const mismatchedExpiration = expirationChain != null && !matchesSelectedExpiration(expirationChain);
  const expirationUnavailable = selectedExpirationMissing || mismatchedExpiration;
  // A provider fallback or an old default-expiry response must not seed the
  // table, export, Greeks or calculator for a different selected contract date.
  const strikeChain = expirationUnavailable ? null : expirationChain
    ?? (matchesSelectedExpiration(initialChain) ? initialChain : null);
  const strikesLoading = strikeChain === null && !expirationUnavailable;
  const expirationDates = useMemo(() => {
    const listed = selectedExpirationMissing
      ? [...availableExpirations, selectedExpiration!].sort((left, right) => left - right) : availableExpirations;
    // A date whose last session has closed has no contracts left to show; the strip leaves it out, unless every date has.
    const current = (expiration: number) => isLiveOptionExpiry(expiration, Date.now(), expiryVenue);
    return listed.some(current) ? listed.filter((expiration) => expiration === selectedExpiration || current(expiration)) : listed;
  }, [availableExpirations, expiryVenue, selectedExpiration, selectedExpirationMissing]);
  // Keep the date strip stable while a mouse press focuses this pane. A new
  // tab list asks the web host to reveal the active tab and can move the date
  // being clicked before mouse-up, cancelling selection of an offscreen expiry.
  const expirationPickRef = useRef<(value: string) => void>(() => {});
  const selectedExpirationIndex = selectedExpiration == null ? -1 : expirationDates.indexOf(selectedExpiration);
  const strikeWindowOptions = useMemo(() => {
    const presets = STRIKE_WINDOW_PRESETS.map(({ value, label, short, description }) => ({ value, label, short, description }));
    // A window typed on the command line that no preset matches still reads on the chip.
    if (presets.some((preset) => preset.value === strikeWindowText)) return presets;
    const label = strikeWindowShortLabel(resolveStrikeWindow(strikeWindowText));
    return [...presets, { value: strikeWindowText, label, short: label, description: "Set from the command line." }];
  }, [strikeWindowText]);
  // The window chip leads: the expiry strip after it can run past the edge of the bar.
  const queryFilters = useMemo<QueryBarFilter[]>(() => [{
    id: "strikes",
    label: "Strikes",
    title: "Strikes",
    value: strikeWindowText,
    // Every strike is the default, so any window narrows the chain and the chip says so.
    defaultValue: ALL_STRIKES,
    options: strikeWindowOptions,
    onChange: (value: string) => updatePaneSettings({ [STRIKE_WINDOW_SETTING]: value }),
  }, {
    id: "expiration",
    label: "Exp",
    inline: true,
    scrolls: true,
    value: String(selectedExpiration),
    // The dates either side name the key that steps to them: a terminal
    // label prefix, a desktop tooltip.
    options: expirationDates.map((ts, index) => ({
      label: formatExpDate(ts),
      value: String(ts),
      hint: selectedExpirationIndex < 0 ? undefined
        : index === selectedExpirationIndex - 1 ? EXPIRY_PREVIOUS_KEY
          : index === selectedExpirationIndex + 1 ? EXPIRY_NEXT_KEY : undefined,
    })),
    onChange: (value: string) => expirationPickRef.current(value),
  }], [expirationDates, selectedExpiration, selectedExpirationIndex, strikeWindowOptions, strikeWindowText, updatePaneSettings]);
  // A scheduled refresh of a chain already on screen is quiet: the in-session
  // cadence would otherwise blink the footer every few seconds.
  const loading = (initialChainEntry?.phase === "loading" || initialChainEntry?.phase === "refreshing") && !chain
    || expirationChainEntry?.phase === "loading"
    || (expirationChainEntry?.phase === "refreshing" && strikeChain === null);
  // Refresh failures keep a ready entry with last-good data and an error.
  // Surface that warning even when the cached chain is still usable.
  // The body names the dates nearest the one asked for; the footer only flags it.
  const unavailableExpiry = expirationUnavailable && selectedExpiration != null
    ? sentenceCase(missingExpiryText(selectedExpiration, availableExpirations)) : null;
  // A chain kept because the refresh could not get through (offline, a timeout) is a saved copy the footer dates,
  // not an error; any other failure stays the error beside the old chain.
  const initialSavedAt = savedCopyEntryAt(initialChainEntry);
  const expirationSavedAt = savedCopyEntryAt(expirationChainEntry);
  const chainSavedAt = initialSavedAt == null ? expirationSavedAt
    : expirationSavedAt == null ? initialSavedAt : Math.min(initialSavedAt, expirationSavedAt);
  const error = (expirationUnavailable ? `Expiry ${expiryIsoDate(selectedExpiration!)} unavailable` : null)
    ?? (initialSavedAt == null ? initialChainEntry?.error?.message : null)
    ?? (expirationSavedAt == null ? expirationChainEntry?.error?.message : null)
    ?? (initialChainEntry?.phase === "error" || expirationChainEntry?.phase === "error"
      ? "Failed to load options" : null);
  // Nothing lists a chain here for the instrument (a spot FX pair, a future, a coin other than BTC and ETH): the body
  // says what is not served and what to read instead. No plan changes it, so it is no error and offers no upgrade.
  const unserved = !chain && !!error && isOptionsUnavailableError(error);
  // `fn OMON EUR/USD` fails with the same answer, and the commands that read the alternative.
  useRemoteUiNode(unserved && effectiveTicker ? {
    role: "report-failure",
    label: "Options not served",
    getMetadata: () => ({
      message: optionsUnavailableTitle(effectiveTicker, effectiveExchange),
      details: isCoinWithoutOptions(effectiveTicker) ? coinOptionsAlternativesText("fn OMON")
        : optionsUnavailableDetails(effectiveTicker, (symbol) => `gloom fn OMON ${symbol}`, effectiveExchange),
    }),
  } : null);

  const selectExpiration = useCallback((expiration: number) => {
    updatePaneSettings({ expiration, expirationTargetKey: selectionTargetKey });
  }, [selectionTargetKey, updatePaneSettings]);
  expirationPickRef.current = (value: string) => {
    selectExpiration(Number(value));
  };
  const selectAdjacentExpiration = useCallback((offset: -1 | 1) => {
    if (expirationDates.length === 0) return;
    const index = expirationDates.indexOf(selectedExpiration!);
    selectExpiration(expirationDates[Math.max(0, Math.min(index + offset, expirationDates.length - 1))]!);
  }, [expirationDates, selectExpiration, selectedExpiration]);

  useEffect(() => {
    userSelectedStrikeRef.current = false;
    setScrollToIndexAlign("nearest");
    setStrikeIdx(0);
    setCalcSide(null);
    setContractSelection(null);
  }, [selectionTargetKey]);

  useEffect(() => {
    // A transient record (bound symbol, no saved ticker yet) never claims the
    // scope: the saved listing may still hydrate with a different instrument.
    if (!savedTicker || !target || !initialChain || expirationTargetKey === selectionTargetKey || selectedExpiration == null) return;
    // Persist local choices in the same field as incoming handoffs, scoped to
    // this holding and instrument. A new target starts at its own held date.
    selectExpiration(selectedExpiration);
  }, [expirationTargetKey, initialChain, savedTicker, selectExpiration, selectedExpiration, selectionTargetKey, target?.cacheKey]);

  useEffect(() => {
    userSelectedStrikeRef.current = false;
  }, [selectedExpiration, strikeWindowText]);

  const allStrikes = useMemo(() => strikeChain ? buildStrikeList(strikeChain) : [], [strikeChain]);
  // The window is read once per chain snapshot, and again when a price first
  // arrives, so streamed quotes never move strikes in or out under the cursor.
  const underlyingPrice = underlying?.quote?.price;
  const windowCenter = useMemo(
    () => resolveDefaultStrikeTarget(parsed?.strike, underlyingPrice),
    [strikeChain, parsed?.strike, underlyingPrice == null],
  );
  // The band reads deltas at the spot and instant the chain's Greeks are valued at, so a strike in it prints a delta in it.
  const windowSpot = useMemo(() => optionModelSpot(underlyingStale ? null : underlying?.quote, strikeChain, Date.now(), effectiveExchange),
    [strikeChain, spot == null]);
  const windowDeltas = useMemo(
    () => strikeWindow.kind === "delta" && strikeChain
      ? chainDeltasByStrike(strikeChain, windowSpot?.price, dividendYield, windowSpot?.valuationTime) : null,
    [dividendYield, strikeChain, strikeWindow.kind, windowSpot],
  );
  const strikeWindowResult = useMemo(
    () => applyStrikeWindow(allStrikes, strikeWindow, { center: windowCenter, deltas: windowDeltas, keep: parsed?.strike ?? null }),
    [allStrikes, parsed?.strike, strikeWindow, windowCenter, windowDeltas],
  );
  const strikes = strikeWindowResult.strikes;
  usePaneNoticeFooter({ registrationId: "options-strike-window", focused,
    notices: strikeWindowResult.fallback === "no-delta"
      ? ["The delta window needs a current underlying quote; showing every strike."]
      : strikeWindowResult.fallback === "no-price" ? ["No price to centre the strike window on; showing every strike."] : [] });
  // What the chain shows, in every renderer and in its reports: the expiry
  // and its calendar days left today, beside the chain's own dated feed.
  // Published ahead of the strike window, so a report names the expiry first.
  const asOfChain = strikeChain ?? chain;
  const chainAsOfMs = asOfChain?.asOf ? Date.parse(asOfChain.asOf) : Number.NaN;
  const expiry = selectedExpiration == null ? null : optionExpiryFacts(selectedExpiration, now, expiryVenue);
  const expiryDays = selectedExpiration == null ? "" : formatDaysToExpiry(selectedExpiration, now, expiryVenue);
  useRemoteUiNode(expiry && chain && !expirationUnavailable ? {
    role: "report-notice",
    label: "Expiry",
    getMetadata: () => ({
      text: `Expiry ${expiry.date} (${expiryDays})`,
      key: "expiry",
      value: expiry,
    }),
  } : null);
  // `fn OMON --expiration` on a date the chain cannot show fails as `options --expiration` does.
  useRemoteUiNode(expirationUnavailable && selectedExpiration != null && effectiveTicker ? {
    role: "report-failure",
    label: "Expiry unavailable",
    getMetadata: () => missingExpiryMessage(effectiveTicker, selectedExpiration, availableExpirations),
  } : null);
  // A refresh that failed keeps the last chain, which is then stale.
  const asOfEntry = strikeChain == null ? null : strikeChain === expirationChain ? expirationChainEntry : initialChainEntry;
  const snapshot = asOfChain ? optionSnapshotFreshness(asOfChain, now, expiryVenue, asOfEntry?.error != null) : null;
  // A report of the pane (`gloom fn OMON`) says how many strikes it lists of how many the expiry has.
  useRemoteUiNode(strikeChain ? {
    role: "report-notice",
    label: "Strike window",
    getMetadata: () => ({
      text: strikeWindowNotice(strikeWindow, strikeWindowResult),
      key: "strikes",
      value: {
        window: strikeWindowText,
        shown: strikeWindowResult.strikes.length,
        total: strikeWindowResult.total,
        ...(strikeWindowResult.fallback ? { fallback: strikeWindowResult.fallback } : {}),
      },
    }),
  } : null);
  const selectedStrikeIdx = selectedContract ? strikes.indexOf(selectedContract.strike) : strikeIdx;
  // The snapshot's contracts decide which symbols stream; they do not change
  // with the stream itself, so the subscription is stable between refreshes.
  const quoteRows = useMemo<OptionTableRow[]>(() => {
    const calls = new Map(strikeChain?.calls.map((contract) => [contract.strike, contract]) ?? []);
    const puts = new Map(strikeChain?.puts.map((contract) => [contract.strike, contract]) ?? []);
    return strikes.map((strike) => ({ strike, call: calls.get(strike), put: puts.get(strike), isPositionStrike: false }));
  }, [strikeChain, strikes]);
  const visibleStrikeRange = visibleStrikeViewport?.key === viewportKey
    ? visibleStrikeViewport.range
    : null;
  const handleVisibleStrikeRangeChange = useCallback((range: DataTableVisibleRange) => {
    setVisibleStrikeViewport((current) => (
      current?.key === viewportKey
      && current.range.start === range.start
      && current.range.end === range.end
        ? current
        : { key: viewportKey, range }
    ));
  }, [viewportKey]);
  // A chain read from a broker profile has its contracts quoted by that profile too.
  const quoteBrokerId = instrument?.brokerId, quoteBrokerInstanceId = instrument?.brokerInstanceId;
  const optionQuoteBroker = useMemo(() => quoteBrokerId || quoteBrokerInstanceId
    ? { brokerId: quoteBrokerId, brokerInstanceId: quoteBrokerInstanceId } : undefined, [quoteBrokerId, quoteBrokerInstanceId]);
  const optionQuoteTargets = useMemo(
    () => buildOptionQuoteTargets(quoteRows, {
      fallbackHeight: height,
      selectedIndex: selectedStrikeIdx,
      visibleRange: visibleStrikeRange,
    }, optionQuoteBroker),
    [height, quoteRows, selectedStrikeIdx, visibleStrikeRange, optionQuoteBroker],
  );
  const {
    entries: optionQuoteEntries,
    freshnessNow,
    subscriptionStartedAt,
  } = useLiveQuoteEntries(optionQuoteTargets, {
    freshnessScopeKey: viewportKey,
    liveStreaming,
  });
  const optionQuoteFreshness = useMemo(
    () => ({
      now: freshnessNow,
      subscriptionStartedAt,
    }),
    [freshnessNow, subscriptionStartedAt],
  );
  // Streamed bid/ask, last trade and volume replace the snapshot's for the
  // visible contracts, and every value derived below (IV, Greeks, summary,
  // analytics) reads this chain rather than the snapshot.
  // The snapshot object itself comes back while nothing streamed, so the
  // memos below only recompute when a quote actually landed.
  const overlay = useMemo(
    () => strikeChain ? overlayOptionChainQuotes(strikeChain, optionQuoteEntries, optionQuoteFreshness, optionQuoteBroker) : null,
    [optionQuoteEntries, optionQuoteFreshness, strikeChain, optionQuoteBroker],
  );
  const liveChain = overlay?.chain ?? null;
  const optionQuoteCoverage = useMemo(
    () => resolveOptionQuoteCoverage(optionQuoteTargets, optionQuoteEntries, optionQuoteFreshness, overlay?.liveBookTimes),
    [optionQuoteEntries, optionQuoteFreshness, optionQuoteTargets, overlay?.liveBookTimes],
  );
  const { status: quoteStatus, oldestLiveAt, liveCount, totalCount } = optionQuoteCoverage;
  const fullLive = quoteStatus === "live" && oldestLiveAt != null;
  useRemoteUiNode(snapshot ? {
    role: "report-freshness",
    label: "Option quotes",
    getMetadata: () => fullLive ? {
      status: "live",
      asOf: new Date(oldestLiveAt).toISOString(),
      asOfLabel: "Visible bids/asks",
      observations: [{ updatedAt: oldestLiveAt, dataSource: "live", stale: false }],
    }
      : quoteStatus === "mixed" ? { ...snapshot, asOfLabel: "Stored snapshot" } : snapshot,
  } : null);
  useRemoteUiNode(snapshot && liveCount > 0 ? {
    role: "report-notice",
    label: "Quote coverage",
    getMetadata: () => {
      const stored = snapshot.asOf ? `Stored snapshot ${formatSpotTime(Date.parse(snapshot.asOf))}${snapshot.status === "stale" ? " (stale)" : ""}.`
        : "Stored snapshot time not reported.";
      return {
        text: `${fullLive ? "Visible bids/asks are real-time." : "Visible bids/asks mix real-time and snapshot quotes."} ${stored}`,
        key: "quoteCoverage",
        value: { status: quoteStatus, liveCount, totalCount, snapshot },
      };
    },
  } : null);
  // IV and the Greeks are valued at one spot and instant, which the footer
  // names: the close a chain from the close was quoted against, else the
  // latest price (docs/research-data.md#greeks-spot-and-time).
  const underlyingQuote = underlyingStale ? null : underlying?.quote;
  const modelSpot = useMemo(() => liveChain ? optionModelSpot(underlyingQuote, liveChain, Date.now(), effectiveExchange) : null,
    [liveChain, underlyingQuote, effectiveExchange]);
  const greeksSpot = modelSpot?.price;
  // A quote under intrinsic at that spot is shown stale, as the server marks one from before the session.
  const pricedChain = useMemo(() => liveChain ? withQuotesUnderIntrinsicMarked(liveChain, greeksSpot) : null, [greeksSpot, liveChain]);
  const callsByStrike = useMemo(
    () => new Map(pricedChain?.calls.map((c) => [c.strike, c]) ?? []),
    [pricedChain],
  );
  const putsByStrike = useMemo(
    () => new Map(pricedChain?.puts.map((p) => [p.strike, p]) ?? []),
    [pricedChain],
  );
  // One solve per applied batch: a streamed contract's IV comes from its live
  // midpoint, the rest from the snapshot, all against the same forward.
  const volatilities = useMemo(
    () => liveChain ? solveChainVolatilities(liveChain, greeksSpot, dividendYield, modelSpot?.valuationTime) : null,
    [dividendYield, greeksSpot, modelSpot?.valuationTime, liveChain],
  );
  const rows = useMemo<OptionTableRow[]>(() => strikes.map((strike) => {
    const call = callsByStrike.get(strike);
    const put = putsByStrike.get(strike);
    return {
      strike,
      call,
      put,
      impliedVolatility: volatilities?.byStrike.get(strike),
      impliedVolatilityFilled: volatilities?.filled.has(strike) ?? false,
      callGreeks: volatilities ? calculateOptionGreeks(call, "call", greeksSpot, dividendYield, volatilities) : undefined,
      putGreeks: volatilities ? calculateOptionGreeks(put, "put", greeksSpot, dividendYield, volatilities) : undefined,
      callExtrinsicPerYear: call && volatilities ? optionCarry(call, "call", greeksSpot, volatilities.valuationTime)?.extrinsicPerYear ?? null : null,
      putExtrinsicPerYear: put && volatilities ? optionCarry(put, "put", greeksSpot, volatilities.valuationTime)?.extrinsicPerYear ?? null : null,
      putCostOfSpot: put ? optionCostOfSpot(put, greeksSpot) : null,
      isPositionStrike: !!parsed && strike === parsed.strike,
    };
  }), [callsByStrike, dividendYield, greeksSpot, parsed, putsByStrike, strikes, volatilities]);
  // The open interest's session: the chain's own, or for a chain that does not say, OPX's listing of the
  // same expiry, stated only when the counts are OPX's.
  const statedOpenInterest = useMemo(() => strikeChain ? statedOpenInterestAsOf(strikeChain) : undefined, [strikeChain]);
  const listedExpiry = selectedExpiration == null || !effectiveTicker || !strikeChain || statedOpenInterest
    ? null : expiryIsoDate(selectedExpiration);
  const listedScope = useCloudDisplayScope();
  const listedTicker = canonicalTickerKey(effectiveTicker, effectiveExchange);
  const listedLoader = useCallback((force: boolean) => listedScope === null || !listedExpiry ? Promise.resolve(null)
    : loadListedOpenInterest(listedTicker, listedExpiry, { force }), [listedScope, listedTicker, listedExpiry]);
  const listedOpenInterest = useAsyncResource(listedExpiry && listedScope !== null ? listedLoader : null, {
    initialData: () => listedExpiry && listedScope !== null ? readListedOpenInterest(listedScope, listedTicker, listedExpiry) : null,
  });
  const openInterestAsOf = useMemo(() => statedOpenInterest
    ?? (strikeChain && listedOpenInterest.data ? chainOpenInterestAsOf(strikeChain, listedOpenInterest.data) : null),
  [statedOpenInterest, strikeChain, listedOpenInterest.data]);
  // A report of the pane (`gloom fn OMON`) names them too.
  useRemoteUiNode(modelSpot ? {
    role: "report-notice",
    label: "Greeks spot",
    getMetadata: () => ({
      text: `Greeks at spot ${formatModelSpotPrice(modelSpot.price)} (${modelSpotLabel(modelSpot)})`
        + (snapshot?.status === "stale" ? ` · valuation ${formatSpotTime(modelSpot.valuationTime)}` : ""),
      key: "greeksSpot",
      value: { spot: modelSpot.price, basis: modelSpot.basis === "close" ? "close" : modelSpot.session ?? "last",
        asOf: new Date(modelSpot.observedAt).toISOString(), valuationTime: new Date(modelSpot.valuationTime).toISOString() },
    }),
  } : null);
  // The volume's session goes where the open interest's date does: before the open, the chain's
  // volume is the last session's, which is not the day the counts are read on.
  const volumeSession = strikeChain ? optionQuoteSession(strikeChain, effectiveExchange || undefined) : null;
  const volumeSessionText = volumeSession ? volumeSessionLabel(volumeSession) : "";
  const volumeSessionShortText = volumeSession ? `Vol ${volumeSession.slice(5)}` : "";
  useRemoteUiNode(volumeSessionText ? {
    role: "report-notice",
    label: "Volume session",
    getMetadata: () => ({ text: volumeSessionText, key: "volumeSession", value: volumeSession }),
  } : null);
  useRemoteUiNode(strikeChain && !listedOpenInterest.loading ? {
    role: "report-notice",
    label: "Open interest as of",
    getMetadata: () => ({ text: openInterestAsOfLabel(openInterestAsOf), key: "openInterestAsOf", value: openInterestAsOf?.date ?? null }),
  } : null);
  // What IV and the Greeks are valued at. In a crowded footer it shortens,
  // then gives way to the contract under the cursor. A stamped spot (a close,
  // an extended print) is already the Spot figure's.
  const footerSpot = modelSpot && !modelSpotStamp(modelSpot) ? modelSpot : null;
  const basisText = footerSpot ? `spot ${formatModelSpotPrice(footerSpot.price)} ${modelSpotLabel(footerSpot)}` : "";
  const shortBasisText = footerSpot ? `${formatModelSpotPrice(footerSpot.price)} last ${new Date(footerSpot.observedAt).toISOString().slice(11, 16)} UTC` : "";
  // The open interest's date, which its counts cannot be read without: while the chain shows OI it shortens but
  // stays, before the spot and the contract under the cursor give way, and a picture of the pane keeps it.
  const openInterestShown = shownFieldIds.includes("openInterest");
  const openInterestDateText = strikeChain && !listedOpenInterest.loading ? openInterestAsOfLabel(openInterestAsOf) : "";
  const openInterestShortText = openInterestAsOf?.date ? `OI ${openInterestAsOf.date.slice(5)}` : "OI undated";
  // How IV was solved is said while the chain shows a figure that was not: a strike with no two-sided
  // out-of-the-money quote has its IV read off the neighbouring strikes, and its cell leads with "~".
  const ivFilledShown = shownFieldIds.includes("iv") && rows.some((row) => row.impliedVolatilityFilled && row.impliedVolatility != null);
  // A report of the pane (`gloom fn OMON`) says it too.
  useRemoteUiNode(ivFilledShown ? {
    role: "report-notice",
    label: "IV filled",
    getMetadata: () => ({ text: IV_FILLED_NOTE, key: "ivFilled", value: true }),
  } : null);
  usePaneFooter("options-oi-date", () => {
    const dated = (volume: string, openInterest: string) => [{ text: [volume, openInterest].filter(Boolean).join(" · "), tone: "muted" as const }];
    return { order: -1, info: openInterestDateText ? [{
      id: "oi-as-of", capture: openInterestShown, holdsPlace: openInterestShown, parts: dated(volumeSessionText, openInterestDateText),
      variants: [dated(volumeSessionShortText, openInterestShortText), ...(openInterestShown ? [] : [[]])],
    }] : [] };
  }, [openInterestDateText, openInterestShortText, openInterestShown, volumeSessionText, volumeSessionShortText]);
  usePaneFooter("options-basis", () => ({ info: [
    ...(basisText ? [{ id: "greeks-basis", parts: [{ text: basisText, tone: "muted" as const }],
      variants: [[{ text: shortBasisText, tone: "muted" as const }], []] }] : []),
    ...(ivFilledShown ? [{ id: "iv-filled", parts: [{ text: IV_FILLED_NOTE, tone: "muted" as const }],
      title: IV_FILLED_DETAIL, variants: [[{ text: IV_FILLED_SHORT, tone: "muted" as const }]] }] : []),
  ] }), [basisText, shortBasisText, ivFilledShown]);
  // Fields the terminal chain gave up for width, counted so a narrow chain does
  // not read as all there is; hover names them. It leads the footer and holds
  // its place beside the open interest's date, so a crowded row gives up the
  // contract under the cursor before either.
  const hiddenFields = OPTION_FIELD_DEFS.filter((field) => optionFieldIds.includes(field.id) && !shownFieldIds.includes(field.id))
    .map((field) => field.label).join(", ");
  usePaneFooter("options-fit", () => {
    const count = hiddenFields ? hiddenFields.split(", ").length : 0;
    return { order: -1, info: count ? [{
      id: "options-hidden-fields",
      capture: true,
      holdsPlace: true,
      parts: [{ text: `${count} ${count === 1 ? "field" : "fields"} hidden`, tone: "muted" as const }],
      title: `Too narrow for ${hiddenFields}: a wider pane shows them, and Export CSV keeps them.`,
      variants: [[{ text: `${count} hidden`, tone: "muted" as const }]],
    }] : [] };
  }, [hiddenFields]);
  // Figures that summarise the whole expiry move at most once a second, so a
  // busy stream reads as a steady strip rather than flicker.
  // A new expiry, a refreshed snapshot or the underlying price arriving or
  // going stale shows at once; only the stream itself is paced.
  const summaryResetKey = useMemo(() => ({}), [strikeSelectionKey, strikeChain, greeksSpot == null]);
  const summaryInput = useThrottledValue(
    useMemo(() => ({ chain: liveChain, spot: greeksSpot, volatilities }), [liveChain, greeksSpot, volatilities]),
    OPTIONS_SUMMARY_THROTTLE_MS,
    summaryResetKey,
  );
  const summary = useMemo(
    () => summaryInput.chain && summaryInput.volatilities
      ? calculateOptionsSummary(summaryInput.chain, summaryInput.spot, dailyHistory ?? [], summaryInput.volatilities)
      : null,
    [summaryInput, dailyHistory],
  );
  const enrichmentState = useOptionsEnrichment({
    instrument: baseRequest?.instrument ?? null, expiration: selectedExpiration,
    selectedEntry: strikeChain === expirationChain ? expirationChainEntry
      : strikeChain === initialChain ? initialChainEntry : null,
    catalogue: availableExpirations, spot: greeksSpot, spotAsOf: modelSpot?.observedAt,
    liveChain: liveChain !== strikeChain ? liveChain : null,
  });
  const enrichment = expirationUnavailable ? null : enrichmentState.snapshot;
  usePaneNoticeFooter({ registrationId: "options-enrichment-warnings", focused,
    notices: [...(enrichment?.warnings ?? []), enrichmentState.error, enrichment?.error]
      .filter((value): value is string => !!value) });
  const dialog = useOptionalDialog();
  // The footer tooltip's detail, for the keyboard and the terminal (which has
  // no tooltip): the pane menu opens it in a dialog.
  const showAnalyticsAsOf = useCallback(() => {
    if (!dialog || !enrichment?.asOf) return;
    const rows = analyticsAsOfRows(enrichment);
    void dialog.alert({
      closeOnClickOutside: true,
      content: (ctx: AlertContext) => <AnalyticsAsOfDialog {...ctx} rows={rows} />,
    }).catch(logFailure("options.view", "Open analytics as-of dialog failed"));
  }, [dialog, enrichment]);
  usePaneFooter("options-enrichment", () => ({ info: [
    ...(enrichmentState.loading ? [{ id: "enrichment-loading", parts: [{ text: "loading analytics", tone: "muted" as const }] }] : []),
    ...(enrichment?.asOf ? [{ id: "enrichment-asof",
      title: analyticsAsOfRows(enrichment).map((row) => `${row.label}: ${row.value}`).join("\n"),
      parts: [{ text: `Analytics ${enrichment.asOf.slice(0, 16).replace("T", " ")} UTC`, tone: "muted" as const }] }] : []),
  ] }), [enrichmentState.loading, enrichment]);
  const optionColumns = useMemo<OptionColumn[]>(() => createOptionColumns(shownFieldIds).map((column) => ({
    ...column,
    headerColor: optionColumnColor(column, colors.panel),
  })), [shownFieldIds]);

  const selectedRow = rows[selectedStrikeIdx] ?? null;
  const selectedContractAvailable = !selectedContract || (selectedContract.side === "call"
    ? selectedRow?.call : selectedRow?.put)?.contractSymbol === selectedContract.contractSymbol;
  const selectedSide = selectedContract
    ? selectedContractAvailable ? selectedContract.side : null
    : resolveCalcSide(calcSide, parsed?.side, selectedRow);
  const selectedReference = optionMarketReference(selectedSide === "put" ? selectedRow?.put
    : selectedSide === "call" ? selectedRow?.call : undefined);
  // The calculator starts where the chain's IV and Greeks are valued: the same spot (the close a chain from the
  // close is priced at) and the same instant, so the days to expiry run from the chain's quote time, not from now.
  const selectedExpiry = (selectedSide === "put" ? selectedRow?.put : selectedRow?.call)?.expiration;
  const calcValuation = useMemo(() => modelSpot && volatilities ? {
    time: volatilities.valuationTime, spotLabel: modelSpotStamp(modelSpot),
    forward: selectedExpiry == null ? null : volatilities.forwards.get(selectedExpiry) ?? null,
  } : null, [modelSpot, volatilities, selectedExpiry]);
  const calcParams = useMemo(() => buildChainCalcParams({
    symbol: effectiveTicker,
    row: selectedRow,
    side: selectedSide,
    // On an option ticker the pane quote is the contract's own price, so the
    // underlying's quote prices it rather than the option mark.
    spot: greeksSpot,
    dividendYield,
    valuation: calcValuation,
  }), [dividendYield, effectiveTicker, selectedSide, selectedRow, greeksSpot, calcValuation]);

  const openCalculator = useCallback(() => {
    if (!calcParams) return;
    createPaneFromTemplate(OPTIONS_CALCULATOR_TEMPLATE_ID, { values: calcParams });
  }, [calcParams, createPaneFromTemplate]);

  const scenarioContract = selectedSide === "put" ? selectedRow?.put : selectedSide === "call" ? selectedRow?.call : null;
  const scenarioMid = scenarioContract ? optionMid(scenarioContract) : null;
  const scenarioVolatility = selectedRow?.impliedVolatility ?? 0;
  const scenarioAvailable = !!calcParams && scenarioMid != null && !!scenarioContract
    && !!scenarioContract.currency && scenarioContract.currency === underlying?.quote?.currency;
  const openScenario = useCallback(() => {
    const contract = scenarioContract;
    if (!contract || !scenarioAvailable || !selectedSide || scenarioMid == null) return;
    const leg = { id: crypto.randomUUID(), side: selectedSide, quantity: 1, strike: contract.strike,
      expiration: contract.expiration, price: scenarioMid, volatility: scenarioVolatility, multiplier: 100 };
    createPaneFromTemplate("options-scenario-pane", { symbol: canonicalTickerKey(effectiveTicker, effectiveExchange),
      values: { seedLeg: JSON.stringify(leg), spot: String(spot),
        currency: contract.currency,
        ...(dividendYield == null ? {} : { dividendYield: String(dividendYield * 100) }),
        // The scenario values at the underlying's print; the chain's quote time goes with the leg, so a roll from an earlier session shows.
        ...(Number.isFinite(chainAsOfMs) ? { optionQuotesAt: new Date(chainAsOfMs).toISOString() } : {}),
        asOf: new Date(underlying?.quote?.lastUpdated ?? Date.now()).toISOString() } });
  }, [scenarioContract, scenarioAvailable, scenarioMid, scenarioVolatility, createPaneFromTemplate, dividendYield, effectiveTicker,
    effectiveExchange, selectedSide, spot, underlying?.quote?.lastUpdated, chainAsOfMs]);

  // A contract opens as its own listing: quote, chart and Trade. It stays on
  // the chain's broker while that profile is on, else it opens by its symbol.
  const contractListing = useCallback((contract: OptionContract) => {
    const symbol = contract.contractSymbol.trim().toUpperCase();
    const currency = contract.currency || underlying?.quote?.currency || "USD";
    const brokerOn = !!instrument && appConfig.brokerInstances.some((profile) => profile.id === instrument.brokerInstanceId && profile.enabled !== false);
    return { symbol, selection: { instrument: brokerOn ? chainOptionContract(symbol, instrument, currency) : null,
      listing: { name: optionContractName(symbol) ?? symbol, exchange: "", currency, type: "OPT" } } };
  }, [appConfig.brokerInstances, instrument, underlying?.quote?.currency]);
  const openContract = useCallback((contract: OptionContract | null | undefined) => {
    if (!contract) return;
    const { symbol, selection } = contractListing(contract);
    pinTicker(symbol, selection);
  }, [contractListing, pinTicker]);
  const tradable = !!scenarioContract && brokerCanTrade(appConfig.brokerInstances, getBrokerAdapter, scenarioContract.contractSymbol.trim().toUpperCase(), "OPT");
  const tradeContract = useCallback(() => {
    if (!scenarioContract || !tradable) return;
    const { symbol, selection } = contractListing(scenarioContract);
    // A new contract's ticket starts on Buy; b and s choose the side in it.
    openTradeTicket({ pinTicker }, symbol, { action: "BUY" }, selection);
  }, [contractListing, pinTicker, scenarioContract, tradable]);

  const openSurface = useCallback(() => {
    if (!ticker || selectedExpiration == null) return;
    createPaneFromTemplate("vol-surface-pane", { symbol: ticker.metadata.ticker, ticker, instrument,
      listing: { name: ticker.metadata.name, exchange: ticker.metadata.exchange,
        currency: ticker.metadata.currency, type: ticker.metadata.assetCategory ?? "STK" },
      values: { expiration: String(selectedExpiration) } });
  }, [createPaneFromTemplate, ticker, instrument, selectedExpiration]);
  const selectContract = useCallback((row: OptionTableRow, index: number, side?: OptionSide, preservePointer = false) => {
    userSelectedStrikeRef.current = true;
    setScrollToIndexAlign("nearest");
    setStrikeIdx(index);
    const chosenSide = resolveCalcSide(side ?? calcSide, parsed?.side, row);
    const contract = chosenSide === "put" ? row.put : chosenSide === "call" ? row.call : undefined;
    if (contract && chosenSide) {
      setContractSelection((current) => preservePointer && current?.context === strikeSelectionKey && current.strike === row.strike
        ? current : { context: strikeSelectionKey, strike: row.strike,
          side: chosenSide, contractSymbol: contract.contractSymbol });
    }
  }, [calcSide, parsed?.side, strikeSelectionKey]);

  // [x] is the keyboard's click on the other half of the cursor row: it picks
  // that contract for [c]alc, [a]dd and the status bar, and later rows keep it.
  const sideTarget: OptionSide | null = !selectedRow ? null
    : selectedSide === "put" ? (selectedRow.call ? "call" : null)
      : selectedRow.put ? "put" : null;
  const switchSide = useCallback(() => {
    if (!selectedRow || !sideTarget) return;
    selectContract(selectedRow, selectedStrikeIdx, sideTarget);
    setCalcSide(sideTarget);
  }, [selectContract, selectedRow, selectedStrikeIdx, sideTarget]);

  // With a broker that trades the contract, [t]rade opens its ticket on Buy, and Sell is chosen there.
  const footerHints = useMemo(() => [
    ...(sideTarget ? [{ id: "side", key: SIDE_KEY, label: ` ${sideTarget}`, title: sideTarget === "put" ? "Select Put" : "Select Call", onPress: switchSide }] : []),
    ...(tradable ? [{ id: "trade-contract", key: "t", label: "rade", title: "Trade Contract", onPress: tradeContract }] : []),
    ...(calcParams ? [{ id: "calc", key: "c", label: "alc", onPress: openCalculator }] : []),
    ...(scenarioAvailable ? [{ id: "scenario", key: "a", label: "dd to OSA", onPress: openScenario }] : []),
    ...(ticker && selectedExpiration != null ? [{ id: "surface", key: "s", label: "urface", onPress: openSurface }] : []),
  ], [sideTarget, switchSide, tradable, tradeContract, calcParams, openCalculator, scenarioAvailable, openScenario, ticker, selectedExpiration, openSurface]);

  // Back to where the chain opens: the held contract's strike, else the money.
  const defaultStrikeIndex = strikes.length === 0 ? -1 : (() => {
    const targetStrike = resolveDefaultStrikeTarget(parsed?.strike, spot);
    return targetStrike == null ? -1 : findNearestStrikeIndex(strikes, targetStrike);
  })();
  const goToDefaultStrike = useCallback(() => {
    const row = rows[defaultStrikeIndex];
    if (!row) return;
    selectContract(row, defaultStrikeIndex);
    setScrollToIndexAlign("center");
    setAutoScrollVersion((version) => version + 1);
  }, [defaultStrikeIndex, rows, selectContract]);

  usePaneMenuItems("options-chain", () => [
    { id: "expiry-previous", label: "Previous Expiry", accelerator: EXPIRY_PREVIOUS_KEY,
      enabled: selectedExpirationIndex > 0, onSelect: () => selectAdjacentExpiration(-1) },
    { id: "expiry-next", label: "Next Expiry", accelerator: EXPIRY_NEXT_KEY,
      enabled: selectedExpirationIndex >= 0 && selectedExpirationIndex < expirationDates.length - 1,
      onSelect: () => selectAdjacentExpiration(1) },
    { id: "default-strike", label: parsed ? "Go to Held Strike" : "Go to ATM Strike",
      enabled: defaultStrikeIndex >= 0, onSelect: goToDefaultStrike },
    ...(enrichment?.asOf && dialog ? [{ id: "analytics-as-of", label: "Analytics As Of…", onSelect: showAnalyticsAsOf }] : []),
    { id: "open-contract", label: "Open Contract", accelerator: "Enter", enabled: !!scenarioContract, onSelect: () => openContract(scenarioContract) },
    ...(tradable ? [{ id: "trade-contract", label: "Trade Contract", accelerator: "t", onSelect: tradeContract }] : []),
  ], [defaultStrikeIndex, dialog, enrichment?.asOf, expirationDates.length, goToDefaultStrike, parsed,
    selectAdjacentExpiration, selectedExpirationIndex, showAnalyticsAsOf, scenarioContract, openContract, tradable, tradeContract]);

  const renderCell = useCallback((
    row: OptionTableRow,
    column: OptionColumn,
    index: number,
    rowState: { selected: boolean },
  ) => {
    const cell = renderOptionCell(row, column, index, rowState, selectedSide);
    if (!column.side) return cell;
    // Clicking a call or put cell is the mouse way to choose which contract
    // [c]alc opens, so it has to select the row itself as well.
    const side: OptionSide = column.side;
    return {
      ...cell,
      onMouseDown: () => {
        selectContract(row, index, side);
        setCalcSide(side);
      },
    };
  }, [selectContract, selectedSide]);

  useOptionsAccessFooter({
    broker: !!optionQuoteBroker,
    chain,
    snapshot,
    unserved,
    error: unserved ? null : [error, underlyingStale ? "Underlying quote stale: Greeks and calculator unavailable" : null,
      selectedContract && strikeChain && !selectedContractAvailable
        ? `Selected ${formatStrikeLabel(selectedContract.strike)} ${selectedContract.side} unavailable` : null,
      summary?.historicalVolatilityUnavailableReason, dailyHistoryEntry?.error?.message].filter(Boolean).join(" · ") || null,
    focused,
    hints: footerHints,
    loading,
    quoteCoverage: optionQuoteCoverage,
    reference: selectedReference,
    savedAt: chainSavedAt,
    spreadColumnVisible: shownFieldIds.includes("spread"),
  });

  useEffect(() => {
    setStrikeIdx((index) => {
      if (strikes.length === 0) return 0;
      return Math.min(index, strikes.length - 1);
    });
  }, [strikes.length]);

  useEffect(() => {
    if (strikes.length === 0 || userSelectedStrikeRef.current) return;
    const targetStrike = resolveDefaultStrikeTarget(parsed?.strike, spot);
    if (targetStrike == null) return;
    setScrollToIndexAlign("center");
    setStrikeIdx(findNearestStrikeIndex(strikes, targetStrike));
    setAutoScrollVersion((version) => version + 1);
  }, [selectedExpiration, parsed?.strike, spot, strikes]);

  // [ and ] step the expiry strip. A chain in its own pane also takes h/l and
  // the arrows for it; in a research tab those stay with the tab strip.
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.targetEditable) return;
    if (event.ctrl || event.meta || event.alt) return;
    const surface = isPlainKey(event, "s");
    if (surface && ticker && selectedExpiration != null) {
      event.preventDefault();
      event.stopPropagation();
      openSurface();
      return;
    }
    if (event.shift) return;
    if (tradable && isPlainKey(event, "t") && !event.repeat) {
      event.preventDefault();
      event.stopPropagation();
      tradeContract();
      return;
    }

    const expiryStep = isPlainKey(event, EXPIRY_PREVIOUS_KEY) || (!nestedInTabs && isPlainKey(event, "h", "left")) ? -1
      : isPlainKey(event, EXPIRY_NEXT_KEY) || (!nestedInTabs && isPlainKey(event, "l", "right")) ? 1 : 0;
    if (expiryStep) {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentExpiration(expiryStep);
      return;
    }
    if (isPlainKey(event, "c") && calcParams) {
      event.preventDefault();
      event.stopPropagation();
      openCalculator();
      return;
    }
    if (isPlainKey(event, "a") && scenarioAvailable) {
      event.preventDefault();
      event.stopPropagation();
      openScenario();
    }
  }, { enabled: focused, phase: "before" });

  if (!ticker) {
    return <EmptyState title="Select a ticker." />;
  }
  if (loading && !chain) return <Spinner label="Loading options chain..." />;
  if (error && !chain && isOptionsUnavailableError(error) && isCoinWithoutOptions(effectiveTicker)) {
    // A coin other than BTC and ETH: the coins that have options, and a bitcoin-linked fund's.
    return (
      <EmptyState
        title={optionsUnavailableTitle(effectiveTicker)}
        hint={COIN_OPTIONS_HINT}
        actions={<>
          <Button label="BTC-USD options" onPress={() => createPaneFromTemplate("options-pane", { symbol: "BTC-USD" })} />
          <Button label="IBIT options" onPress={() => createPaneFromTemplate("options-pane", { symbol: "IBIT" })} />
        </>}
      />
    );
  }
  if (error && !chain && isOptionsUnavailableError(error)) {
    // A future, commodity or FX pair with no chain of its own: the listed fund whose options stand in, and OSA on it.
    // A listing whose venue lists options (0700 on HKEX): that Gloom does not serve them, and what it does serve.
    const alternative = listedOptionsAlternative(effectiveTicker);
    return (
      <EmptyState
        title={optionsUnavailableTitle(effectiveTicker, effectiveExchange)}
        hint={optionsUnavailableHint(effectiveTicker, effectiveExchange)}
        actions={alternative ? <>
          <Button label={`${alternative.symbol} options`} onPress={() => createPaneFromTemplate("options-pane", { symbol: alternative.symbol })} />
          <Button label={`OSA ${alternative.symbol}`} onPress={() => createPaneFromTemplate("options-scenario-pane", { symbol: alternative.symbol })} />
        </> : undefined}
      />
    );
  }
  if (error && !chain) return <EmptyState title="Options chain unavailable." message={error} />;
  if (!chain || expirationDates.length === 0) {
    return <EmptyState title={`No options available for ${displayTickerKey(effectiveTicker)}.`} />;
  }

  const positionContracts = isOpt && parsed
    ? ticker.metadata.positions.reduce((sum, p) => sum + Math.abs(p.shares) * signedPositionDirection(p), 0)
    : 0;
  // The root insets the terminal body, so the band gets the width inside it.
  const statWidth = Math.max(1, width - (nativePaneChrome ? 0 : 2));
  const figures = optionsSummaryItems({
    spot: spotItem(underlying, isOpt ? undefined : ticker.metadata.assetCategory, modelSpot),
    summary, enrichment, currency: underlying?.quote?.currency || ticker.metadata.currency || "",
    ivRank: showIvRank ? { stats: ivRank } : null,
  });
  // The band keeps the chain's row budget (3, 4 or 6 rows by width). A live
  // Slope or IVR detail is the widest cell and would otherwise halve the
  // columns and push the chain down; the detail is cut short instead.
  const statRowBudget = width >= 110 ? 3 : width >= 65 ? 4 : 6;
  const figureColumns = Math.max(statGridColumns(figures, statWidth), Math.ceil(figures.length / statRowBudget));
  // The expiry leads the band, since the strip above can scroll it out of
  // view. It joins the figures as one more cell where the row budget leaves a
  // cell wide enough for all of it, and otherwise takes a row of its own so no
  // figure is squeezed. Sized for four-digit days, so the band does not
  // reflow as the chain's as-of arrives or the expiry steps.
  // Dated as the expiry strip dates it ("13 Nov '26"), never the ISO day a report carries.
  const expiryLabel = selectedExpiration == null ? "" : formatExpDate(selectedExpiration);
  const expiryItem: StatItem = { id: "expiry", label: "Expiry", value: expiryLabel, detail: `(${expiryDays})` };
  const cellColumns = Math.max(figureColumns, Math.ceil((figures.length + 1) / statRowBudget));
  const expiryCells = Math.max(...figures.map((item) => item.label.length), expiryItem.label.length) + 1
    + expiryLabel.length + 2 + "(9999d)".length;
  const expiryInline = Math.floor((statWidth - 2 * (cellColumns - 1)) / cellColumns) >= expiryCells;
  const statColumns = expiryInline ? cellColumns : figureColumns;
  const statItems = [expiryInline ? expiryItem : { ...expiryItem, wide: true }, ...figures];
  // A short band gives up figures from the end, by lines: a row that wraps
  // takes two. The expiry leads, so it stays.
  const summaryLines = Math.min(statGridRows(statItems, statWidth, statColumns), Math.max(0, height - 6));
  const { items: shownStatItems, lines: summaryRowCount } = statGridWithin(statItems, statWidth, summaryLines, statColumns);
  // No term here follows the selection or the load, so an empty cold-expiry
  // response cannot resize the table: growing it during loading would turn a
  // clamped scroll into apparent user navigation.
  const tableHeight = Math.max(1, height - 1 - summaryRowCount - (isOpt && parsed ? 1 : 0));
  // Desktop: the expiry bar and the chain run edge to edge like every other
  // pane, so the inset moves from the column onto the rows that need it.
  const inset = nativePaneChrome ? 1 : 0;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={nativePaneChrome ? 0 : 1}>
      <QueryBar width={Math.max(1, width - 2)} filters={queryFilters} />

      {summaryRowCount > 0 && (
        <StatGrid items={shownStatItems} width={statWidth} columns={statColumns} maxLines={summaryLines} />
      )}

      {isOpt && parsed && (
        <Box height={1} paddingX={inset}>
          <Text fg={colors.textBright}>
            {`Position: ${positionContracts} ${parsed.side === "C" ? "call" : "put"} contract${Math.abs(positionContracts) !== 1 ? "s" : ""}${positionContracts < 0 ? " (SHORT)" : ""} @ $${parsed.strike}`}
          </Text>
        </Box>
      )}

      <DataTableView<OptionTableRow, OptionColumn>
        focused={focused}
        selection={{
          kind: "id",
          selectedId: selectedContract ? String(selectedContract.strike) : selectedRow ? String(selectedRow.strike) : null,
          getId: (row) => String(row.strike),
          onChange: (_id, row, index, reason) => {
            // A side-cell handler owns its precise contract choice. A later
            // row pointer callback must not replace it with the prior side.
            selectContract(row, index, undefined, reason === "pointer");
          },
        }}
        onCursorChange={() => {
          userSelectedStrikeRef.current = true;
          setScrollToIndexAlign("nearest");
        }}
        headerScrollId="options-table-header-scroll"
        bodyScrollId="options-table-body-scroll"
        columns={optionColumns}
        columnDropOrder={OPTION_COLUMN_DROP_ORDER}
        // A field the terminal gave up for width is still in the export.
        exportCsv={shownFieldIds.length < optionFieldIds.length
          ? () => createDataTableCsv({ columns: createOptionColumns(optionFieldIds), items: rows, renderCell })
          : undefined}
        // Calls and puts mirror each other around the strike; Settings orders their fields.
        columnReorder={false}
        items={rows}
        sortColumnId={null}
        sortDirection="asc"
        onBodyScrollActivity={(source) => {
          if (source !== "programmatic") userSelectedStrikeRef.current = true;
        }}
        visibleRangeKey={viewportKey}
        onVisibleRangeChange={handleVisibleStrikeRangeChange}
        getItemKey={(row) => String(row.strike)}
        renderCell={renderCell}
        onActivate={(row) => openContract(selectedSide === "put" ? row.put : selectedSide === "call" ? row.call : null)}
        selectedTextOverridesCellColor
        emptyStateTitle={unavailableExpiry ?? (error && !strikeChain ? "Selected expiration unavailable." : strikesLoading ? "Loading strikes..."
          : strikeWindowResult.total > 0 ? "No strikes in this window." : "No strikes available.")}
        reportEveryRow
        rootWidth={Math.max(1, width - 2 + inset * 2)}
        rootHeight={tableHeight}
        horizontalPadding={inset}
        scrollToIndex={selectedStrikeIdx >= 0 ? selectedStrikeIdx : undefined}
        scrollToIndexAlign={scrollToIndexAlign}
        scrollToIndexVersion={autoScrollVersion}
      />
    </Box>
  );
}
