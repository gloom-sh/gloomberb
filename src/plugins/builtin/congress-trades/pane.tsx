import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useRendererHost, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableStackView,
  PaneStatusBody,
  Tabs,
  usePaneNoticeFooter,
  usePaneFooter,
  ChoiceDialog,
  useTableLoadMore,
} from "../../../components";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../runtime";
import { useShortcut } from "../../../react/input";
import { isDetailBackNavigationKey } from "../../../utils/back-navigation";
import { useAutoRefresh } from "../shared/auto-refresh";
import { useInlineTickerOpener } from "../../../state/hooks/inline-tickers";
import {
  type CloudCongressHousePayload,
  type CloudCongressMemberPayload,
  type CloudCongressTradePayload,
  type CloudCongressTickerPayload,
} from "../../../api-client";
import type { PaneProps } from "../../../types/plugin";
import {
  CONGRESS_FILING_LIMIT,
  CONGRESS_MEMBER_FILING_LIMIT,
  CONGRESS_TRADE_LIMIT,
  CONGRESS_TRADES_PANE_ID,
  canLoadMoreCongress,
  mergeCongressPages,
  nextCongressPage,
  buildMemberColumns,
  buildTradeColumns,
  congressScanNotice,
  nextSort,
  previousCongressYearPage,
  selectedIndexById,
  sortedMembers,
  sortedTrades,
  sortedTickers,
  buildTickerColumns,
  type TickerColumn,
  type TickerColumnId,
  type CongressTab,
  type DetailMode,
  type LoadStatus,
  type MemberColumn,
  type MemberColumnId,
  type SortDirection,
  type TradeColumn,
  type TradeColumnId,
} from "./model";
import { MemberTradesDetail, TradeDetail } from "./detail";
import { useCongressTradesFooter } from "./footer";
import { useCongressTradesKeyboard } from "./keyboard";
import {
  renderCongressMemberCell,
  renderCongressTradeCell,
  renderCongressTickerCell,
} from "./table";
import { loadCongressHouse } from "./client";
import { useMineTickers } from "../shared/mine-tickers";
import { aggregateLoadedCongress } from "./aggregates";
import { CongressFilterBar, type CongressFilters } from "./filters";
import type { SelectControl } from "../../../components/ui/select-button";
import { colors } from "../../../theme/colors";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { isPlainKey } from "../../../utils/keyboard";
import type { DataTableKeyEvent } from "../../../components";

export { CONGRESS_TRADES_PANE_ID } from "./model";

export function CongressTradesPane({ focused, width, height, tickerFilter }: PaneProps & { tickerFilter?: string }) {
  const rendererHost = useRendererHost();
  const dialog = useDialog();
  const statePrefix = tickerFilter ? "congressTicker." : "";
  const mineTickers = useMineTickers();
  const [mine, setMine] = usePluginPaneState(`${statePrefix}mine`, false);
  const [filters, setFilters] = usePluginPaneState<CongressFilters>(`${statePrefix}filters`, {});
  const chamberControl = useRef<SelectControl | null>(null);
  const sideControl = useRef<SelectControl | null>(null);
  const ownerControl = useRef<SelectControl | null>(null);
  const assetControl = useRef<SelectControl | null>(null);
  const amountControl = useRef<SelectControl | null>(null);
  const filterKey = JSON.stringify(filters);
  const [payload, setPayload] = useState<CloudCongressHousePayload | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const tradeScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [savedTab, setActiveTab] = usePluginPaneState<CongressTab>(`${statePrefix}activeTab`, "trades");
  const activeTab = tickerFilter ? "trades" : savedTab;
  const [selectedTradeId, setSelectedTradeId] = useDebouncedPluginPaneState<string | null>(`${statePrefix}selectedTradeId`, null);
  const [selectedMemberId, setSelectedMemberId] = useDebouncedPluginPaneState<string | null>(`${statePrefix}selectedMemberId`, null);
  const [detailMode, setDetailMode] = usePluginPaneState<DetailMode>(`${statePrefix}detailMode`, null);
  const [selectedTicker, setSelectedTicker] = usePluginPaneState<string | null>(`${statePrefix}selectedTicker`, null);
  const [tickerSort, setTickerSort] = useState<{ columnId: TickerColumnId; direction: SortDirection }>({ columnId: "buyCount", direction: "desc" });
  const [tradeSort, setTradeSort] = useState<{ columnId: TradeColumnId; direction: SortDirection }>({
    columnId: "filed",
    direction: "desc",
  });
  const [memberSort, setMemberSort] = useState<{ columnId: MemberColumnId; direction: SortDirection }>({
    columnId: "trades",
    direction: "desc",
  });
  const fetchGenRef = useRef(0);
  const pageBusy = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback((refresh = false) => {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setStatus((current) => (current === "loaded" && !refresh ? "loaded" : "loading"));
    setError(null);
    setLoadingMore(false);
    pageBusy.current = false;
    loadCongressHouse({
      ...filters,
      chamber: filters.chamber ?? "all",
      limit: CONGRESS_TRADE_LIMIT,
      filingLimit: CONGRESS_FILING_LIMIT,
      refresh,
      ticker: tickerFilter,
    }, undefined, abortRef.current.signal)
      .then((nextPayload) => {
        if (fetchGenRef.current !== gen) return;
        setPayload((current) => (
          refresh && current ? { ...current, asOf: nextPayload.asOf, trades: mergeCongressPages(current, nextPayload).trades } : nextPayload
        ));
        setStatus("loaded");
        setLastLoadedAt(Date.now());
      })
      .catch((loadError) => {
        if (fetchGenRef.current !== gen) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, [tickerFilter, filterKey]);

  const loadPage = useCallback((request: ReturnType<typeof nextCongressPage>) => {
    if (!request || !payload || pageBusy.current) return;
    pageBusy.current = true;
    const gen = fetchGenRef.current;
    setLoadingMore(true);
    loadCongressHouse({
      ...filters,
      chamber: filters.chamber ?? "all",
      ...request,
      limit: CONGRESS_TRADE_LIMIT,
      filingLimit: CONGRESS_FILING_LIMIT,
      ticker: tickerFilter,
    }, undefined, abortRef.current?.signal)
      .then((nextPayload) => {
        if (fetchGenRef.current !== gen) return;
        setPayload((current) => {
          if (!current) return nextPayload;
          return mergeCongressPages(current, nextPayload);
        });
      })
      .catch((loadError) => {
        if (fetchGenRef.current !== gen) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (fetchGenRef.current !== gen) return;
        setLoadingMore(false);
        pageBusy.current = false;
      });
  }, [payload, tickerFilter, filterKey]);

  const loadMore = useCallback(() => {
    if (!payload || loadingMore || status !== "loaded") return;
    loadPage(nextCongressPage(payload));
  }, [loadPage, loadingMore, payload, status]);

  // Each earlier year is a fresh set of documents to read, so it waits to be asked for.
  const previousYearRequest = payload && !canLoadMoreCongress(payload)
    ? previousCongressYearPage(payload)
    : null;
  const loadPreviousYear = useCallback(() => {
    if (loadingMore || status !== "loaded" || !previousYearRequest) return;
    loadPage(previousYearRequest);
  }, [loadPage, loadingMore, previousYearRequest, status]);

  const onTradeScroll = useTableLoadMore(
    tradeScrollRef,
    !!payload && status === "loaded" && !loadingMore && canLoadMoreCongress(payload),
    loadMore,
  );

  useEffect(() => {
    setPayload(null);
    load(false);
    return () => { fetchGenRef.current += 1; abortRef.current?.abort(); };
  }, [load]);

  // Filings would otherwise age indefinitely in an open pane.
  const refresh = useCallback(() => {
    load(true);
  }, [load]);
  useShortcut((event) => {
    if (!focused || event.targetEditable) return;
    if (tickerFilter && detailMode && isDetailBackNavigationKey(event)) {
      event.preventDefault?.(); event.stopPropagation?.(); setDetailMode(null); return;
    }
    if (!payload && isPlainKey(event, "r")) { event.preventDefault?.(); event.stopPropagation?.(); refresh(); }
  }, { phase: "before" });
  useAutoRefresh(lastLoadedAt, refresh);

  const trades = payload?.trades ?? [];
  const visibleTrades = useMemo(() => mine ? trades.filter((trade) => trade.ticker && mineTickers.has(trade.ticker)) : trades, [trades, mine, mineTickers]);
  const summaries = useMemo(() => aggregateLoadedCongress(visibleTrades, payload?.members), [visibleTrades, payload?.members]);
  const members = summaries.members;
  const tickerRows = useMemo(() => sortedTickers(summaries.tickers, tickerSort), [summaries.tickers, tickerSort]);
  const tickerColumns = useMemo(() => buildTickerColumns(width), [width]);
  const tradeRows = useMemo(() => sortedTrades(visibleTrades, tradeSort), [visibleTrades, tradeSort]);
  const memberRows = useMemo(() => sortedMembers(members, memberSort), [members, memberSort]);
  const tradeColumns = useMemo(() => buildTradeColumns(width, !!tickerFilter), [width, tickerFilter]);
  const memberColumns = useMemo(() => buildMemberColumns(width), [width]);
  const selectedTradeIndex = selectedIndexById(tradeRows, selectedTradeId);
  const selectedMemberIndex = selectedIndexById(memberRows, selectedMemberId);
  const selectedTrade = tradeRows[selectedTradeIndex] ?? null;
  const selectedMember = memberRows[selectedMemberIndex] ?? null;
  const detailTrade = detailMode?.kind === "trade"
    ? trades.find((trade) => trade.id === detailMode.tradeId) ?? null
    : null;
  const detailMember = detailMode?.kind === "member"
    ? members.find((member) => member.id === detailMode.memberId) ?? null
    : null;
  const detailMemberTrades = useMemo(() => (
    detailMember
      ? sortedTrades(
        trades.filter((trade) => trade.memberName === detailMember.memberName && trade.stateDistrict === detailMember.stateDistrict),
        { columnId: "filed", direction: "desc" },
      )
      : []
  ), [detailMember, trades]);

  const openTicker = useInlineTickerOpener();

  useEffect(() => {
    if (tradeRows.length === 0) {
      if (selectedTradeId !== null) setSelectedTradeId(null);
      return;
    }
    if (!selectedTrade || !selectedTradeId) {
      setSelectedTradeId(tradeRows[0]!.id);
    }
  }, [selectedTrade, selectedTradeId, setSelectedTradeId, tradeRows]);

  useEffect(() => {
    if (memberRows.length === 0) {
      if (selectedMemberId !== null) setSelectedMemberId(null);
      return;
    }
    if (!selectedMember || !selectedMemberId) {
      setSelectedMemberId(memberRows[0]!.id);
    }
  }, [memberRows, selectedMember, selectedMemberId, setSelectedMemberId]);

  useEffect(() => {
    if (!payload || status !== "loaded") return;
    if (detailMode?.kind === "trade" && !detailTrade) setDetailMode(null);
    if (detailMode?.kind === "member" && !detailMember) setDetailMode(null);
  }, [detailMember, detailMode, detailTrade, payload, status, setDetailMode]);

  const selectTab = useCallback((tab: string) => {
    setActiveTab(tab === "members" || tab === "tickers" ? tab : "trades");
    setDetailMode(null);
  }, [setActiveTab]);

  const openSelectedTradeSource = useCallback(() => {
    const trade = detailTrade ?? selectedTrade;
    if (!trade?.sourceUrl) return;
    void rendererHost.openExternal(trade.sourceUrl);
  }, [detailTrade, rendererHost, selectedTrade]);

  const openSelectedTicker = useCallback(() => {
    const ticker = activeTab === "tickers" ? selectedTicker ?? tickerRows[0]?.ticker : detailTrade?.ticker ?? selectedTrade?.ticker;
    if (ticker) openTicker(ticker);
  }, [activeTab, selectedTicker, tickerRows, detailTrade?.ticker, openTicker, selectedTrade?.ticker]);

  const openSelectedTradeMember = useCallback(() => {
    const trade = detailTrade ?? selectedTrade;
    if (!trade) return;
    const member = members.find((entry) => entry.memberName === trade.memberName && entry.stateDistrict === trade.stateDistrict);
    if (!member) return;
    setSelectedMemberId(member.id, { immediate: true });
    setDetailMode({ kind: "member", memberId: member.id });
  }, [detailTrade, members, selectedTrade, setSelectedMemberId]);

  const { handleDetailKeyDown, handleRootKeyDown } = useCongressTradesKeyboard({
    activeTab,
    detailMode,
    focused,
    load,
    loadPreviousYear: previousYearRequest ? loadPreviousYear : null,
    loadMore: payload && canLoadMoreCongress(payload) ? loadMore : null,
    openSelectedTicker,
    openSelectedTradeMember,
    openSelectedTradeSource,
    selectTab: tickerFilter ? () => {} : selectTab,
  });

  // Filings the scan has not read yet are a gap in the window on screen, so
  // they sit behind the footer's warning indicator rather than beside status.
  usePaneNoticeFooter({
    registrationId: `${CONGRESS_TRADES_PANE_ID}:${tickerFilter ?? "all"}:scan`,
    notices: [payload ? congressScanNotice(payload) : null].filter((notice): notice is string => !!notice),
    focused,
    enabled: !detailMode,
  });

  useCongressTradesFooter({
    registrationId: `${CONGRESS_TRADES_PANE_ID}:${tickerFilter ?? "all"}`,
    activeTab,
    detailMode,
    detailTrade,
    error,
    loadPreviousYear: previousYearRequest ? loadPreviousYear : null,
    loadMore: payload && canLoadMoreCongress(payload) ? loadMore : null,
    loadingMore,
    openSelectedTicker,
    openSelectedTradeMember,
    openSelectedTradeSource,
    payload,
    previousYear: previousYearRequest?.year ?? null,
    selectedTrade,
    status,
  });

  const openFilters = useCallback(async () => {
    const choice = await dialog.prompt<string>({
      content: (ctx: PromptContext<string>) => <ChoiceDialog {...ctx} title="Filter trades" choices={[
        { id: "chamber", label: "Chamber" }, { id: "side", label: "Side" }, { id: "owner", label: "Owner" },
        { id: "asset", label: "Asset type" }, { id: "amount", label: "Minimum amount" },
      ]} />,
    });
    const control = choice === "chamber" ? chamberControl : choice === "side" ? sideControl : choice === "owner" ? ownerControl : choice === "asset" ? assetControl : choice === "amount" ? amountControl : null;
    control?.current?.open();
  }, [dialog]);
  const handleFiltersKey = (event: DataTableKeyEvent) => {
    if (isPlainKey(event, "f") || isPlainKey(event, "i")) {
      event.preventDefault?.(); event.stopPropagation?.();
      if (isPlainKey(event, "f")) void openFilters(); else setMine(!mine);
      return true;
    }
    return handleRootKeyDown(event);
  };
  usePaneFooter(`${CONGRESS_TRADES_PANE_ID}:${tickerFilter ?? "all"}:filters`, () => ({ hints: !detailMode ? [
    { id: "filters", key: "f", label: "ilters", onPress: () => { void openFilters(); } },
    { id: "mine", key: "i", label: mine ? "all tickers" : "mine", onPress: () => setMine(!mine) },
  ] : [] }), [detailMode, mine, setMine, openFilters]);
  const filterBar = <CongressFilterBar filters={filters} onChange={setFilters} mine={mine} onMine={setMine} width={width}
    controls={{ chamber: chamberControl, side: sideControl, owner: ownerControl, assetType: assetControl, minAmount: amountControl }} />;
  const filterHeight = width < 100 ? 2 : 1;

  const detailContent = detailMode?.kind === "ticker" ? (
    <CongressTradesPane focused={focused} width={width} height={height - 3} paneId="congress-ticker" paneType="congress-trades" tickerFilter={detailMode.ticker} />
  ) : detailTrade ? (
    <TradeDetail trade={detailTrade} width={width} />
  ) : detailMember ? (
    <MemberTradesDetail
      focused={focused}
      member={detailMember}
      initialTrades={detailMemberTrades}
      width={width}
      filingLimit={payload?.filingCount ?? CONGRESS_MEMBER_FILING_LIMIT}
    />
  ) : null;
  const detailTitle = detailMode?.kind === "ticker" ? detailMode.ticker : detailTrade
    ? `${detailTrade.memberName} ${detailTrade.ticker ?? "trade"}`
    : detailMember
      ? detailMember.memberName
      : undefined;

  const tabs = tickerFilter ? null : (
    <Box height={1}>
      <Tabs
        tabs={[
          { label: "Trades", value: "trades" },
          { label: "Members", value: "members" },
          { label: "Tickers", value: "tickers" },
        ]}
        activeValue={activeTab}
        onSelect={selectTab}
        compact
        variant="underline"
        focused={focused && !detailMode}
      />
    </Box>
  );

  if (!payload && (status === "loading" || error)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody loading={status === "loading"} error={error} subject="Congress PTR filings" />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      {activeTab === "trades" ? (
        <DataTableStackView<CloudCongressTradePayload, TradeColumn>
          focused={focused}
          detailOpen={detailMode !== null}
          onBack={() => setDetailMode(null)}
          detailTitle={detailTitle}
          detailContent={detailContent}
          selection={{
            kind: "id",
            selectedId: selectedTradeId,
            getId: (trade) => trade.id,
            onChange: (id) => setSelectedTradeId(id),
          }}
          onActivate={(trade) => {
            setSelectedTradeId(trade.id, { immediate: true });
            setDetailMode({ kind: "trade", tradeId: trade.id });
          }}
          onRootKeyDown={handleFiltersKey}
          onDetailKeyDown={handleDetailKeyDown}
          rootWidth={width}
          rootBefore={filterBar}
          resetScrollKey={`${filterKey}:${mine}`}
          rootHeight={Math.max(1, height - (tickerFilter ? 0 : 1) - filterHeight)}
          columns={tradeColumns}
          items={tradeRows}
          sortColumnId={tradeSort.columnId}
          sortDirection={tradeSort.direction}
          onHeaderClick={(columnId) => setTradeSort((current) => nextSort(current, columnId as TradeColumnId, columnId === "member" || columnId === "ticker" ? "asc" : "desc"))}
          getItemKey={(trade) => trade.id}
          renderCell={(trade, column, index, row) => {
            const cell = renderCongressTradeCell(trade, column, index, row);
            return !row.selected && trade.ticker && mineTickers.has(trade.ticker) && column.id === "member" ? { ...cell, color: colors.borderFocused } : cell;
          }}
          emptyStateTitle="No matching trades in this filing window."
          scrollRef={tradeScrollRef}
          onBodyScrollActivity={onTradeScroll}
        />
      ) : activeTab === "tickers" ? (
        <DataTableStackView<CloudCongressTickerPayload, TickerColumn>
          focused={focused} detailOpen={detailMode !== null} onBack={() => setDetailMode(null)} detailTitle={detailTitle} detailContent={detailContent}
          selection={{ kind: "id", selectedId: selectedTicker, getId: (row) => row.ticker, onChange: setSelectedTicker }}
          onActivate={(row) => { setSelectedTicker(row.ticker); setDetailMode({ kind: "ticker", ticker: row.ticker }); }}
          rootWidth={width} rootHeight={Math.max(1, height - 1 - filterHeight)} rootBefore={filterBar}
          onRootKeyDown={handleFiltersKey} columns={tickerColumns} items={tickerRows} getItemKey={(row) => row.ticker}
          sortColumnId={tickerSort.columnId} sortDirection={tickerSort.direction}
          onHeaderClick={(columnId) => setTickerSort((current) => nextSort(current, columnId as TickerColumnId, columnId === "ticker" ? "asc" : "desc"))}
          renderCell={(row, column, index, selected) => {
            const cell = renderCongressTickerCell(row, column, index, selected);
            return !selected.selected && mineTickers.has(row.ticker) && column.id === "ticker" ? { ...cell, color: colors.borderFocused } : cell;
          }}
          emptyStateTitle="No matching tickers." scrollRef={tradeScrollRef} onBodyScrollActivity={onTradeScroll}
        />
      ) : (
        <DataTableStackView<CloudCongressMemberPayload, MemberColumn>
          focused={focused}
          detailOpen={detailMode !== null}
          onBack={() => setDetailMode(null)}
          detailTitle={detailTitle}
          detailContent={detailContent}
          selection={{
            kind: "id",
            selectedId: selectedMemberId,
            getId: (member) => member.id,
            onChange: (id) => setSelectedMemberId(id),
          }}
          onActivate={(member) => {
            setSelectedMemberId(member.id, { immediate: true });
            setDetailMode({ kind: "member", memberId: member.id });
          }}
          onRootKeyDown={handleFiltersKey}
          onDetailKeyDown={handleDetailKeyDown}
          rootWidth={width}
          rootBefore={filterBar}
          resetScrollKey={`${filterKey}:${mine}`}
          rootHeight={Math.max(1, height - 1 - filterHeight)}
          columns={memberColumns}
          items={memberRows}
          sortColumnId={memberSort.columnId}
          sortDirection={memberSort.direction}
          onHeaderClick={(columnId) => setMemberSort((current) => nextSort(current, columnId as MemberColumnId, columnId === "member" || columnId === "district" ? "asc" : "desc"))}
          getItemKey={(member) => member.id}
          renderCell={renderCongressMemberCell}
          emptyStateTitle="No matching members."
          scrollRef={tradeScrollRef}
          onBodyScrollActivity={onTradeScroll}
        />
      )}
    </Box>
  );
}
