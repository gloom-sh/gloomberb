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
import { normalizeCik, searchThirteenFFunds } from "./api";
import { loadFundDetail } from "./data";
import { formatWeightMaybe } from "./format";
import { isCikQuery } from "./model";
import { buildFundOverlap, overlapPeriod, type FundOverlapRow } from "./overlap";
import type { FundDetailData, ThirteenFFund } from "./types";

/** The quarter compared, and the fund's newer latest quarter when it has one. */
function periodDetail(data: FundDetailData | null, period: string | null): string | undefined {
  const latest = data?.latestForm?.periodOfReport;
  return period && latest && latest !== period ? `${period} · latest ${latest}` : latest;
}

export function FundOverlapView({ data, focused, width }: { data: FundDetailData; focused: boolean; width: number }) {
  const [query, setQuery] = usePluginPaneState<string>("overlap:query", "");
  const [target, setTarget] = usePluginPaneState<ThirteenFFund | null>("overlap:target", null);
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
  const paged = usePagedRows(target || !query || isCikQuery(query) ? null : searchPage, { getId: (fund) => fund.cik });
  const cikFunds = useMemo(() => isCikQuery(query) && !target ? [{ cik: normalizeCik(query), name: query }] : [], [query, target]);
  const funds = target ? [] : cikFunds.length ? cikFunds : paged.rows;
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
  const onScroll = useTableLoadMore(scrollRef, paged.hasMore && !loadingMore && !loading && !target, paged.loadMore);
  const refreshData = useCallback(() => { setRefresh(value => value + 1); paged.reload(); }, [paged.reload]);
  useShortcut(event => {
    if (!focused || !target || event.targetEditable || !isDetailBackNavigationKey(event)) return;
    event.preventDefault?.(); event.stopPropagation?.(); setTarget(null);
  }, { phase: "before" });
  useShortcut(event => {
    if (!focused || event.targetEditable) return;
    handleRefreshKey(event, refreshData, { stopPropagation: true });
    if (isPlainKey(event, "m") && target) { event.preventDefault?.(); setMineOnly(value => !value); }
  });
  const period = peer ? overlapPeriod(data, peer) : null;
  const mismatch = peer && !period;
  const listError = error ?? paged.error?.message ?? paged.moreError?.message ?? null;
  usePaneStatusFooter({ registrationId: "13f-overlap", loading: loading || loadingMore || paged.loading, error: listError, hints: target ? [{ id: "mine", key: "m", label: mineOnly ? "all tickers" : "mine", title: mineOnly ? "All Tickers" : "Mine Only", onPress: () => setMineOnly(value => !value) }] : [{ id: "search", key: "/", label: "search", onPress: focusSearch }] });
  usePaneNoticeFooter({ registrationId: "13f-overlap-notice", focused, notices: [...(peer?.warnings ?? []), ...(mismatch ? ["No reporting quarter is loaded for both funds; overlap is unavailable."] : [])] });
  const rows = useMemo(() => (peer ? buildFundOverlap(data, peer) : []).filter(row => !mineOnly || mine.has(row.ticker)).sort((a, b) => ((a[sort.id] ?? -1) - (b[sort.id] ?? -1)) * (sort.desc ? -1 : 1)), [peer, data, mineOnly, mine, sort]);
  const positionColumns: DataTableColumn[] = [{ id: "mine", label: "MINE", width: 5, align: "left" }, { id: "ticker", label: "TICKER", width: 10, align: "left" }, { id: "type", label: "TYPE", width: 6, align: "left" }, { id: "issuer", label: "ISSUER", width: Math.max(18, width - 58), align: "left" }, { id: "weight", label: "FIRST %", width: 12, align: "right" }, { id: "comparedWeight", label: "SECOND %", width: 12, align: "right" }];
  return <DataTableStackView<ThirteenFFund, DataTableColumn>
    focused={focused && !searchFocused} detailOpen={!!target} onBack={() => setTarget(null)} detailTitle={target?.name}
    detailContent={<Box flexDirection="column" flexGrow={1}>
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
    </Box>}
    scrollRef={scrollRef} onBodyScrollActivity={onScroll} resetScrollKey={query}
    sortColumnId={fundSort.columnId} sortDirection={fundSort.direction} onHeaderClick={id => setFundSort(current => nextHeaderSort(current, id === "cik" ? "cik" : "name"))}
    rootWidth={width} columns={[{ id: "name", label: "FUND", width: Math.max(20, width - 17), align: "left" }, { id: "cik", label: "CIK", width: 12, align: "left" }]}
    items={[...funds].sort((a, b) => a[fundSort.columnId].localeCompare(b[fundSort.columnId]) * (fundSort.direction === "desc" ? -1 : 1))} getItemKey={row => row.cik} selection={{ kind: "id", selectedId, getId: row => row.cik, onChange: setSelectedId }}
    onActivate={fund => { blurSearch(); setTarget(fund); }}
    rootBefore={<QueryBar width={width} search={{ value: query, onChange: setQuery, placeholder: "Second fund name or CIK", focused, ...searchProps, debounceMs: 250 }} />}
    renderCell={(row, column, _index, state) => ({ text: column.id === "name" ? row.name : row.cik, color: state.selected ? colors.selectedText : colors.text })}
    emptyStateTitle={loading || paged.loading ? "Searching funds..." : query ? "No matching funds." : "Search for a second fund."}
  />;
}
