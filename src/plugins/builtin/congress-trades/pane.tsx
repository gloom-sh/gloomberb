import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, useRendererHost } from "../../../ui";
import {
  DataTableStackView,
  PaneStatusBody,
  Tabs,
} from "../../../components";
import { useDebouncedPluginPaneState, usePluginPaneState } from "../../runtime";
import { useAutoRefresh } from "../shared/auto-refresh";
import { useInlineTickerOpener } from "../../../state/hooks/inline-tickers";
import {
  apiClient,
  type CloudCongressHousePayload,
  type CloudCongressMemberPayload,
  type CloudCongressTradePayload,
} from "../../../api-client";
import type { PaneProps } from "../../../types/plugin";
import {
  CONGRESS_FILING_LIMIT,
  CONGRESS_MEMBER_FILING_LIMIT,
  CONGRESS_TRADE_LIMIT,
  buildMemberColumns,
  buildTradeColumns,
  nextSort,
  selectedIndexById,
  sortedMembers,
  sortedTrades,
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
} from "./table";

export { CONGRESS_TRADES_PANE_ID } from "./model";

export function CongressTradesPane({ focused, width, height }: PaneProps) {
  const rendererHost = useRendererHost();
  const [payload, setPayload] = useState<CloudCongressHousePayload | null>(null);
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [activeTab, setActiveTab] = usePluginPaneState<CongressTab>("activeTab", "trades");
  const [selectedTradeId, setSelectedTradeId] = useDebouncedPluginPaneState<string | null>("selectedTradeId", null);
  const [selectedMemberId, setSelectedMemberId] = useDebouncedPluginPaneState<string | null>("selectedMemberId", null);
  const [detailMode, setDetailMode] = useState<DetailMode>(null);
  const [tradeSort, setTradeSort] = useState<{ columnId: TradeColumnId; direction: SortDirection }>({
    columnId: "filed",
    direction: "desc",
  });
  const [memberSort, setMemberSort] = useState<{ columnId: MemberColumnId; direction: SortDirection }>({
    columnId: "trades",
    direction: "desc",
  });
  const fetchGenRef = useRef(0);

  const load = useCallback((refresh = false) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setStatus((current) => (current === "loaded" && !refresh ? "loaded" : "loading"));
    setError(null);
    apiClient.getCloudCongressHouse({
      limit: CONGRESS_TRADE_LIMIT,
      filingLimit: CONGRESS_FILING_LIMIT,
      refresh,
    })
      .then((nextPayload) => {
        if (fetchGenRef.current !== gen) return;
        setPayload(nextPayload);
        setStatus("loaded");
        setLastLoadedAt(Date.now());
      })
      .catch((loadError) => {
        if (fetchGenRef.current !== gen) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // Filings would otherwise age indefinitely in an open pane.
  const refresh = useCallback(() => {
    load(true);
  }, [load]);
  useAutoRefresh(lastLoadedAt, refresh);

  const trades = payload?.trades ?? [];
  const members = payload?.members ?? [];
  const tradeRows = useMemo(() => sortedTrades(trades, tradeSort), [trades, tradeSort]);
  const memberRows = useMemo(() => sortedMembers(members, memberSort), [members, memberSort]);
  const tradeColumns = useMemo(() => buildTradeColumns(width), [width]);
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
    if (detailMode?.kind === "trade" && !detailTrade) setDetailMode(null);
    if (detailMode?.kind === "member" && !detailMember) setDetailMode(null);
  }, [detailMember, detailMode, detailTrade]);

  const selectTab = useCallback((tab: string) => {
    setActiveTab(tab === "members" ? "members" : "trades");
    setDetailMode(null);
  }, [setActiveTab]);

  const openSelectedTradeSource = useCallback(() => {
    const trade = detailTrade ?? selectedTrade;
    if (!trade?.sourceUrl) return;
    void rendererHost.openExternal(trade.sourceUrl);
  }, [detailTrade, rendererHost, selectedTrade]);

  const openSelectedTicker = useCallback(() => {
    const ticker = detailTrade?.ticker ?? selectedTrade?.ticker;
    if (ticker) openTicker(ticker);
  }, [detailTrade?.ticker, openTicker, selectedTrade?.ticker]);

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
    openSelectedTicker,
    openSelectedTradeMember,
    openSelectedTradeSource,
    selectTab,
  });

  useCongressTradesFooter({
    activeTab,
    detailMode,
    detailTrade,
    error,
    openSelectedTicker,
    openSelectedTradeMember,
    openSelectedTradeSource,
    payload,
    selectedTrade,
    status,
  });

  const detailContent = detailTrade ? (
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
  const detailTitle = detailTrade
    ? `${detailTrade.memberName} ${detailTrade.ticker ?? "trade"}`
    : detailMember
      ? detailMember.memberName
      : undefined;

  const tabs = (
    <Box height={1}>
      <Tabs
        tabs={[
          { label: "Trades", value: "trades" },
          { label: "Members", value: "members" },
        ]}
        activeValue={activeTab}
        onSelect={selectTab}
        compact
        variant="pill"
        focused={focused && !detailMode}
      />
    </Box>
  );

  if (!payload && (status === "loading" || error)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody loading={status === "loading"} error={error} subject="House PTR filings" />
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
          onRootKeyDown={handleRootKeyDown}
          onDetailKeyDown={handleDetailKeyDown}
          rootWidth={width}
          rootHeight={Math.max(1, height - 1)}
          columns={tradeColumns}
          items={tradeRows}
          sortColumnId={tradeSort.columnId}
          sortDirection={tradeSort.direction}
          onHeaderClick={(columnId) => setTradeSort((current) => nextSort(current, columnId as TradeColumnId, columnId === "member" || columnId === "ticker" ? "asc" : "desc"))}
          getItemKey={(trade) => trade.id}
          renderCell={renderCongressTradeCell}
          emptyStateTitle="No House PTR trades."
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
          onRootKeyDown={handleRootKeyDown}
          onDetailKeyDown={handleDetailKeyDown}
          rootWidth={width}
          rootHeight={Math.max(1, height - 1)}
          columns={memberColumns}
          items={memberRows}
          sortColumnId={memberSort.columnId}
          sortDirection={memberSort.direction}
          onHeaderClick={(columnId) => setMemberSort((current) => nextSort(current, columnId as MemberColumnId, columnId === "member" || columnId === "district" ? "asc" : "desc"))}
          getItemKey={(member) => member.id}
          renderCell={renderCongressMemberCell}
          emptyStateTitle="No House PTR members."
        />
      )}
    </Box>
  );
}
