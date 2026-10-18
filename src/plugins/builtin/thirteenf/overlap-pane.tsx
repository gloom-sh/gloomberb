import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableStackView, DataTableView, KeyValueRow, QueryBar, usePagedRows, usePaneNoticeFooter, useQueryBarSearch, useTableLoadMore, type DataTableColumn, type PageRequest } from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import { Box, type ScrollBoxRenderable } from "../../../ui";
import { isDetailBackNavigationKey } from "../../../utils/back-navigation";
import { isPlainKey } from "../../../utils/keyboard";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useMineTickers } from "../shared/mine-tickers";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { cachedFunds, cachedMembers, loadFunds, loadMembers } from "../members/client";
import { coveredFund } from "../members/model";
import { normalizeCik, searchThirteenFFunds } from "./api";
import { loadFundDetail } from "./data";
import { formatWeightMaybe } from "./format";
import { isCikQuery } from "./model";
import { buildFundOverlap, buildManagerEtfOverlap, overlapPeriod, type FundOverlapRow, type ManagerEtfOverlap, type ManagerEtfRow } from "./overlap";
import type { FundDetailData, ThirteenFFund } from "./types";

/** An ETF whose holdings file MEMB serves, as the second holdings of an overlap: the symbol it was asked as, and its file. */
interface OverlapEtf {
  symbol: string;
  ticker: string;
  name: string;
}

/** A choice in the second-holdings list: a 13F manager, or an ETF MEMB covers. */
type OverlapChoice = ThirteenFFund & { etf?: OverlapEtf };

/** A word that reads as a ticker (SPY, BRK.B), which may name an ETF MEMB covers. */
const TICKER_WORD = /^\$?[A-Za-z]{1,5}(?:[.-][A-Za-z])?$/;

/** An ETF's weight in a manager's name: "not held", or "no ticker" for a 13F line with none to match. */
const etfWeightText = (row: ManagerEtfRow) => row.etfWeight == null ? "no ticker" : row.etfWeight === 0 ? "not held" : formatWeightMaybe(row.etfWeight);

/** The quarter compared, and the fund's newer latest quarter when it has one. */
function periodDetail(data: FundDetailData | null, period: string | null): string | undefined {
  const latest = data?.latestForm?.periodOfReport;
  return period && latest && latest !== period ? `${period} · latest ${latest}` : latest;
}

export function FundOverlapView({ data, focused, width }: { data: FundDetailData; focused: boolean; width: number }) {
  const [query, setQuery] = usePluginPaneState<string>("overlap:query", "");
  const [target, setTarget] = usePluginPaneState<ThirteenFFund | null>("overlap:target", null);
  const [etf, setEtf] = usePluginPaneState<OverlapEtf | null>("overlap:etf", null);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("overlap:selected", null);
  const [selectedPositionId, setSelectedPositionId] = usePluginPaneState<string | null>("overlap:position", null);
  const [peer, setPeer] = useState<FundDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { active: searchFocused, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();
  const [fundSort, setFundSort] = useState<{ columnId: "name" | "cik"; direction: SortDirection }>({ columnId: "name", direction: "asc" });
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [mineOnly, setMineOnly] = usePluginPaneState<boolean>("overlap:mine", false);
  const [sort, setSort] = usePluginPaneState<{ id: "weight" | "comparedWeight"; desc: boolean }>("overlap:sort", { id: "weight", desc: true });
  const mine = useMineTickers();
  const { pinTicker } = usePluginTickerActions();
  const [refresh, setRefresh] = useState(0);
  const lastRefresh = useRef(0);
  const searchPage = useCallback(async ({ offset, signal }: PageRequest) => {
    const result = await searchThirteenFFunds(query, 50, signal, { offset });
    const rows = result.filter(fund => fund.cik !== data.cik);
    return { rows, hasMore: result.length === 50, nextOffset: offset + result.length };
  }, [query, data.cik]);
  const open = !!target || !!etf;
  const paged = usePagedRows(open || !query || isCikQuery(query) ? null : searchPage, { getId: (fund) => fund.cik });
  const cikFunds = useMemo(() => isCikQuery(query) && !open ? [{ cik: normalizeCik(query), name: query }] : [], [query, open]);
  // A ticker MEMB has the holdings file of is offered first, as `fn 13F --compare SPY` reads it.
  const etfSymbol = !open && TICKER_WORD.test(query) ? query.replace(/^\$/, "").toUpperCase() : null;
  const loadEtfList = useCallback((force: boolean) => loadFunds(force), []);
  const etfList = useAsyncResource(etfSymbol ? loadEtfList : null, { initialData: cachedFunds });
  const coveredEtf = etfSymbol && etfList.data ? coveredFund(etfList.data.payload.funds, etfSymbol) : undefined;
  const etfChoice = useMemo<OverlapChoice[]>(() => coveredEtf && etfSymbol
    ? [{ cik: `etf:${coveredEtf.ticker}`, name: `${etfSymbol} · ${coveredEtf.name} holdings`, etf: { symbol: etfSymbol, ticker: coveredEtf.ticker, name: coveredEtf.name } }]
    : [], [coveredEtf, etfSymbol]);
  const funds: OverlapChoice[] = open ? [] : cikFunds.length ? cikFunds : paged.rows;
  const etfTicker = etf?.ticker ?? null;
  const loadEtfFile = useCallback((force: boolean) => loadMembers(etfTicker!, force), [etfTicker]);
  const etfFile = useAsyncResource(etfTicker ? loadEtfFile : null, { initialData: useCallback(() => etfTicker ? cachedMembers(etfTicker) : null, [etfTicker]) });
  const etfPayload = etf ? etfFile.data?.payload ?? null : null;
  const etfOverlap = useMemo(() => etfPayload ? buildManagerEtfOverlap(data, etfPayload.members) : null, [data, etfPayload]);
  useEffect(() => {
    const controller = new AbortController();
    setError(null); setPeer(null);
    if (!target) { setLoading(false); return; }
    setLoading(true);
    const forceRefresh = refresh !== lastRefresh.current;
    lastRefresh.current = refresh;
    void loadFundDetail(target.cik, target.name, controller.signal, { forceRefresh, filingGap: false })
      .then(result => { if (!controller.signal.aborted) setPeer(result); })
      .catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [target, refresh]);
  const loadingMore = paged.loadingMore;
  const onScroll = useTableLoadMore(scrollRef, paged.hasMore && !loadingMore && !loading && !open, paged.loadMore);
  const refreshData = useCallback(() => {
    setRefresh(value => value + 1);
    paged.reload();
    if (etf) void etfFile.reload();
  }, [paged.reload, etf, etfFile.reload]);
  const closeDetail = useCallback(() => { setTarget(null); setEtf(null); }, [setTarget, setEtf]);
  useShortcut(event => {
    if (!focused || !open || event.targetEditable || !isDetailBackNavigationKey(event)) return;
    event.preventDefault?.(); event.stopPropagation?.(); closeDetail();
  }, { phase: "before" });
  useShortcut(event => {
    if (!focused || event.targetEditable) return;
    handleRefreshKey(event, refreshData, { stopPropagation: true });
    if (isPlainKey(event, "m") && open) { event.preventDefault?.(); setMineOnly(value => !value); }
  });
  const period = peer ? overlapPeriod(data, peer) : null;
  const mismatch = peer && !period;
  const listError = etf ? etfFile.error : error ?? paged.error?.message ?? paged.moreError?.message ?? null;
  usePaneStatusFooter({ registrationId: "13f-overlap", loading: loading || loadingMore || paged.loading || (!!etf && etfFile.loading), error: listError, hints: open ? [{ id: "mine", key: "m", label: mineOnly ? "all tickers" : "mine", title: mineOnly ? "All Tickers" : "Mine Only", onPress: () => setMineOnly(value => !value) }] : [{ id: "search", key: "/", label: "search", onPress: focusSearch }] });
  usePaneNoticeFooter({ registrationId: "13f-overlap-notice", focused, notices: [
    ...(peer?.warnings ?? []),
    ...(mismatch ? ["No reporting quarter is loaded for both funds; overlap is unavailable."] : []),
    ...(etf && etfPayload?.stale ? [`The ${etf.ticker} holdings file is stale.`] : []),
    ...(etf && etfPayload && !etfOverlap ? ["No share positions or ETF weights to compare."] : []),
  ] });
  const rows = useMemo(() => (peer ? buildFundOverlap(data, peer) : []).filter(row => !mineOnly || mine.has(row.ticker)).sort((a, b) => ((a[sort.id] ?? -1) - (b[sort.id] ?? -1)) * (sort.desc ? -1 : 1)), [peer, data, mineOnly, mine, sort]);
  const positionColumns: DataTableColumn[] = [{ id: "mine", label: "MINE", width: 5, align: "left" }, { id: "ticker", label: "TICKER", width: 10, align: "left" }, { id: "type", label: "TYPE", width: 6, align: "left" }, { id: "issuer", label: "ISSUER", width: Math.max(18, width - 58), align: "left" }, { id: "weight", label: "FIRST %", width: 12, align: "right" }, { id: "comparedWeight", label: "SECOND %", width: 12, align: "right" }];
  const fundDetail = <Box flexDirection="column" flexGrow={1}>
    <KeyValueRow label="First" value={data.name} detail={periodDetail(data, period)} />
    <KeyValueRow label="Second" value={peer?.name ?? target?.name ?? ""} detail={periodDetail(peer, period)} />
    <QueryBar width={width} filters={[{ id: "mine", kind: "toggle", label: "Mine", value: mineOnly, onChange: setMineOnly }]} />
    <DataTableView<FundOverlapRow, DataTableColumn> focused={focused} columns={positionColumns} items={rows} getItemKey={row => row.id}
      selection={{ kind: "id", selectedId: selectedPositionId, getId: row => row.id, onChange: setSelectedPositionId }}
      onActivate={row => { if (row.ticker) pinTicker(row.ticker, { floating: true }); }}
      sortColumnId={sort.id} sortDirection={sort.desc ? "desc" : "asc"}
      onHeaderClick={id => { if (id === "weight" || id === "comparedWeight") setSort(current => ({ id, desc: current.id === id ? !current.desc : true })); }}
      renderCell={(row, column, _index, state) => ({ text: column.id === "mine" ? mine.has(row.ticker) ? "yes" : "" : column.id === "weight" ? formatWeightMaybe(row.weight) : column.id === "comparedWeight" ? formatWeightMaybe(row.comparedWeight) : String(row[column.id as keyof FundOverlapRow]), color: state.selected ? colors.selectedText : colors.text })}
      emptyStateTitle={loading ? "Loading fund positions..." : mismatch ? "Matching reporting quarters unavailable." : "No shared positions."}
    />
  </Box>;
  const choices: OverlapChoice[] = [...etfChoice, ...[...funds].sort((a, b) => a[fundSort.columnId].localeCompare(b[fundSort.columnId]) * (fundSort.direction === "desc" ? -1 : 1))];
  return <DataTableStackView<OverlapChoice, DataTableColumn>
    focused={focused && !searchFocused} detailOpen={open} onBack={closeDetail} detailTitle={etf ? `${etf.symbol} · ${etf.name}` : target?.name}
    detailContent={etf
      ? <EtfOverlapDetail data={data} etf={etf} file={etfPayload} overlap={etfOverlap} loading={etfFile.loading} focused={focused} width={width} mineOnly={mineOnly} onMineOnly={setMineOnly} />
      : fundDetail}
    scrollRef={scrollRef} onBodyScrollActivity={onScroll} resetScrollKey={query}
    sortColumnId={fundSort.columnId} sortDirection={fundSort.direction} onHeaderClick={id => setFundSort(current => nextHeaderSort(current, id === "cik" ? "cik" : "name"))}
    rootWidth={width} columns={[{ id: "name", label: "FUND", width: Math.max(20, width - 17), align: "left" }, { id: "cik", label: "CIK", width: 12, align: "left" }]}
    items={choices} getItemKey={row => row.cik} selection={{ kind: "id", selectedId, getId: row => row.cik, onChange: setSelectedId }}
    onActivate={choice => { blurSearch(); if (choice.etf) { setTarget(null); setEtf(choice.etf); } else { setEtf(null); setTarget({ cik: choice.cik, name: choice.name }); } }}
    rootBefore={<QueryBar width={width} search={{ value: query, onChange: setQuery, placeholder: "Second fund name, CIK or ETF ticker", focused, ...searchProps, debounceMs: 250 }} />}
    renderCell={(row, column, _index, state) => ({ text: column.id === "name" ? row.name : row.etf ? "ETF" : row.cik, color: state.selected ? colors.selectedText : row.etf && column.id === "cik" ? colors.textDim : colors.text })}
    emptyStateTitle={loading || paged.loading ? "Searching funds..." : query ? "No matching funds." : "Search for a second fund or ETF."}
  />;
}

/** A manager's latest 13F against an ETF's holdings file, as `fn 13F <fund> --compare SPY` reports it. */
function EtfOverlapDetail({ data, etf, file, overlap, loading, focused, width, mineOnly, onMineOnly }: {
  data: FundDetailData;
  etf: OverlapEtf;
  file: { asOf: string } | null;
  overlap: ManagerEtfOverlap | null;
  loading: boolean;
  focused: boolean;
  width: number;
  mineOnly: boolean;
  onMineOnly: (value: boolean) => void;
}) {
  const mine = useMineTickers();
  const { pinTicker } = usePluginTickerActions();
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("overlap:etf-position", null);
  const [sort, setSort] = usePluginPaneState<{ id: "weight" | "etfWeight" | "shared"; desc: boolean }>("overlap:etf-sort", { id: "weight", desc: true });
  const rows = useMemo(() => (overlap?.rows ?? [])
    .filter(row => !mineOnly || mine.has(row.ticker))
    .sort((a, b) => ((a[sort.id] ?? -1) - (b[sort.id] ?? -1)) * (sort.desc ? -1 : 1)), [overlap, mineOnly, mine, sort]);
  const columns: DataTableColumn[] = [
    { id: "mine", label: "MINE", width: 5, align: "left" },
    { id: "ticker", label: "TICKER", width: 10, align: "left" },
    { id: "issuer", label: "ISSUER", width: Math.max(18, width - 55), align: "left" },
    { id: "weight", label: "13F %", width: 10, align: "right" },
    { id: "etfWeight", label: `${etf.symbol} %`, width: 10, align: "right" },
    { id: "shared", label: "SHARED %", width: 10, align: "right" },
  ];
  const period = data.latestForm?.periodOfReport;
  return <Box flexDirection="column" flexGrow={1}>
    <KeyValueRow label="13F" value={data.name} detail={period} />
    <KeyValueRow label={`${etf.symbol} holdings`} value={file ? file.asOf.slice(0, 10) : "--"} detail={etf.ticker !== etf.symbol ? `${etf.ticker} file` : undefined} />
    {overlap ? <KeyValueRow label="Overlap" value={formatWeightMaybe(overlap.overlap)} detail={`active share ${formatWeightMaybe(overlap.activeShare)}`} /> : null}
    <QueryBar width={width} filters={[{ id: "mine", kind: "toggle", label: "Mine", value: mineOnly, onChange: onMineOnly }]} />
    <DataTableView<ManagerEtfRow, DataTableColumn> focused={focused} columns={columns} items={rows} getItemKey={row => row.id}
      selection={{ kind: "id", selectedId, getId: row => row.id, onChange: setSelectedId }}
      onActivate={row => { if (row.ticker) pinTicker(row.ticker, { floating: true }); }}
      sortColumnId={sort.id} sortDirection={sort.desc ? "desc" : "asc"}
      onHeaderClick={id => { if (id === "weight" || id === "etfWeight" || id === "shared") setSort(current => ({ id, desc: current.id === id ? !current.desc : true })); }}
      renderCell={(row, column, _index, state) => {
        const unmatched = column.id === "etfWeight" && !row.etfWeight;
        const text = column.id === "mine" ? mine.has(row.ticker) ? "yes" : ""
          : column.id === "weight" ? formatWeightMaybe(row.weight)
            : column.id === "etfWeight" ? etfWeightText(row)
              : column.id === "shared" ? formatWeightMaybe(row.shared)
                : String(row[column.id as "ticker" | "issuer"] || "");
        return { text, color: state.selected ? colors.selectedText : unmatched ? colors.textDim : colors.text };
      }}
      emptyStateTitle={loading ? `Loading ${etf.symbol} holdings...` : "No share positions to compare."}
    />
  </Box>;
}
