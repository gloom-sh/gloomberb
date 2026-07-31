import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "../../../ui";
import { usePaneTicker } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { formatExpDate, resolveOptionsTarget } from "../../../utils/options";
import { useOptionsQuery, useResolvedEntryValue } from "../../../market-data/hooks";
import {
  DataTableView,
  Spinner,
  Tabs,
  type DataTableKeyEvent,
  type DataTableVisibleRange,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import {
  OPTION_COLUMNS,
  buildStrikeList,
  findNearestStrikeIndex,
  optionColumnColor,
  renderOptionCell,
  resolveDefaultStrikeTarget,
} from "./table";
import type { OptionColumn, OptionTableRow, OptionsViewProps } from "./types";
import {
  buildOptionQuoteTargets,
  OPTIONS_CHAIN_REFRESH_INTERVAL_MS,
  overlayOptionRowQuotes,
  resolveOptionQuoteCoverage,
} from "./live-quotes";
import { useOptionsAccessFooter } from "./footer";

export function OptionsView({ width, height, focused, onCapture = () => {} }: OptionsViewProps) {
  const { ticker, financials } = usePaneTicker();
  const [expIdx, setExpIdx] = useState(0);
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
  const initialChainEntry = useOptionsQuery(baseRequest);
  const initialChain = useResolvedEntryValue(initialChainEntry);
  const selectedExpiration = initialChain?.expirationDates[expIdx];
  const viewportKey = `${effectiveTicker}:${selectedExpiration ?? "initial"}`;
  const expirationChainEntry = useOptionsQuery(
    baseRequest && selectedExpiration != null
      ? { ...baseRequest, expirationDate: selectedExpiration }
      : null,
    { refreshIntervalMs: OPTIONS_CHAIN_REFRESH_INTERVAL_MS },
  );
  const expirationChain = useResolvedEntryValue(expirationChainEntry);
  const chain = expirationChain ?? initialChain;
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

  const strikes = useMemo(() => chain ? buildStrikeList(chain) : [], [chain]);
  const callsByStrike = useMemo(
    () => new Map(chain?.calls.map((c) => [c.strike, c]) ?? []),
    [chain],
  );
  const putsByStrike = useMemo(
    () => new Map(chain?.puts.map((p) => [p.strike, p]) ?? []),
    [chain],
  );
  const snapshotRows = useMemo<OptionTableRow[]>(() => strikes.map((strike) => ({
    strike,
    call: callsByStrike.get(strike),
    put: putsByStrike.get(strike),
    isPositionStrike: !!parsed && Math.abs(strike - parsed.strike) < 0.01,
  })), [callsByStrike, parsed, putsByStrike, strikes]);
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
  const optionColumns: OptionColumn[] = OPTION_COLUMNS.map((column) => ({
    ...column,
    headerColor: optionColumnColor(column.id, colors.panel),
  }));

  useOptionsAccessFooter({
    chain,
    error,
    focused,
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
    const targetStrike = resolveDefaultStrikeTarget(parsed?.strike, financials?.quote?.price);
    if (targetStrike == null) return;
    setScrollToIndexAlign("center");
    setStrikeIdx(findNearestStrikeIndex(strikes, targetStrike));
    setAutoScrollVersion((version) => version + 1);
  }, [expIdx, financials?.quote?.price, parsed?.strike, strikes]);

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
  }, [enterInteractive, exitInteractive, interactive, selectAdjacentExpiration, strikes.length]);

  if (!ticker) return <Text fg={colors.textDim}>Select a ticker to view options.</Text>;
  if (loading && !chain) return <Spinner label="Loading options chain..." />;
  if (error) return <Text fg={colors.textDim}>{error}</Text>;
  if (!chain || chain.expirationDates.length === 0) return <Text fg={colors.textDim}>No options available for {effectiveTicker}.</Text>;

  const posShares = isOpt && parsed
    ? ticker.metadata.positions.reduce((sum, p) => sum + p.shares, 0)
    : 0;
  const expirationTabsWidth = Math.max(width - 7 - (loading ? 2 : 0), 8);

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1} onMouseDown={() => { if (!interactive) enterInteractive(); }}>
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
        visibleRangeKey={viewportKey}
        onVisibleRangeChange={handleVisibleStrikeRangeChange}
        getItemKey={(row) => String(row.strike)}
        renderCell={renderOptionCell}
        emptyStateTitle="No strikes available."
        columnGap={0}
        horizontalPadding={0}
        fillAvailableWidth={false}
        scrollToIndex={strikeIdx}
        scrollToIndexAlign={scrollToIndexAlign}
        scrollToIndexVersion={autoScrollVersion}
      />
    </Box>
  );
}
