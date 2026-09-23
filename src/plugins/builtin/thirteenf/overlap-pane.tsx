import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableStackView, DataTableView, KeyValueRow, QueryBar, usePaneNoticeFooter, useTableLoadMore, type DataTableColumn } from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import { Box, type InputRenderable, type ScrollBoxRenderable } from "../../../ui";
import { isDetailBackNavigationKey } from "../../../utils/back-navigation";
import { isPlainKey } from "../../../utils/keyboard";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useMineTickers } from "../shared/mine-tickers";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { normalizeCik, searchThirteenFFunds } from "./api";
import { loadFundDetail } from "./data";
import { formatWeightMaybe } from "./format";
import { isCikQuery } from "./model";
import { buildFundOverlap, type FundOverlapRow } from "./overlap";
import type { FundDetailData, ThirteenFFund } from "./types";

export function FundOverlapView({ data, focused, width }: { data: FundDetailData; focused: boolean; width: number }) {
  const [query, setQuery] = usePluginPaneState<string>("overlap:query", "");
  const [target, setTarget] = usePluginPaneState<ThirteenFFund | null>("overlap:target", null);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("overlap:selected", null);
  const [selectedPositionId, setSelectedPositionId] = usePluginPaneState<string | null>("overlap:position", null);
  const [funds, setFunds] = useState<ThirteenFFund[]>([]);
  const [peer, setPeer] = useState<FundDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const searchRef = useRef<InputRenderable | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [fundSort, setFundSort] = useState<{ id: "name" | "cik"; desc: boolean }>({ id: "name", desc: false });
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const moreController = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const focusSearch = useCallback(() => { setSearchFocused(true); setFocusToken(value => value + 1); }, []);
  const [mineOnly, setMineOnly] = usePluginPaneState<boolean>("overlap:mine", false);
  const [sort, setSort] = usePluginPaneState<{ id: "weight" | "comparedWeight"; desc: boolean }>("overlap:sort", { id: "weight", desc: true });
  const mine = useMineTickers();
  const { pinTicker } = usePluginTickerActions();
  const [refresh, setRefresh] = useState(0);
  const lastRefresh = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null); setPeer(null); setFunds([]); setHasMore(false); setOffset(0); setLoadingMore(false); moreController.current?.abort();
    if (!target && !query) { setLoading(false); return; }
    setLoading(true);
    const forceRefresh = refresh !== lastRefresh.current;
    lastRefresh.current = refresh;
    const work = target ? loadFundDetail(target.cik, target.name, controller.signal, { forceRefresh }).then(result => { if (!controller.signal.aborted) setPeer(result); })
      : isCikQuery(query) ? Promise.resolve().then(() => setFunds([{ cik: normalizeCik(query), name: query }]))
      : searchThirteenFFunds(query, 50, controller.signal).then(result => { if (!controller.signal.aborted) { setFunds(result.filter(fund => fund.cik !== data.cik)); setHasMore(result.length === 50); setOffset(result.length); } });
    void work.catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); moreController.current?.abort(); };
  }, [query, target, refresh, data.cik]);
  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore || loading || target) return;
    moreController.current?.abort(); const request = new AbortController(); moreController.current = request; setLoadingMore(true);
    void searchThirteenFFunds(query, 50, request.signal, { offset }).then(result => {
      if (request.signal.aborted) return;
      setFunds(current => [...new Map([...current, ...result.filter(fund => fund.cik !== data.cik)].map(fund => [fund.cik, fund])).values()]);
      setHasMore(result.length === 50); setOffset(offset + result.length);
    }).catch(cause => { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!request.signal.aborted) setLoadingMore(false); });
  }, [hasMore, loadingMore, loading, target, query, offset, data.cik]);
  const onScroll = useTableLoadMore(scrollRef, hasMore && !loadingMore && !loading && !target, loadMore);
  const refreshData = useCallback(() => setRefresh(value => value + 1), []);
  useShortcut(event => {
    if (!focused || !target || event.targetEditable || !isDetailBackNavigationKey(event)) return;
    event.preventDefault?.(); event.stopPropagation?.(); setTarget(null);
  }, { phase: "before" });
  useShortcut(event => {
    if (!focused || event.targetEditable) return;
    if (isPlainKey(event, "r")) { event.preventDefault?.(); event.stopPropagation?.(); refreshData(); }
    if (isPlainKey(event, "/") && !target) { event.preventDefault?.(); focusSearch(); }
    if (isPlainKey(event, "m") && target) { event.preventDefault?.(); setMineOnly(value => !value); }
  });
  const mismatch = peer && data.latestForm?.periodOfReport !== peer.latestForm?.periodOfReport;
  usePaneStatusFooter({ registrationId: "13f-overlap", loading: loading || loadingMore, error, hints: target ? [{ id: "mine", key: "m", label: mineOnly ? "all tickers" : "mine", title: mineOnly ? "All Tickers" : "Mine Only", onPress: () => setMineOnly(value => !value) }] : [{ id: "search", key: "/", label: "search", onPress: focusSearch }] });
  usePaneNoticeFooter({ registrationId: "13f-overlap-notice", focused, notices: [...(peer?.warnings ?? []), ...(mismatch ? ["The funds have different latest reporting quarters; overlap is unavailable."] : [])] });
  const rows = useMemo(() => (peer ? buildFundOverlap(data, peer) : []).filter(row => !mineOnly || mine.has(row.ticker)).sort((a, b) => ((a[sort.id] ?? -1) - (b[sort.id] ?? -1)) * (sort.desc ? -1 : 1)), [peer, data, mineOnly, mine, sort]);
  const positionColumns: DataTableColumn[] = [{ id: "mine", label: "MINE", width: 5, align: "left" }, { id: "ticker", label: "TICKER", width: 10, align: "left" }, { id: "type", label: "TYPE", width: 6, align: "left" }, { id: "issuer", label: "ISSUER", width: Math.max(18, width - 58), align: "left" }, { id: "weight", label: "FIRST %", width: 12, align: "right" }, { id: "comparedWeight", label: "SECOND %", width: 12, align: "right" }];
  return <DataTableStackView<ThirteenFFund, DataTableColumn>
    focused={focused && !searchFocused} detailOpen={!!target} onBack={() => setTarget(null)} detailTitle={target?.name}
    detailContent={<Box flexDirection="column" flexGrow={1}>
      <KeyValueRow label="First" value={data.name} detail={data.latestForm?.periodOfReport} />
      <KeyValueRow label="Second" value={peer?.name ?? target?.name ?? ""} detail={peer?.latestForm?.periodOfReport} />
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
    sortColumnId={fundSort.id} sortDirection={fundSort.desc ? "desc" : "asc"} onHeaderClick={id => setFundSort(current => ({ id: id === "cik" ? "cik" : "name", desc: current.id === id ? !current.desc : false }))}
    rootWidth={width} columns={[{ id: "name", label: "FUND", width: Math.max(20, width - 17), align: "left" }, { id: "cik", label: "CIK", width: 12, align: "left" }]}
    items={[...funds].sort((a, b) => a[fundSort.id].localeCompare(b[fundSort.id]) * (fundSort.desc ? -1 : 1))} getItemKey={row => row.cik} selection={{ kind: "id", selectedId, getId: row => row.cik, onChange: setSelectedId }}
    onActivate={fund => { setSearchFocused(false); setTarget(fund); }}
    rootBefore={<QueryBar width={width} search={{ value: query, onChange: setQuery, placeholder: "Second fund name or CIK", focused, active: searchFocused,
      onActiveChange: (active) => active ? focusSearch() : setSearchFocused(false), focusToken, inputRef: searchRef, debounceMs: 250,
      onNavigateDown: () => setSearchFocused(false) }} />}
    renderCell={(row, column, _index, state) => ({ text: column.id === "name" ? row.name : row.cik, color: state.selected ? colors.selectedText : colors.text })}
    emptyStateTitle={loading ? "Searching funds..." : query ? "No matching funds." : "Search for a second fund."}
  />;
}
