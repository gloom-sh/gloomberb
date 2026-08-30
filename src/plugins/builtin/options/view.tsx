import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "../../../ui";
import { usePaneSettingValue, usePaneTicker } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { formatCompact } from "../../../utils/format";
import { formatExpDate, resolveOptionsTarget } from "../../../utils/options";
import { useOptionsQuery, useResolvedEntryValue, useTickerFinancials } from "../../../market-data/hooks";
import {
  DataTableView,
  EmptyState,
  Spinner,
  Tabs,
  type DataTableKeyEvent,
  type DataTableVisibleRange,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import { usePluginAppActions } from "../../runtime";
import {
  OPTIONS_CALCULATOR_TEMPLATE_ID,
  type OptionSide,
} from "../options-calculator/model";
import { buildChainCalcParams, resolveCalcSide } from "./calc-seed";
import { calculateOptionGreeks, calculateOptionsSummary, type OptionsSummary } from "./analytics";
import {
  DEFAULT_OPTION_FIELD_IDS,
  buildStrikeList,
  createOptionColumns,
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
  overlayOptionRowQuotes,
  resolveOptionQuoteCoverage,
  resolveChainRefreshIntervalMs,
} from "./live-quotes";
import { useOptionsAccessFooter } from "./footer";
import { useLiveStreamingSetting } from "../shared/live-streaming";

type SummaryMetric = { label: string; value: string };

function formatRatio(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toFixed(2);
}

function SummaryRow({ metrics }: { metrics: SummaryMetric[] }) {
  return (
    <Box flexDirection="row" height={1} gap={3} overflow="hidden">
      {metrics.map((metric) => (
        <Box key={metric.label} flexDirection="row" flexShrink={0}>
          <Text fg={colors.textDim}>{`${metric.label} `}</Text>
          <Text fg={colors.textBright}>{metric.value}</Text>
        </Box>
      ))}
    </Box>
  );
}

function OptionsSummaryStrip({ summary, secondary }: {
  summary: OptionsSummary | null;
  secondary: boolean;
}) {
  const volatility: SummaryMetric[] = [
    { label: "ATM IV", value: formatIv(summary?.atmImpliedVolatility ?? undefined) },
    { label: "HV30", value: formatIv(summary?.historicalVolatility30d ?? undefined) },
    { label: "IV/HV", value: formatRatio(summary?.impliedHistoricalRatio) },
  ];
  return (
    <Box flexDirection="column" height={secondary ? 2 : 1}>
      <SummaryRow metrics={volatility} />
      {secondary && (
        <SummaryRow metrics={[
          { label: "EXP VOL", value: summary ? formatCompact(summary.expirationVolume) : "—" },
          { label: "P/C VOL", value: formatRatio(summary?.putCallVolumeRatio) },
          { label: "P/C OI", value: formatRatio(summary?.putCallOpenInterestRatio) },
        ]} />
      )}
    </Box>
  );
}

export function OptionsView({ width, height, focused, onCapture = () => {} }: OptionsViewProps) {
  const { ticker, financials } = usePaneTicker();
  const { createPaneFromTemplate } = usePluginAppActions();
  const liveStreaming = useLiveStreamingSetting();
  const [expIdx, setExpIdx] = useState(0);
  const [calcSide, setCalcSide] = useState<OptionSide | null>(null);
  const [strikeIdx, setStrikeIdx] = useState(0);
  const [autoScrollVersion, setAutoScrollVersion] = useState(0);
  const [scrollToIndexAlign, setScrollToIndexAlign] = useState<"nearest" | "center">("nearest");
  const [visibleStrikeViewport, setVisibleStrikeViewport] = useState<{
    key: string;
    range: DataTableVisibleRange;
  } | null>(null);
  const [interactive, setInteractive] = useState(false);
  const userSelectedStrikeRef = useRef(false);
  const onCaptureRef = useRef(onCapture);
  const target = resolveOptionsTarget(ticker);
  const isOpt = target?.isOptionTicker ?? false;
  const parsed = target?.parsedOption ?? null;
  const effectiveTicker = target?.effectiveTicker ?? "";
  const effectiveExchange = target?.effectiveExchange ?? "";
  const underlyingFinancials = useTickerFinancials(isOpt ? effectiveTicker : null, null);
  const underlying = isOpt ? underlyingFinancials : financials;
  const spot = underlying?.quote?.price;
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
  const [chainRefreshMinutes] = usePaneSettingValue<string>("chainRefreshMinutes", "");
  const [storedOptionFieldIds] = usePaneSettingValue<OptionFieldId[]>("optionColumnIds", DEFAULT_OPTION_FIELD_IDS);
  const optionFieldIds = useMemo(() => resolveOptionFieldIds(storedOptionFieldIds), [storedOptionFieldIds]);
  const initialChainEntry = useOptionsQuery(baseRequest);
  const initialChain = useResolvedEntryValue(initialChainEntry);
  const selectedExpiration = initialChain?.expirationDates[expIdx];
  const viewportKey = `${effectiveTicker}:${selectedExpiration ?? "initial"}`;
  const expirationChainEntry = useOptionsQuery(
    baseRequest && selectedExpiration != null
      ? { ...baseRequest, expirationDate: selectedExpiration }
      : null,
    { refreshIntervalMs: resolveChainRefreshIntervalMs(chainRefreshMinutes) },
  );
  const expirationChain = useResolvedEntryValue(expirationChainEntry);
  // The expiration strip is expiry-independent, but strikes must never come from
  // a different expiration than the selected one: the initial chain only covers
  // whichever expiry the provider defaulted to.
  const chain = expirationChain ?? initialChain;
  const initialChainExpiration = initialChain?.calls[0]?.expiration ?? initialChain?.puts[0]?.expiration ?? null;
  const strikeChain = expirationChain
    ?? (selectedExpiration == null || initialChainExpiration === selectedExpiration ? initialChain : null);
  const strikesLoading = strikeChain === null;
  const expirationCount = chain?.expirationDates.length ?? 0;
  const loading = (initialChainEntry?.phase === "loading" || initialChainEntry?.phase === "refreshing") && !chain
    || (expirationChainEntry?.phase === "loading" || expirationChainEntry?.phase === "refreshing");
  const error = initialChainEntry?.phase === "error"
    ? initialChainEntry.error?.message ?? "Failed to load options"
    : expirationChainEntry?.phase === "error"
      ? expirationChainEntry.error?.message ?? "Failed to load options"
      : null;

  useEffect(() => {
    onCaptureRef.current = onCapture;
  }, [onCapture]);

  const enterInteractive = useCallback(() => {
    if (!interactive) {
      setInteractive(true);
      onCaptureRef.current(true);
    }
  }, [interactive]);

  const exitInteractive = useCallback(() => {
    if (interactive) {
      setInteractive(false);
      onCaptureRef.current(false);
    }
  }, [interactive]);

  const selectAdjacentExpiration = useCallback((offset: -1 | 1) => {
    if (expirationCount === 0) return;
    setExpIdx((index) => Math.max(0, Math.min(index + offset, expirationCount - 1)));
  }, [expirationCount]);

  useEffect(() => {
    userSelectedStrikeRef.current = false;
    setScrollToIndexAlign("nearest");
    setInteractive(false);
    onCaptureRef.current(false);
    setExpIdx(0);
    setStrikeIdx(0);
    setCalcSide(null);
  }, [effectiveTicker]);

  useEffect(() => {
    if (!parsed || !initialChain || initialChain.expirationDates.length === 0) return;
    const bestExpIdx = initialChain.expirationDates.reduce((best, ts, i) =>
      Math.abs(ts - parsed.expTs) < Math.abs(initialChain.expirationDates[best]! - parsed.expTs) ? i : best, 0);
    if (bestExpIdx !== expIdx) {
      setExpIdx(bestExpIdx);
    }
  }, [expIdx, initialChain, parsed]);

  useEffect(() => {
    userSelectedStrikeRef.current = false;
  }, [expIdx]);

  const strikes = useMemo(() => strikeChain ? buildStrikeList(strikeChain) : [], [strikeChain]);
  const callsByStrike = useMemo(
    () => new Map(strikeChain?.calls.map((c) => [c.strike, c]) ?? []),
    [strikeChain],
  );
  const putsByStrike = useMemo(
    () => new Map(strikeChain?.puts.map((p) => [p.strike, p]) ?? []),
    [strikeChain],
  );
  const snapshotRows = useMemo<OptionTableRow[]>(() => {
    const now = Date.now();
    return strikes.map((strike) => {
      const call = callsByStrike.get(strike);
      const put = putsByStrike.get(strike);
      return {
        strike,
        call,
        put,
        callGreeks: calculateOptionGreeks(call, "call", spot, dividendYield, now),
        putGreeks: calculateOptionGreeks(put, "put", spot, dividendYield, now),
        isPositionStrike: !!parsed && Math.abs(strike - parsed.strike) < 0.01,
      };
    });
  }, [callsByStrike, dividendYield, parsed, putsByStrike, spot, strikes]);
  const summary = useMemo(
    () => strikeChain
      ? calculateOptionsSummary(strikeChain, spot, underlying?.priceHistory ?? [])
      : null,
    [spot, strikeChain, underlying?.priceHistory],
  );
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
    () => buildOptionQuoteTargets(snapshotRows, {
      fallbackHeight: height,
      selectedIndex: strikeIdx,
      visibleRange: visibleStrikeRange,
    }),
    [height, snapshotRows, strikeIdx, visibleStrikeRange],
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
  const rows = useMemo(
    () => overlayOptionRowQuotes(snapshotRows, optionQuoteEntries, optionQuoteFreshness),
    [optionQuoteEntries, optionQuoteFreshness, snapshotRows],
  );
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

  const selectedRow = rows[strikeIdx] ?? null;
  const calcParams = useMemo(() => buildChainCalcParams({
    symbol: effectiveTicker,
    row: selectedRow,
    side: resolveCalcSide(calcSide, parsed?.side, selectedRow),
    // On an option ticker the pane quote is the contract's own price, so load
    // the underlying snapshot rather than silently using the option mark as spot.
    spot,
    dividendYield,
  }), [calcSide, dividendYield, effectiveTicker, parsed?.side, selectedRow, spot]);

  const openCalculator = useCallback(() => {
    if (!calcParams) return;
    createPaneFromTemplate(OPTIONS_CALCULATOR_TEMPLATE_ID, { values: calcParams });
  }, [calcParams, createPaneFromTemplate]);

  const footerHints = useMemo(
    () => (calcParams ? [{ id: "calc", key: "c", label: "alc", onPress: openCalculator }] : undefined),
    [calcParams, openCalculator],
  );

  const renderCell = useCallback((
    row: OptionTableRow,
    column: OptionColumn,
    index: number,
    rowState: { selected: boolean },
  ) => {
    const cell = renderOptionCell(row, column, index, rowState);
    if (!column.side) return cell;
    // Clicking a call or put cell is the mouse way to choose which contract
    // [c]alc opens, so it has to select the row itself as well.
    const side: OptionSide = column.side;
    return {
      ...cell,
      onMouseDown: () => {
        enterInteractive();
        userSelectedStrikeRef.current = true;
        setScrollToIndexAlign("nearest");
        setStrikeIdx(index);
        setCalcSide(side);
      },
    };
  }, [enterInteractive]);

  useOptionsAccessFooter({
    chain,
    error,
    focused,
    hints: footerHints,
    loading,
    quoteCoverage: optionQuoteCoverage,
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
  }, [expIdx, parsed?.strike, spot, strikes]);

  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.targetEditable) return;
    if (event.ctrl || event.meta || event.alt || event.shift) return;

    const isEnter = event.name === "enter" || event.name === "return";
    const isEscape = event.name === "escape" || event.name === "esc";
    if (isEnter && !interactive) {
      event.preventDefault();
      event.stopPropagation();
      enterInteractive();
      return;
    }
    if (isEscape && interactive) {
      event.preventDefault();
      event.stopPropagation();
      exitInteractive();
      return;
    }
    if (interactive && isPlainKey(event, "h", "left")) {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentExpiration(-1);
      return;
    }
    if (interactive && isPlainKey(event, "l", "right")) {
      event.preventDefault();
      event.stopPropagation();
      selectAdjacentExpiration(1);
      return;
    }
    if (isPlainKey(event, "c") && calcParams) {
      event.preventDefault();
      event.stopPropagation();
      openCalculator();
    }
  }, { enabled: focused, phase: "before" });

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    const isEnter = event.name === "enter" || event.name === "return";

    if (isEnter && !interactive) {
      event.preventDefault?.();
      event.stopPropagation?.();
      enterInteractive();
      return true;
    }
    if (event.name === "escape" && interactive) {
      event.preventDefault?.();
      event.stopPropagation?.();
      exitInteractive();
      return true;
    }
    if (interactive && isPlainKey(event, "h", "left")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      selectAdjacentExpiration(-1);
      return true;
    }
    if (interactive && isPlainKey(event, "l", "right")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      selectAdjacentExpiration(1);
      return true;
    }

    if (isPlainKey(event, "c") && calcParams) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openCalculator();
      return true;
    }

    if (isPlainKey(event, "j", "down")) {
      if (strikes.length === 0) return true;
      event.preventDefault?.();
      event.stopPropagation?.();
      userSelectedStrikeRef.current = true;
      setScrollToIndexAlign("nearest");
      setStrikeIdx((i) => Math.min(i + 1, strikes.length - 1));
      return true;
    }
    if (isPlainKey(event, "k", "up")) {
      if (strikes.length === 0) return true;
      event.preventDefault?.();
      event.stopPropagation?.();
      userSelectedStrikeRef.current = true;
      setScrollToIndexAlign("nearest");
      setStrikeIdx((i) => Math.max(i - 1, 0));
      return true;
    }

    return false;
  }, [
    calcParams,
    enterInteractive,
    exitInteractive,
    interactive,
    openCalculator,
    selectAdjacentExpiration,
    strikes.length,
  ]);

  if (!ticker) {
    return <EmptyState title="No ticker selected." message="Select a ticker to view options." />;
  }
  if (loading && !chain) return <Spinner label="Loading options chain..." />;
  if (error) return <EmptyState title="Options chain unavailable." message={error} />;
  if (!chain || chain.expirationDates.length === 0) {
    return <EmptyState title={`No options available for ${effectiveTicker}.`} />;
  }

  const posShares = isOpt && parsed
    ? ticker.metadata.positions.reduce((sum, p) => sum + p.shares, 0)
    : 0;
  const expirationTabsWidth = Math.max(width - 9 - (loading ? 2 : 0), 8);
  const summaryRowCount = height >= 10 ? 2 : height >= 7 ? 1 : 0;
  const tableHeight = Math.max(1, height - 1 - summaryRowCount - (isOpt && parsed ? 1 : 0));
  // The strip scrolls; without a marker a clipped last date reads as the last expiry.
  const expirationStripOverflows = chain.expirationDates
    .reduce((total, ts) => total + formatExpDate(ts).length + 2, 0) > expirationTabsWidth;

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} onMouseDown={() => { if (!interactive) enterInteractive(); }}>
      {summaryRowCount > 0 && (
        <OptionsSummaryStrip summary={summary} secondary={summaryRowCount > 1} />
      )}

      <Box flexDirection="row" height={1} gap={1}>
        <Text fg={colors.textDim}>Exp:</Text>
        <Box width={expirationTabsWidth} height={1} overflow="hidden">
          <Tabs
            tabs={chain.expirationDates.map((ts, i) => ({
              label: formatExpDate(ts),
              value: String(i),
            }))}
            activeValue={String(expIdx)}
            onSelect={(value) => {
              enterInteractive();
              setExpIdx(Number(value));
            }}
            compact
            variant="bare"
            focused={focused && interactive}
            keyboardNavigation={false}
            scrollId="options-expiration-tabs-scroll"
          />
        </Box>
        {expirationStripOverflows && <Text fg={colors.textDim}>{"\u203a"}</Text>}
        {loading && <Spinner />}
      </Box>

      {isOpt && parsed && (
        <Box height={1}>
          <Text fg={colors.textBright}>
            {`Position: ${posShares} ${parsed.side === "C" ? "call" : "put"} contract${posShares !== 1 ? "s" : ""} @ $${parsed.strike}`}
          </Text>
        </Box>
      )}

      <DataTableView<OptionTableRow, OptionColumn>
        focused={focused}
        selection={{
          kind: "index",
          selectedIndex: strikeIdx,
          onChange: (index) => {
            userSelectedStrikeRef.current = true;
            setScrollToIndexAlign("nearest");
            enterInteractive();
            setStrikeIdx(index);
          },
        }}
        onCursorChange={(_row, index) => {
          userSelectedStrikeRef.current = true;
          setScrollToIndexAlign("nearest");
          enterInteractive();
          setStrikeIdx(index);
        }}
        onRootKeyDown={handleTableKeyDown}
        headerScrollId="options-table-header-scroll"
        bodyScrollId="options-table-body-scroll"
        columns={optionColumns}
        items={rows}
        sortColumnId={null}
        sortDirection="asc"
        onHeaderClick={() => {}}
        onTableMouseDown={enterInteractive}
        onBodyScrollActivity={() => { userSelectedStrikeRef.current = true; }}
        visibleRangeKey={viewportKey}
        onVisibleRangeChange={handleVisibleStrikeRangeChange}
        getItemKey={(row) => String(row.strike)}
        renderCell={renderCell}
        emptyStateTitle={strikesLoading ? "Loading strikes..." : "No strikes available."}
        rootWidth={Math.max(1, width - 2)}
        rootHeight={tableHeight}
        columnGap={0}
        horizontalPadding={0}
        scrollToIndex={strikeIdx}
        scrollToIndexAlign={scrollToIndexAlign}
        scrollToIndexVersion={autoScrollVersion}
      />
    </Box>
  );
}
