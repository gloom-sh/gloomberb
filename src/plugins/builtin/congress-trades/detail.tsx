import { aggregateLoadedCongress } from "./aggregates";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ScrollBox, Text, useRendererHost, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableView,
  KeyValueRow,
  StatGrid,
  usePaneFooter,
  usePaneNoticeFooter,
  useTableLoadMore,
  type DataTableKeyEvent,
  type StatItem,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useInlineTickerOpener } from "../../../state/hooks/inline-tickers";
import { colors } from "../../../theme/colors";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
import { nextHeaderSort } from "../../../utils/sort-values";
import type {
  CloudCongressHousePayload,
  CloudCongressMemberPayload,
  CloudCongressTradePayload,
} from "../../../api-client";
import {
  CONGRESS_MEMBER_FILING_LIMIT,
  CONGRESS_MEMBER_TRADE_LIMIT,
  CONGRESS_TRADES_PANE_ID,
  canLoadMoreCongress,
  congressScanNotice,
  mergeCongressPages,
  nextCongressPage,
  previousCongressYearPage,
  buildMemberTradeColumns,
  formatCongressReturn,
  formatLag,
  sortedTrades,
  type LoadStatus,
  type TradeColumn,
  type TradeColumnId,
} from "./model";
import { renderCongressTradeCell } from "./table";
import { loadCongressHouse } from "./client";

const DETAIL_ROW = { labelWidth: 16, emphasis: false } as const;

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
        <KeyValueRow {...DETAIL_ROW} label="chamber" value={`${trade.chamber === "senate" ? "Senate" : "House"}${trade.stateDistrict ? ` · ${trade.stateDistrict}` : ""}`} tone="muted" />
        <KeyValueRow {...DETAIL_ROW} label="party" value={trade.party ?? "--"} />
        <KeyValueRow {...DETAIL_ROW} label="side" value={trade.transactionType} tone={trade.side === "BUY" ? "positive" : trade.side === "SELL" ? "negative" : trade.side === "OTHER" ? "muted" : undefined} />
        <KeyValueRow {...DETAIL_ROW} label="asset" value={truncateWithEllipsis(trade.assetName, Math.max(10, lineWidth - 16))} />
        <KeyValueRow {...DETAIL_ROW} label="amount" value={trade.amount} color={colors.textBright} />
        <KeyValueRow {...DETAIL_ROW} label="owner" value={trade.owner} />
        <KeyValueRow {...DETAIL_ROW} label="tx return" value={formatCongressReturn(trade.returnSinceTx)} />
        <KeyValueRow {...DETAIL_ROW} label="filed return" value={formatCongressReturn(trade.returnSinceFiling)} />
        <KeyValueRow {...DETAIL_ROW} label="price as of" value={trade.returnAsOf ?? "--"} />
        <KeyValueRow {...DETAIL_ROW} label="tx date" value={trade.transactionDate ?? "--"} />
        <KeyValueRow {...DETAIL_ROW} label="notification" value={trade.notificationDate ?? "--"} />
        <KeyValueRow {...DETAIL_ROW} label="filed" value={trade.filingDate} />
        <KeyValueRow {...DETAIL_ROW} label="lag" value={`${formatLag(trade.lagDays)}${(trade.lagDays ?? 0) > 45 ? " (past 45 days)" : ""}`} tone={(trade.lagDays ?? 0) > 45 ? "warning" : undefined} />
        {trade.filingStatus ? <KeyValueRow {...DETAIL_ROW} label="status" value={trade.filingStatus} /> : null}
        {trade.subholdingOf ? <KeyValueRow {...DETAIL_ROW} label="subholding" value={truncateWithEllipsis(trade.subholdingOf, Math.max(10, lineWidth - 16))} /> : null}
        {trade.description ? (
          <>
            <Text>{" "}</Text>
            <Text fg={colors.textDim}>description</Text>
            <Text fg={colors.text}>{truncateWithEllipsis(trade.description, lineWidth)}</Text>
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
  // A member sits in one chamber, so their history comes from that feed alone.
  const chamber = initialTrades[0]?.chamber ?? "all";
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
    loadCongressHouse({
      chamber,
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
  }, [chamber, filingLimit, member.memberName, member.stateDistrict]);

  const loadPage = useCallback((nextRequest: ReturnType<typeof nextCongressPage>) => {
    if (!detailPayload || !nextRequest) return;
    const gen = fetchGenRef.current;
    setLoadingMore(true);
    loadCongressHouse({
      ...nextRequest,
      chamber,
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
      .catch((loadError) => {
        if (fetchGenRef.current !== gen) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (fetchGenRef.current !== gen) return;
        setLoadingMore(false);
      });
  }, [chamber, detailPayload, filingLimit, member.memberName, member.stateDistrict]);

  const loadMore = useCallback(() => {
    if (!detailPayload || loadingMore || status !== "loaded") return;
    loadPage(nextCongressPage(detailPayload));
  }, [detailPayload, loadPage, loadingMore, status]);

  // Reading an earlier year means reading its documents, so it stays a deliberate step.
  const previousYearRequest = detailPayload && !canLoadMoreCongress(detailPayload)
    ? previousCongressYearPage(detailPayload)
    : null;
  const loadPreviousYear = useCallback(() => {
    if (loadingMore || status !== "loaded" || !previousYearRequest) return;
    loadPage(previousYearRequest);
  }, [loadPage, loadingMore, previousYearRequest, status]);

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
    return () => { fetchGenRef.current += 1; };
  }, [load]);

  const sortedRows = useMemo(() => sortedTrades(trades, sortPreference), [sortPreference, trades]);
  const columns = useMemo(() => buildMemberTradeColumns(width), [width]);
  const selectedTrade = useMemo(() => (
    sortedRows.find((trade) => trade.id === selectedTradeId) ?? sortedRows[0] ?? null
  ), [selectedTradeId, sortedRows]);
  const summaryMember = useMemo(() => (
    aggregateLoadedCongress(trades, detailPayload?.members ?? [member]).members
      .find((entry) => entry.id === member.id) ?? member
  ), [detailPayload?.members, member, trades]);
  const maybeTruncated = status === "loaded" && trades.length >= CONGRESS_MEMBER_TRADE_LIMIT;
  const scanNotice = detailPayload ? congressScanNotice(detailPayload) : null;

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

  // n, t, o and p are the footer hints below, which bind their own keys.
  const handleKeyDown = useCallback((event: DataTableKeyEvent) => (
    handleRefreshKey(event, refresh, { stopPropagation: true })
  ), [refresh]);

  usePaneNoticeFooter({
    registrationId: `${CONGRESS_TRADES_PANE_ID}:member-notices`,
    notices: [
      scanNotice,
      maybeTruncated ? `Only the most recent ${CONGRESS_MEMBER_TRADE_LIMIT} trades for this member are shown.` : null,
    ].filter((notice): notice is string => !!notice),
    focused,
  });

  usePaneFooter(`${CONGRESS_TRADES_PANE_ID}:member-detail`, () => ({
    info: [
      ...(status === "loading" ? [{ id: "member-loading", parts: [{ text: "loading member trades", tone: "muted" as const }] }] : []),
      ...(loadingMore ? [{ id: "member-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
      ...(error ? [{ id: "member-error", parts: [{ text: error, tone: "warning" as const }] }] : []),
    ],
    hints: [
      ...(detailPayload && canLoadMoreCongress(detailPayload)
        ? [{ id: "member-next", key: "n", label: "ext filings", onPress: loadMore, disabled: loadingMore }]
        : []),
      { id: "member-ticker", key: "t", label: "icker", onPress: openSelectedTicker, disabled: !selectedTrade?.ticker },
      { id: "member-open", key: "o", label: "pen", onPress: openSelectedSource, disabled: !selectedTrade?.sourceUrl },
      ...(previousYearRequest
        ? [{ id: "member-prev-year", key: "p", label: `rev year ${previousYearRequest.year}`, onPress: loadPreviousYear }]
        : []),
    ],
  }), [
    error,
    detailPayload,
    loadMore,
    loadingMore,
    loadPreviousYear,
    maybeTruncated,
    openSelectedSource,
    openSelectedTicker,
    previousYearRequest,
    scanNotice,
    selectedTrade?.sourceUrl,
    selectedTrade?.ticker,
    status,
  ]);

  // The member row already shows party, district, counts and the range. The
  // detail adds what the row lacks: how many priced trades stand behind the
  // return figures, and the committees.
  const summaryItems: StatItem[] = [
    { id: "median", label: "Median return", value: formatCongressReturn(summaryMember.medianReturn), detail: `${summaryMember.pricedTradeCount ?? 0} priced` },
    { id: "hit", label: "Buy hit rate", value: summaryMember.buyHitRate == null ? "--" : `${summaryMember.buyHitRate.toFixed(0)}%`, detail: `${summaryMember.pricedBuyCount ?? 0} priced buys` },
    ...(summaryMember.committees ?? []).map((committee): StatItem => ({ id: `committee:${committee}`, label: "Committee", value: committee, wide: true })),
  ];
  const summary = <StatGrid items={summaryItems} width={width} />;
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
          setSortPreference((current) => nextHeaderSort(current, columnId as TradeColumnId, {
            firstDirection: columnId === "ticker" || columnId === "asset" || columnId === "side" || columnId === "owner" ? "asc" : "desc",
          }));
        }}
        getItemKey={(trade) => trade.id}
        renderCell={renderCongressTradeCell}
        selectedTextOverridesCellColor
        emptyStateTitle={emptyTitle}
        showHorizontalScrollbar={false}
        scrollRef={tradeScrollRef}
        onBodyScrollActivity={onTradeScroll}
      />
    </Box>
  );
}
