import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { usePaneSettingValue, usePaneTicker, useUpdatePaneSettings } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { formatCompact } from "../../../utils/format";
import { formatExpDate, resolveOptionsTarget } from "../../../utils/options";
import { canonicalTickerKey } from "../../../utils/exchanges";
import { useChartQueries, useOptionsQuery, useResolvedEntryValue, useTickerFinancials } from "../../../market-data/hooks";
import {
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
import { useShortcut } from "../../../react/input";
import { useOptionalDialog, type AlertContext } from "../../../ui/dialog";
import { useLiveQuoteEntries, useQuoteUpdates } from "../../../state/hooks/quote-streaming";
import { buildChartKey } from "../../../market-data/selectors";
import type { ChartRequest } from "../../../market-data/request-types";
import { quoteSubscriptionTargetFromTicker } from "../../../market-data/request-types";
import { usePluginAppActions } from "../../runtime";
import {
  OPTIONS_CALCULATOR_TEMPLATE_ID,
  type OptionSide,
} from "../options-calculator/model";
import { buildChainCalcParams, resolveCalcSide } from "./calc-seed";
import { useOptionsCatalogue } from "./expiry-catalogue";
import { calculateOptionGreeks, calculateOptionsSummary, solveChainVolatilities, type OptionsSummary } from "./analytics";
import {
  DEFAULT_OPTION_FIELD_IDS,
  buildStrikeList,
  createOptionColumns,
  findNearestStrikeIndex,
  formatIv,
  formatStrikeLabel,
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
import { AnalyticsAsOfDialog, analyticsAsOfRows } from "./analytics-as-of";
import { useLiveStreamingSetting } from "../shared/live-streaming";
import { signedPositionDirection } from "../portfolio-list/position-metrics";
import { optionMarketReference } from "./market-reference";
import { useOptionsEnrichment } from "./enrichment";
import type { OptionsEnrichmentSnapshot } from "./enrichment-model";
import { optionMid } from "../shared/volatility";
import type { TickerRecord } from "../../../types/ticker";
import type { IvStats } from "../iv-history/client";
import { useIvRank } from "../iv-history/rank";
import { useOptionsSessionOpen, useThrottledValue } from "../shared/volatility/live-session";

/** The summary strip and analytics recompute from live quotes at most this often. */
const OPTIONS_SUMMARY_THROTTLE_MS = 1_000;
/** Step the expiry strip; h/l and the arrows do too when no parent tab strip owns them. */
const EXPIRY_PREVIOUS_KEY = "[";
const EXPIRY_NEXT_KEY = "]";
/** Switches the cursor row between its call and its put, as clicking either side does. */
const SIDE_KEY = "x";

function formatRatio(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "--" : value.toFixed(2);
}

/** The minimal record the chain needs for a symbol that is bound but not saved in any list. */
function transientTicker(symbol: string, exchange: string, currency: string): TickerRecord {
  return { metadata: { ticker: symbol, exchange, currency, name: symbol, portfolios: [], watchlists: [], positions: [], custom: {}, tags: [] } };
}

/** The chain's volatility, expected move and flow figures, in the order the stat band reads them. */
function optionsSummaryItems({ summary, enrichment, currency, ivRank }: {
  summary: OptionsSummary | null;
  enrichment: OptionsEnrichmentSnapshot | null;
  currency: string;
  ivRank?: { stats: IvStats | null } | null;
}): StatItem[] {
  // The chain columns draw an empty IV as a dash; a summary figure reads "--" like its neighbours.
  const iv = (value: number | null | undefined) => value == null || !(value > 0) ? "--" : formatIv(value);
  const whole = (value: number | null | undefined) => value == null ? "--" : String(Math.round(value));
  const rank = ivRank?.stats ?? null;
  const move = (amount: number | null | undefined, percent: number | null | undefined): Pick<StatItem, "value" | "detail"> =>
    amount == null || percent == null ? { value: "--" } : { value: `${amount.toFixed(2)} ${currency}`.trim(), detail: `${percent.toFixed(2)}%` };
  const points = (value: number | null | undefined) => value == null ? null : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}`;
  const skew = points(enrichment?.skew25);
  const slope = points(enrichment?.termSlope);
  const slopeAnnualized = enrichment?.termSlopeAnnualized === true;
  // The selected expiry is the active choice in the bar above, so the slope names only the one it runs to.
  const slopeTo = enrichment?.neighbourExpiration == null ? undefined : `to ${formatExpDate(enrichment.neighbourExpiration)}`;
  return [
    { id: "atm-iv", label: "ATM IV", value: iv(summary?.atmImpliedVolatility) },
    { id: "hv30", label: "HV30", value: iv(summary?.historicalVolatility30d) },
    { id: "iv-hv", label: "IV/HV", value: formatRatio(summary?.impliedHistoricalRatio) },
    ...(ivRank ? [{
      id: "ivr", label: "IVR", value: whole(rank?.rank),
      detail: rank ? `pctl ${whole(rank.percentile)} · ${rank.date.slice(5)}` : undefined,
    }] : []),
    { id: "straddle", label: "Straddle", ...move(enrichment?.expectedMove.straddle, enrichment?.expectedMove.straddlePercent) },
    { id: "sigma", label: "1σ fit", ...move(enrichment?.expectedMove.sigma, enrichment?.expectedMove.sigmaPercent) },
    { id: "skew", label: "Skew", value: skew == null ? "--" : `${skew} pp`, detail: "25d P-C" },
    { id: "slope", label: "Slope", value: slope == null ? "--" : `${slope} ${slopeAnnualized ? "pp/y" : "pts"}`, detail: slopeTo },
    { id: "volume", label: "Volume", value: summary?.expirationVolume == null ? "--" : formatCompact(summary.expirationVolume, { fixedDecimals: true }) },
    { id: "pc-volume", label: "P/C vol", value: formatRatio(summary?.putCallVolumeRatio) },
    { id: "pc-oi", label: "P/C OI", value: formatRatio(summary?.putCallOpenInterestRatio) },
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
  const liveStreaming = useLiveStreamingSetting();
  const [seededExpiration] = usePaneSettingValue<number | undefined>("expiration", undefined);
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
  const [storedOptionFieldIds] = usePaneSettingValue<OptionFieldId[]>("optionColumnIds", DEFAULT_OPTION_FIELD_IDS);
  const optionFieldIds = useMemo(() => resolveOptionFieldIds(storedOptionFieldIds), [storedOptionFieldIds]);
  const initialChainEntry = useOptionsQuery(baseRequest);
  const initialChain = useResolvedEntryValue(initialChainEntry);
  const initialExpiration = initialChain?.expirationDates.reduce((best, expiration) => (
    parsed && Math.abs(expiration - parsed.expTs) < Math.abs(best - parsed.expTs) ? expiration : best
  ), initialChain.expirationDates[0]!);
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
    return selectedExpirationMissing
      ? [...availableExpirations, selectedExpiration!].sort((left, right) => left - right) : availableExpirations;
  }, [availableExpirations, selectedExpiration, selectedExpirationMissing]);
  // Keep the date strip stable while a mouse press focuses this pane. A new
  // tab list asks the web host to reveal the active tab and can move the date
  // being clicked before mouse-up, cancelling selection of an offscreen expiry.
  const expirationPickRef = useRef<(value: string) => void>(() => {});
  const { nativePaneChrome } = useUiCapabilities();
  const selectedExpirationIndex = selectedExpiration == null ? -1 : expirationDates.indexOf(selectedExpiration);
  const expirationFilters = useMemo<QueryBarFilter[]>(() => [{
    id: "expiration",
    label: "Exp",
    inline: true,
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
  }], [expirationDates, selectedExpiration, selectedExpirationIndex]);
  // A scheduled refresh of a chain already on screen is quiet: the in-session
  // cadence would otherwise blink the footer every few seconds.
  const loading = (initialChainEntry?.phase === "loading" || initialChainEntry?.phase === "refreshing") && !chain
    || expirationChainEntry?.phase === "loading"
    || (expirationChainEntry?.phase === "refreshing" && strikeChain === null);
  // Refresh failures keep a ready entry with last-good data and an error.
  // Surface that warning even when the cached chain is still usable.
  const error = (expirationUnavailable ? "Selected expiration unavailable." : null)
    ?? initialChainEntry?.error?.message ?? expirationChainEntry?.error?.message
    ?? (initialChainEntry?.phase === "error" || expirationChainEntry?.phase === "error"
      ? "Failed to load options" : null);

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
  }, [selectedExpiration]);

  const strikes = useMemo(() => strikeChain ? buildStrikeList(strikeChain) : [], [strikeChain]);
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
  const optionQuoteTargets = useMemo(
    () => buildOptionQuoteTargets(quoteRows, {
      fallbackHeight: height,
      selectedIndex: selectedStrikeIdx,
      visibleRange: visibleStrikeRange,
    }),
    [height, quoteRows, selectedStrikeIdx, visibleStrikeRange],
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
  const liveChain = useMemo(
    () => strikeChain ? overlayOptionChainQuotes(strikeChain, optionQuoteEntries, optionQuoteFreshness).chain : null,
    [optionQuoteEntries, optionQuoteFreshness, strikeChain],
  );
  const callsByStrike = useMemo(
    () => new Map(liveChain?.calls.map((c) => [c.strike, c]) ?? []),
    [liveChain],
  );
  const putsByStrike = useMemo(
    () => new Map(liveChain?.puts.map((p) => [p.strike, p]) ?? []),
    [liveChain],
  );
  // One solve per applied batch: a streamed contract's IV comes from its live
  // midpoint, the rest from the snapshot, all against the same forward.
  const volatilities = useMemo(
    () => liveChain ? solveChainVolatilities(liveChain, spot, dividendYield) : null,
    [dividendYield, spot, liveChain],
  );
  const rows = useMemo<OptionTableRow[]>(() => strikes.map((strike) => {
    const call = callsByStrike.get(strike);
    const put = putsByStrike.get(strike);
    return {
      strike,
      call,
      put,
      impliedVolatility: volatilities?.byStrike.get(strike),
      callGreeks: volatilities ? calculateOptionGreeks(call, "call", spot, dividendYield, volatilities) : undefined,
      putGreeks: volatilities ? calculateOptionGreeks(put, "put", spot, dividendYield, volatilities) : undefined,
      isPositionStrike: !!parsed && strike === parsed.strike,
    };
  }), [callsByStrike, dividendYield, parsed, putsByStrike, spot, strikes, volatilities]);
  // Figures that summarise the whole expiry move at most once a second, so a
  // busy stream reads as a steady strip rather than flicker.
  // A new expiry, a refreshed snapshot or the underlying price arriving or
  // going stale shows at once; only the stream itself is paced.
  const summaryResetKey = useMemo(() => ({}), [strikeSelectionKey, strikeChain, spot == null]);
  const summaryInput = useThrottledValue(
    useMemo(() => ({ chain: liveChain, spot, volatilities }), [liveChain, spot, volatilities]),
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
    catalogue: availableExpirations, spot, spotAsOf: underlying?.quote?.lastUpdated,
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
    }).catch(() => {});
  }, [dialog, enrichment]);
  usePaneFooter("options-enrichment", () => ({ info: [
    ...(enrichmentState.loading ? [{ id: "enrichment-loading", parts: [{ text: "loading analytics", tone: "muted" as const }] }] : []),
    ...(enrichment?.asOf ? [{ id: "enrichment-asof",
      title: analyticsAsOfRows(enrichment).map((row) => `${row.label}: ${row.value}`).join("\n"),
      parts: [{ text: `Analytics ${enrichment.asOf.slice(0, 16).replace("T", " ")} UTC`, tone: "muted" as const }] }] : []),
  ] }), [enrichmentState.loading, enrichment]);
  const optionQuoteCoverage = useMemo(
    () => resolveOptionQuoteCoverage(
      optionQuoteTargets,
      optionQuoteEntries,
      optionQuoteFreshness,
    ),
    [optionQuoteEntries, optionQuoteFreshness, optionQuoteTargets],
  );
  const optionColumns = useMemo<OptionColumn[]>(() => createOptionColumns(optionFieldIds).map((column) => ({
    ...column,
    headerColor: optionColumnColor(column, colors.panel),
  })), [optionFieldIds]);

  const selectedRow = rows[selectedStrikeIdx] ?? null;
  const selectedContractAvailable = !selectedContract || (selectedContract.side === "call"
    ? selectedRow?.call : selectedRow?.put)?.contractSymbol === selectedContract.contractSymbol;
  const selectedSide = selectedContract
    ? selectedContractAvailable ? selectedContract.side : null
    : resolveCalcSide(calcSide, parsed?.side, selectedRow);
  const selectedReference = optionMarketReference(selectedSide === "put" ? selectedRow?.put
    : selectedSide === "call" ? selectedRow?.call : undefined);
  const calcParams = useMemo(() => buildChainCalcParams({
    symbol: effectiveTicker,
    row: selectedRow,
    side: selectedSide,
    // On an option ticker the pane quote is the contract's own price, so load
    // the underlying snapshot rather than silently using the option mark as spot.
    spot,
    dividendYield,
  }), [dividendYield, effectiveTicker, selectedSide, selectedRow, spot]);

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
        asOf: new Date(underlying?.quote?.lastUpdated ?? Date.now()).toISOString() } });
  }, [scenarioContract, scenarioAvailable, scenarioMid, scenarioVolatility, createPaneFromTemplate, dividendYield, effectiveTicker,
    effectiveExchange, selectedSide, spot, underlying?.quote?.lastUpdated]);

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

  const footerHints = useMemo(() => [
    ...(sideTarget ? [{ id: "side", key: SIDE_KEY, label: ` ${sideTarget}`, title: sideTarget === "put" ? "Select Put" : "Select Call", onPress: switchSide }] : []),
    ...(calcParams ? [{ id: "calc", key: "c", label: "alc", onPress: openCalculator }] : []),
    ...(scenarioAvailable ? [{ id: "scenario", key: "a", label: "dd to OSA", onPress: openScenario }] : []),
    ...(ticker && selectedExpiration != null ? [{ id: "surface", key: "s", label: "urface", onPress: openSurface }] : []),
  ], [sideTarget, switchSide, calcParams, openCalculator, scenarioAvailable, openScenario, ticker, selectedExpiration, openSurface]);

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
  ], [defaultStrikeIndex, dialog, enrichment?.asOf, expirationDates.length, goToDefaultStrike, parsed,
    selectAdjacentExpiration, selectedExpirationIndex, showAnalyticsAsOf]);

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
    chain,
    error: [error, underlyingStale ? "Underlying quote stale: Greeks and calculator unavailable" : null,
      selectedContract && strikeChain && !selectedContractAvailable
        ? `Selected ${formatStrikeLabel(selectedContract.strike)} ${selectedContract.side} unavailable` : null,
      summary?.historicalVolatilityUnavailableReason, dailyHistoryEntry?.error?.message].filter(Boolean).join(" · ") || null,
    focused,
    hints: footerHints,
    loading,
    quoteCoverage: optionQuoteCoverage,
    reference: selectedReference,
    spreadColumnVisible: optionFieldIds.includes("spread"),
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
    if (event.ctrl || event.meta || event.alt || event.shift) return;

    const expiryStep = isPlainKey(event, EXPIRY_PREVIOUS_KEY) || (!nestedInTabs && isPlainKey(event, "h", "left")) ? -1
      : isPlainKey(event, EXPIRY_NEXT_KEY) || (!nestedInTabs && isPlainKey(event, "l", "right")) ? 1 : 0;
    if (expiryStep) {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentExpiration(expiryStep);
      return;
    }
    if (isPlainKey(event, "s") && ticker && selectedExpiration != null) {
      event.preventDefault();
      event.stopPropagation();
      openSurface();
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
    return <EmptyState title="No ticker selected." message="Select a ticker to view options." />;
  }
  if (loading && !chain) return <Spinner label="Loading options chain..." />;
  if (error && !chain) return <EmptyState title="Options chain unavailable." message={error} />;
  if (!chain || expirationDates.length === 0) {
    return <EmptyState title={`No options available for ${effectiveTicker}.`} />;
  }

  const positionContracts = isOpt && parsed
    ? ticker.metadata.positions.reduce((sum, p) => sum + Math.abs(p.shares) * signedPositionDirection(p), 0)
    : 0;
  // The root insets the terminal body, so the band gets the width inside it.
  const statWidth = Math.max(1, width - (nativePaneChrome ? 0 : 2));
  const statItems = optionsSummaryItems({
    summary, enrichment, currency: underlying?.quote?.currency ?? ticker.metadata.currency ?? "",
    ivRank: showIvRank ? { stats: ivRank } : null,
  });
  // The band keeps the chain's row budget (3, 4 or 6 rows by width). A live
  // Slope or IVR detail is the widest cell and would otherwise halve the
  // columns and push the chain down; the detail is cut short instead.
  const statRowBudget = width >= 110 ? 3 : width >= 65 ? 4 : 6;
  const statColumns = Math.max(statGridColumns(statItems, statWidth), Math.ceil(statItems.length / statRowBudget));
  const summaryRowCount = Math.min(statGridRows(statItems, statWidth, statColumns), Math.max(0, height - 6));
  // No term here follows the selection or the load, so an empty cold-expiry
  // response cannot resize the table: growing it during loading would turn a
  // clamped scroll into apparent user navigation.
  const tableHeight = Math.max(1, height - 1 - summaryRowCount - (isOpt && parsed ? 1 : 0));
  // Desktop: the expiry bar and the chain run edge to edge like every other
  // pane, so the inset moves from the column onto the rows that need it.
  const inset = nativePaneChrome ? 1 : 0;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={nativePaneChrome ? 0 : 1}>
      <QueryBar width={Math.max(1, width - 2)} filters={expirationFilters} />

      {summaryRowCount > 0 && (
        <StatGrid items={statItems.slice(0, summaryRowCount * statColumns)} width={statWidth} columns={statColumns} />
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
        emptyStateTitle={error && !strikeChain ? "Selected expiration unavailable." : strikesLoading ? "Loading strikes..." : "No strikes available."}
        rootWidth={Math.max(1, width - 2 + inset * 2)}
        rootHeight={tableHeight}
        columnGap={0}
        horizontalPadding={inset}
        scrollToIndex={selectedStrikeIdx >= 0 ? selectedStrikeIdx : undefined}
        scrollToIndexAlign={scrollToIndexAlign}
        scrollToIndexVersion={autoScrollVersion}
      />
    </Box>
  );
}
