import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ScrollBox, Text, TextAttributes, useRendererHost, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableView,
  usePaneFooter,
  useTableLoadMore,
  type DataTableKeyEvent,
} from "../../../components";
import { useInlineTickerOpener } from "../../../state/hooks/inline-tickers";
import { colors } from "../../../theme/colors";
import { padTo } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import type {
  CloudCongressHousePayload,
  CloudCongressMemberPayload,
  CloudCongressTradePayload,
} from "../../../api-client";
import { apiClient } from "../../../api-client";
import {
  CONGRESS_MEMBER_FILING_LIMIT,
  CONGRESS_MEMBER_TRADE_LIMIT,
  CONGRESS_TRADES_PANE_ID,
  canLoadMoreCongress,
  mergeCongressPages,
  nextCongressPage,
  buildMemberTradeColumns,
  formatAmountRange,
  formatLag,
  nextSort,
  sortedTrades,
  truncate,
  type LoadStatus,
  type TradeColumn,
  type TradeColumnId,
} from "./model";
import { renderCongressTradeCell } from "./table";

function DetailLine({
  label,
  value,
  tone,
  bold = false,
}: {
  label: string;
  value: string;
  tone?: "muted" | "value" | "positive" | "negative" | "warning";
  bold?: boolean;
}) {
  const color = tone === "positive"
    ? colors.positive
    : tone === "negative"
      ? colors.negative
      : tone === "warning"
        ? colors.warning
        : tone === "value"
          ? colors.textBright
          : tone === "muted"
            ? colors.textDim
            : colors.text;
  return (
    <Box height={1} flexDirection="row">
      <Text fg={colors.textDim}>{padTo(label, 16)}</Text>
      <Text fg={color} attributes={bold ? TextAttributes.BOLD : 0}>{value}</Text>
    </Box>
  );
}

export function TradeDetail({
  trade,
  width,
}: {
  trade: CloudCongressTradePayload;
  width: number;
}) {
  const lineWidth = Math.max(1, width - 2);
  return (
    <ScrollBox scrollY focusable={false} flexGrow={1} paddingX={1}>
      <Box flexDirection="column" width={lineWidth}>
        {/* The detail title already carries the member and ticker. */}
        <DetailLine label="district" value={trade.stateDistrict || "--"} tone="muted" />
        <DetailLine label="side" value={trade.transactionType} tone={trade.side === "BUY" ? "positive" : trade.side === "SELL" ? "negative" : "warning"} />
        <DetailLine label="asset" value={truncate(trade.assetName, Math.max(10, lineWidth - 16))} />
        <DetailLine label="amount" value={trade.amount} tone="value" />
        <DetailLine label="owner" value={trade.owner} />
        <DetailLine label="tx date" value={trade.transactionDate ?? "--"} />
        <DetailLine label="notification" value={trade.notificationDate ?? "--"} />
        <DetailLine label="filed" value={trade.filingDate} />
        <DetailLine label="lag" value={formatLag(trade.lagDays)} />
        {trade.filingStatus ? <DetailLine label="status" value={trade.filingStatus} /> : null}
        {trade.subholdingOf ? <DetailLine label="subholding" value={truncate(trade.subholdingOf, Math.max(10, lineWidth - 16))} /> : null}
        {trade.description ? (
          <>
            <Text>{" "}</Text>
            <Text fg={colors.textDim}>description</Text>
            <Text fg={colors.text}>{truncate(trade.description, lineWidth)}</Text>
          </>
        ) : null}
      </Box>
    </ScrollBox>
  );
}

export function MemberTradesDetail({
  member,
  initialTrades,
  width,
  focused,
  filingLimit,
}: {
  member: CloudCongressMemberPayload;
  initialTrades: CloudCongressTradePayload[];
  width: number;
  focused: boolean;
  filingLimit: number;
}) {
  const rendererHost = useRendererHost();
  const openTicker = useInlineTickerOpener();
  const [trades, setTrades] = useState<CloudCongressTradePayload[]>(initialTrades);
  const [detailPayload, setDetailPayload] = useState<CloudCongressHousePayload | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(initialTrades[0]?.id ?? null);
  const [sortPreference, setSortPreference] = useState<{ columnId: TradeColumnId; direction: "asc" | "desc" }>({
    columnId: "filed",
    direction: "desc",
  });
  const fetchGenRef = useRef(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const tradeScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const load = useCallback((refresh = false) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setStatus("loading");
    setError(null);
    apiClient.getCloudCongressHouse({
      member: member.memberName,
      limit: CONGRESS_MEMBER_TRADE_LIMIT,
      filingLimit: Math.max(CONGRESS_MEMBER_FILING_LIMIT, filingLimit),
      refresh,
    })
      .then((payload) => {
        if (fetchGenRef.current !== gen) return;
        const exactMemberTrades = payload.trades.filter((trade) => (
          trade.memberName === member.memberName
          && trade.stateDistrict === member.stateDistrict
        ));
        setDetailPayload(payload);
        setTrades(exactMemberTrades.length > 0 ? exactMemberTrades : payload.trades);
        setStatus("loaded");
      })
      .catch((loadError) => {
        if (fetchGenRef.current !== gen) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
        setStatus("error");
      });
  }, [filingLimit, member.memberName, member.stateDistrict]);

  const loadMore = useCallback(() => {
    if (!detailPayload || loadingMore || status !== "loaded") return;
    const nextRequest = nextCongressPage(detailPayload);
    if (!nextRequest) return;
    const gen = fetchGenRef.current;
    setLoadingMore(true);
    apiClient.getCloudCongressHouse({
      ...nextRequest,
      member: member.memberName,
      limit: CONGRESS_MEMBER_TRADE_LIMIT,
      filingLimit: Math.max(CONGRESS_MEMBER_FILING_LIMIT, filingLimit),
    })
      .then((payload) => {
        if (fetchGenRef.current !== gen) return;
        const merged = detailPayload ? mergeCongressPages(detailPayload, payload) : payload;
        const exactMemberTrades = merged.trades.filter((trade) => (
          trade.memberName === member.memberName
          && trade.stateDistrict === member.stateDistrict
        ));
        setDetailPayload(merged);
        setTrades(exactMemberTrades.length > 0 ? exactMemberTrades : merged.trades);
      })
      .finally(() => {
        if (fetchGenRef.current !== gen) return;
        setLoadingMore(false);
      });
  }, [detailPayload, filingLimit, loadingMore, member.memberName, member.stateDistrict, status]);

  const onTradeScroll = useTableLoadMore(
    tradeScrollRef,
    !!detailPayload && status === "loaded" && !loadingMore && canLoadMoreCongress(detailPayload),
    loadMore,
  );

  useEffect(() => {
    fetchGenRef.current += 1;
    setTrades(initialTrades);
    setDetailPayload(null);
    setStatus("loading");
    setError(null);
    setSelectedTradeId(initialTrades[0]?.id ?? null);
  }, [member.id]);

  useEffect(() => {
    load(false);
  }, [load]);

  const sortedRows = useMemo(() => sortedTrades(trades, sortPreference), [sortPreference, trades]);
  const columns = useMemo(() => buildMemberTradeColumns(width), [width]);
  const selectedTrade = useMemo(() => (
    sortedRows.find((trade) => trade.id === selectedTradeId) ?? sortedRows[0] ?? null
  ), [selectedTradeId, sortedRows]);
  const summaryMember = useMemo(() => (
    detailPayload?.members.find((entry) => entry.id === member.id)
    ?? detailPayload?.members.find((entry) => (
      entry.memberName === member.memberName
      && entry.stateDistrict === member.stateDistrict
    ))
    ?? member
  ), [detailPayload?.members, member]);
  const maybeTruncated = status === "loaded" && trades.length >= CONGRESS_MEMBER_TRADE_LIMIT;

  useEffect(() => {
    if (selectedTradeId && sortedRows.some((trade) => trade.id === selectedTradeId)) return;
    setSelectedTradeId(sortedRows[0]?.id ?? null);
  }, [selectedTradeId, sortedRows]);

  const refresh = useCallback(() => {
    load(true);
  }, [load]);

  const openSelectedTicker = useCallback(() => {
    if (selectedTrade?.ticker) openTicker(selectedTrade.ticker);
  }, [openTicker, selectedTrade?.ticker]);

  const openSelectedSource = useCallback(() => {
    if (selectedTrade?.sourceUrl) void rendererHost.openExternal(selectedTrade.sourceUrl);
  }, [rendererHost, selectedTrade?.sourceUrl]);

  const handleKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return true;
    }
    if (isPlainKey(event, "t") && selectedTrade?.ticker) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedTicker();
      return true;
    }
    if (isPlainKey(event, "o") && selectedTrade?.sourceUrl) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedSource();
      return true;
    }
    return false;
  }, [openSelectedSource, openSelectedTicker, refresh, selectedTrade?.sourceUrl, selectedTrade?.ticker]);

  usePaneFooter(`${CONGRESS_TRADES_PANE_ID}:member-detail`, () => ({
    info: [
      ...(status === "loading" ? [{ id: "member-loading", parts: [{ text: "loading member trades", tone: "muted" as const }] }] : []),
      ...(error ? [{ id: "member-error", parts: [{ text: error, tone: "warning" as const }] }] : []),
      ...(maybeTruncated ? [{ id: "member-truncated", parts: [{ text: `limited to ${CONGRESS_MEMBER_TRADE_LIMIT} trades`, tone: "warning" as const }] }] : []),
    ],
    hints: [
      { id: "member-ticker", key: "t", label: "icker", onPress: openSelectedTicker, disabled: !selectedTrade?.ticker },
      { id: "member-open", key: "o", label: "pen", onPress: openSelectedSource, disabled: !selectedTrade?.sourceUrl },
    ],
  }), [
    error,
    maybeTruncated,
    openSelectedSource,
    openSelectedTicker,
    selectedTrade?.sourceUrl,
    selectedTrade?.ticker,
    status,
  ]);

  const summary = (
    <Box flexDirection="column" paddingX={1} paddingTop={1} paddingBottom={1}>
      <Box height={1} flexDirection="row">
        <Text fg={colors.textDim}>
          {`${summaryMember.stateDistrict || "--"}  ${summaryMember.tradeCount} trades  ${summaryMember.buyCount} buys  ${summaryMember.sellCount} sells  ${formatAmountRange(summaryMember.estimatedLow, summaryMember.estimatedHigh)}`}
        </Text>
      </Box>
    </Box>
  );
  const emptyTitle = status === "loading"
    ? "Loading member trades..."
    : error ?? "No trades for this member.";

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <DataTableView<CloudCongressTradePayload, TradeColumn>
        focused={focused}
        selection={{
          kind: "id",
          selectedId: selectedTradeId,
          getId: (trade) => trade.id,
          onChange: (id) => setSelectedTradeId(id),
        }}
        onActivate={(trade) => {
          if (trade.ticker) openTicker(trade.ticker);
        }}
        onRootKeyDown={handleKeyDown}
        rootWidth={width}
        rootBefore={summary}
        resetScrollKey={member.id}
        columns={columns}
        items={sortedRows}
        sortColumnId={sortPreference.columnId}
        sortDirection={sortPreference.direction}
        onHeaderClick={(columnId) => {
          setSortPreference((current) => nextSort(
            current,
            columnId as TradeColumnId,
            columnId === "ticker" || columnId === "asset" || columnId === "side" || columnId === "owner" ? "asc" : "desc",
          ));
        }}
        getItemKey={(trade) => trade.id}
        renderCell={renderCongressTradeCell}
        emptyStateTitle={emptyTitle}
        showHorizontalScrollbar={false}
        scrollRef={tradeScrollRef}
        onBodyScrollActivity={onTradeScroll}
      />
    </Box>
  );
}
