import { MISSING_VALUE } from "../../../utils/format";
import { formatDay } from "../../../utils/day-format";
import { aggregateLoadedCongress } from "./aggregates";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Box, Text, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { ClippedText } from "../../../components/ui/display";
import {
  DataTableView,
  DetailScrollBody,
  FigureList,
  KeyValueRow,
  SectionHeading,
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
  CloudCongressMemberPayload,
  CloudCongressTradePayload,
} from "../../../api-client";
import {
  CONGRESS_MEMBER_FILING_LIMIT,
  CONGRESS_MEMBER_TRADE_LIMIT,
  CONGRESS_TRADES_PANE_ID,
  canLoadMoreCongress,
  congressScanNotice,
  nextCongressPage,
  previousCongressYearPage,
  buildMemberTradeColumns,
  foldFilingLines,
  formatAmountRange,
  formatCongressReturn,
  formatLag,
  plainAssetName,
  sortedTrades,
  tradeAssetLabel,
  tradeVehicle,
  type CongressTradeRow,
  type TradeColumn,
  type TradeColumnId,
} from "./model";
import { congressReturnColor, renderCongressTradeCell } from "./table";
import { useCongressFeed } from "./use-feed";
import { congressFreshnessFooter, latestCongressFiling } from "./footer";
import { congressReturnUnavailableText } from "./return-status";

const DETAIL_ROW = { labelWidth: 16, emphasis: false } as const;

/** A window's return, or its excess with SPY's own return beside it. */
function ReturnRow({ label, value, spy, unavailable }: { label: string; value: number | null | undefined; spy?: number | null; unavailable?: string }) {
  return (
    <KeyValueRow
      {...DETAIL_ROW}
      label={label}
      value={value == null && unavailable ? unavailable : formatCongressReturn(value)}
      color={congressReturnColor(value)}
      detail={spy == null ? undefined : `SPY ${formatCongressReturn(spy)}`}
    />
  );
}

/**
 * The lines a folded row stands for, each with its amount: what each was held
 * through (or its own description), and its owner where the lines differ.
 */
function FilingLines({ lines, width }: { lines: CloudCongressTradePayload[]; width: number }) {
  const owners = new Set(lines.map((line) => line.owner)).size > 1;
  return (
    <>
      <SectionHeading title={`${lines.length} lines in the filing`} marginTop={1} width={width} />
      <FigureList
        width={width}
        maxValueWidth={14}
        figures={lines.map((line) => ({
          id: line.id,
          value: formatAmountRange(line.amountLow, line.amountHigh, line.amount),
          label: tradeVehicle(line) ? `via ${tradeVehicle(line)}` : line.subholdingOf || line.description || tradeAssetLabel(line),
          ...(owners ? { note: line.owner } : {}),
        }))}
      />
    </>
  );
}

export function TradeDetail({
  trade,
  width,
  scrollRef,
}: {
  trade: CongressTradeRow;
  width: number;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
}) {
  const lineWidth = Math.max(1, width - 2);
  // The desktop's rows cut long values where they end, by CSS; the terminal at its columns.
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const fit = (value: string) => desktop ? value : truncateWithEllipsis(value, Math.max(10, lineWidth - 16));
  return (
    <DetailScrollBody ref={scrollRef}>
      <Box flexDirection="column" width={lineWidth}>
        {/* The detail title already carries the member and ticker. */}
        <KeyValueRow {...DETAIL_ROW} label="chamber" value={`${trade.chamber === "senate" ? "Senate" : "House"}${trade.stateDistrict ? ` · ${trade.stateDistrict}` : ""}`} tone="muted" />
        <KeyValueRow {...DETAIL_ROW} label="party" value={trade.party ?? MISSING_VALUE} />
        <KeyValueRow {...DETAIL_ROW} label="side" value={trade.transactionType} tone={trade.side === "BUY" ? "positive" : trade.side === "SELL" ? "negative" : trade.side === "OTHER" ? "muted" : undefined} />
        <KeyValueRow {...DETAIL_ROW} label="asset" value={fit(plainAssetName(trade.assetName))} />
        <KeyValueRow {...DETAIL_ROW} label="amount" value={trade.amount} color={colors.textBright} />
        <KeyValueRow {...DETAIL_ROW} label="owner" value={trade.owner} />
        <ReturnRow label="tx return" value={trade.returnSinceTx} unavailable={congressReturnUnavailableText(trade, "transaction")} />
        <ReturnRow label="tx vs SPY" value={trade.excessSinceTx} spy={trade.spyReturnSinceTx} unavailable={trade.returnSinceTx == null ? "No trade return" : "No matching SPY close"} />
        <ReturnRow label="filed return" value={trade.returnSinceFiling} unavailable={congressReturnUnavailableText(trade, "filing")} />
        <ReturnRow label="filed vs SPY" value={trade.excessSinceFiling} spy={trade.spyReturnSinceFiling} unavailable={trade.returnSinceFiling == null ? "No filed return" : "No matching SPY close"} />
        {trade.returnAsOf && <KeyValueRow {...DETAIL_ROW} label="price as of" value={formatDay(trade.returnAsOf)} />}
        <KeyValueRow {...DETAIL_ROW} label="tx date" value={formatDay(trade.transactionDate)} />
        <KeyValueRow {...DETAIL_ROW} label="notification" value={formatDay(trade.notificationDate)} />
        <KeyValueRow {...DETAIL_ROW} label="filed" value={formatDay(trade.filingDate)} />
        <KeyValueRow {...DETAIL_ROW} label="lag" value={`${formatLag(trade.lagDays)}${(trade.lagDays ?? 0) > 45 ? " (past 45 days)" : ""}`} tone={(trade.lagDays ?? 0) > 45 ? "warning" : undefined} />
        {trade.filingStatus ? <KeyValueRow {...DETAIL_ROW} label="status" value={trade.filingStatus} /> : null}
        {trade.subholdingOf ? <KeyValueRow {...DETAIL_ROW} label="subholding" value={fit(trade.subholdingOf)} /> : null}
        {trade.description ? (
          <>
            <Text>{" "}</Text>
            <Text fg={colors.textDim}>description</Text>
            <ClippedText fg={colors.text} text={trade.description} width={lineWidth} cut={truncateWithEllipsis} wrap />
          </>
        ) : null}
        {trade.lines ? <FilingLines lines={trade.lines} width={lineWidth} /> : null}
      </Box>
    </DetailScrollBody>
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
  // A member sits in one chamber, so their history comes from that feed alone.
  const chamber = initialTrades[0]?.chamber ?? "all";
  const { payload: detailPayload, status, error, loadPage, loadingMore, reload: refresh } = useCongressFeed({
    chamber,
    member: member.memberName,
    limit: CONGRESS_MEMBER_TRADE_LIMIT,
    filingLimit: Math.max(CONGRESS_MEMBER_FILING_LIMIT, filingLimit),
  }, member.id);
  const trades = useMemo(() => {
    if (!detailPayload) return initialTrades;
    const exact = detailPayload.trades.filter((trade) => trade.memberName === member.memberName && trade.stateDistrict === member.stateDistrict);
    return exact.length ? exact : detailPayload.trades;
  }, [detailPayload, initialTrades, member.memberName, member.stateDistrict]);
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(initialTrades[0]?.id ?? null);
  const [sortPreference, setSortPreference] = useState<{ columnId: TradeColumnId; direction: "asc" | "desc" }>({
    columnId: "filed",
    direction: "desc",
  });
  const tradeScrollRef = useRef<ScrollBoxRenderable | null>(null);

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
    setSelectedTradeId(initialTrades[0]?.id ?? null);
  }, [member.id]);

  // One filing's alike lines are one row, as on the trades; Export CSV writes each line.
  const sortedRows = useMemo(() => sortedTrades(foldFilingLines(trades), sortPreference), [sortPreference, trades]);
  const sortedLines = useMemo(() => sortedTrades(trades, sortPreference), [sortPreference, trades]);
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
      ...congressFreshnessFooter(detailPayload, latestCongressFiling(trades)),
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
    trades,
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
    { id: "median", label: "Median return", value: formatCongressReturn(summaryMember.medianReturn), color: congressReturnColor(summaryMember.medianReturn), detail: `${summaryMember.pricedTradeCount ?? 0} priced` },
    { id: "vs-spy", label: "Median vs SPY", value: formatCongressReturn(summaryMember.medianExcessSinceFiling), color: congressReturnColor(summaryMember.medianExcessSinceFiling), detail: `since filing, ${summaryMember.excessTradeCount ?? 0} priced`, detailVariants: ["since filing"] },
    { id: "hit", label: "Buy hit rate", value: summaryMember.buyHitRate == null ? MISSING_VALUE : `${summaryMember.buyHitRate.toFixed(0)}%`, detail: `${summaryMember.pricedBuyCount ?? 0} priced buys` },
    ...(summaryMember.committees ?? []).map((committee): StatItem => ({ id: `committee:${committee}`, label: "Committee", value: committee, wide: true })),
  ];
  const summary = <StatGrid items={summaryItems} width={width} />;
  const emptyTitle = status === "loading"
    ? "Loading member trades..."
    : error ?? "No trades for this member.";

  return (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      <DataTableView<CongressTradeRow, TradeColumn>
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
        exportItems={sortedLines}
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
