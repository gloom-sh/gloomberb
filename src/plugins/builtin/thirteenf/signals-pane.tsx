import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DataTableStackView, DataTableView, EmptyState, KeyValueRow, QueryBar, usePaneNoticeFooter, usePaneTicker, useTableLoadMore, type DataTableColumn, type DataTableKeyEvent, type DataTableRootKeyContext, type PaneHint } from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, type ScrollBoxRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { useMineTickers } from "../shared/mine-tickers";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { actionLabel, formatMoneyCompact, formatShares, formatWeightMaybe } from "./format";
import { FundDetailView } from "./pane";
import { appendTickerHoldings, loadCrowding, loadTickerHoldings, type Crowding, type CrowdingRow, type TickerHoldings, type TickerHolderRow } from "./signals";

export function ThirteenFTickerPane({ focused, width, height }: Pick<PaneProps, "focused" | "width" | "height">) {
  const { ticker } = usePaneTicker();
  const symbol = ticker?.metadata.ticker ?? "";
  if (!symbol) return <EmptyState title="Select a ticker." />;
  return <ThirteenFTickerHoldingsView symbol={symbol} focused={focused} width={width} height={height} />;
}

/**
 * A ticker's 13F holders with their position in that ticker: value, shares,
 * weight in the fund's book and the quarter's action. The 13F pane shows it
 * for a ticker query, as `fn 13F <ticker>` does.
 */
export function ThirteenFTickerHoldingsView({ symbol, focused, width, height, queryBar, hints, onRootKeyDown, onUnavailable, onDetailChange }: Pick<PaneProps, "focused" | "width" | "height"> & {
  symbol: string;
  queryBar?: ReactNode;
  hints?: PaneHint[];
  onRootKeyDown?: (event: DataTableKeyEvent, context: DataTableRootKeyContext) => boolean;
  /** The first page failed, e.g. a ticker without a mapped CUSIP. */
  onUnavailable?: () => void;
  onDetailChange?: (open: boolean) => void;
}) {
  const [data, setData] = useState<TickerHoldings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("13f-ticker:selected", null);
  const [fund, setFund] = usePluginPaneState<{ cik: string; name: string } | null>("13f-ticker:fund", null);
  const unavailableRef = useRef(onUnavailable); unavailableRef.current = onUnavailable;
  useEffect(() => { onDetailChange?.(!!fund); }, [fund, onDetailChange]);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback((more = false) => {
    if (!symbol || (more && (loading || !data?.hasMore))) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true); setError(null);
    void loadTickerHoldings(symbol, more ? data!.nextOffset : 0, request.signal).then(page => {
      if (controller.current !== request) return;
      setData(current => more && current ? appendTickerHoldings(current, page) : page);
    }).catch(cause => {
      if (controller.current !== request || request.signal.aborted) return;
      if (!more && !data && unavailableRef.current) unavailableRef.current();
      else setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (controller.current === request) setLoading(false); });
  }, [symbol, loading, data]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    setData(null); setFund(null); setSelectedId(null);
    if (symbol) loadRef.current(); else setLoading(false);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [symbol]);
  const more = useTableLoadMore(scrollRef, !!data?.hasMore && !loading && !fund, () => load(true));
  useShortcut(event => { if (focused && !fund && isPlainKey(event, "r")) { event.preventDefault?.(); load(); } });
  usePaneStatusFooter({ registrationId: "13f-ticker", enabled: !fund, loading, error, hints });
  usePaneNoticeFooter({ registrationId: "13f-ticker-notice", enabled: !fund, focused, notices: data?.warnings ?? [] });
  const columns: DataTableColumn[] = [
    { id: "fund", label: "FUND", width: Math.max(20, width - 57), align: "left" },
    { id: "type", label: "TYPE", width: 6, align: "left" },
    { id: "value", label: "VALUE", width: 12, align: "right" },
    { id: "shares", label: "SHARES", width: 12, align: "right" },
    { id: "weight", label: "13F %", width: 9, align: "right" },
    { id: "action", label: "ACTION", width: 8, align: "left" },
  ];
  const [sort, setSort] = usePluginPaneState<{ id: string; desc: boolean }>("13f-ticker:sort", { id: "value", desc: true });
  const rows = useMemo(() => [...(data?.rows ?? [])].sort((a, b) => compareCells(a, b, sort.id, sort.desc)), [data?.rows, sort]);
  const summary = data ? <Box flexDirection="column" paddingX={1}>
    <KeyValueRow label={data.period} value={`${data.holderCount} holders · ${formatMoneyCompact(data.totalValue)} loaded · ${data.newCount - data.exitCount >= 0 ? "+" : ""}${data.newCount - data.exitCount} net funds`} />
  </Box> : null;
  return <DataTableStackView<TickerHolderRow, DataTableColumn>
    focused={focused} detailOpen={!!fund} onBack={() => setFund(null)} detailTitle={fund?.name}
    detailContent={fund ? <FundDetailView focused={focused} seed={fund} width={width} /> : <Box />}
    rootWidth={width} rootHeight={height} scrollRef={scrollRef} onBodyScrollActivity={more}
    onRootKeyDown={onRootKeyDown}
    rootBefore={queryBar || summary ? <>{queryBar}{summary}</> : undefined}
    columns={columns} items={rows} getItemKey={row => row.id}
    selection={{ kind: "id", selectedId, getId: row => row.id, onChange: setSelectedId }}
    onActivate={row => setFund({ cik: row.cik, name: row.fund })}
    sortColumnId={sort.id} sortDirection={sort.desc ? "desc" : "asc"}
    onHeaderClick={id => setSort(current => ({ id, desc: current.id === id ? !current.desc : id !== "fund" }))}
    renderCell={(row, column, _index, state) => ({ text: column.id === "value" ? formatMoneyCompact(row.value) : column.id === "shares" ? formatShares(row.shares) : column.id === "weight" ? formatWeightMaybe(row.weight) : column.id === "action" ? actionLabel(row.action) : String(row[column.id as keyof TickerHolderRow] ?? "--"), color: state.selected ? colors.selectedText : colors.text })}
    emptyStateTitle={loading ? "Loading 13F holders..." : error ? "13F holders unavailable." : "No reported holders."}
  />;
}
function compareCells(a: object, b: object, id: string, desc: boolean) {
  const left = (a as Record<string, unknown>)[id], right = (b as Record<string, unknown>)[id];
  if (left == null) return right == null ? 0 : 1;
  if (right == null) return -1;
  const compared = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
  return desc ? -compared : compared;
}

export function ThirteenFCrowdingPane({ focused, width, height }: Pick<PaneProps, "focused" | "width" | "height">) {
  const [data, setData] = useState<Crowding | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("13f-crowding:selected", null);
  const mine = useMineTickers();
  const [mineOnly, setMineOnly] = usePluginPaneState<boolean>("13f-crowding:mine", false);
  const [ranking, setRanking] = usePluginPaneState<string>("13f-crowding:ranking", "newCount");
  const controller = useRef<AbortController | null>(null);
  const { pinTicker } = usePluginTickerActions();
  const load = useCallback(() => {
    controller.current?.abort(); const request = new AbortController(); controller.current = request;
    setLoading(true); setError(null);
    void loadCrowding(request.signal).then(result => { if (!request.signal.aborted) setData(result); }).catch(cause => { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }).finally(() => { if (!request.signal.aborted) setLoading(false); });
  }, []);
  useEffect(() => { load(); return () => { controller.current?.abort(); }; }, [load]);
  useShortcut(event => { if (!focused) return; if (isPlainKey(event, "r")) { event.preventDefault?.(); load(); } if (isPlainKey(event, "m")) { event.preventDefault?.(); setMineOnly(value => !value); } if (isPlainKey(event, "c")) { event.preventDefault?.(); setRanking(value => { const ranks = ["newCount", "exitCount", "weightChange", "decreases"]; return ranks[(ranks.indexOf(value) + 1) % ranks.length]!; }); } });
  usePaneStatusFooter({ registrationId: "13f-crowding", loading, error, hints: [{ id: "mine", key: "m", label: mineOnly ? "all tickers" : "mine", onPress: () => setMineOnly(value => !value) }, { id: "ranking", key: "c", label: "rank", onPress: () => setRanking(value => { const ranks = ["newCount", "exitCount", "weightChange", "decreases"]; return ranks[(ranks.indexOf(value) + 1) % ranks.length]!; }) }] });
  usePaneNoticeFooter({ registrationId: "13f-crowding-notice", focused, notices: data?.warnings ?? [] });
  const rows = useMemo(() => [...(data?.rows ?? [])].filter(row => !mineOnly || mine.has(row.ticker)).sort((a, b) => compareCells(a, b, ranking === "decreases" ? "weightChange" : ranking, ranking !== "decreases")), [data?.rows, ranking, mineOnly, mine]);
  const columns: DataTableColumn[] = [
    { id: "mine", label: "MINE", width: 5, align: "left" }, { id: "ticker", label: "TICKER", width: 10, align: "left" }, { id: "issuer", label: "ISSUER", width: Math.max(18, width - 82), align: "left" }, { id: "type", label: "TYPE", width: 5, align: "left" },
    { id: "holderCount", label: "FUNDS", width: 6, align: "right" }, { id: "newCount", label: "NEW", width: 5, align: "right" }, { id: "exitCount", label: "EXIT", width: 5, align: "right" },
    { id: "weightChange", label: "DELTA PP", width: 11, align: "right" }, { id: "comparedFunds", label: "COMP", width: 5, align: "right" }, { id: "totalValue", label: "VALUE", width: 12, align: "right" },
  ];
  return <Box flexDirection="column" width={width} height={height}>
    <QueryBar width={width} filters={[{ id: "mine", kind: "toggle", label: "Mine", value: mineOnly, onChange: setMineOnly }]}
      view={{ value: ranking, options: [{ label: "New", value: "newCount" }, { label: "Exits", value: "exitCount" }, { label: "Increases", value: "weightChange" }, { label: "Decreases", value: "decreases" }], onChange: setRanking }} />
    {data ? <KeyValueRow label={data.period} value={`${data.loadedFunds}/${data.sourceFunds} ranked funds`} /> : null}
    <DataTableView<CrowdingRow, DataTableColumn> focused={focused} columns={columns} items={rows} getItemKey={row => row.id}
      selection={{ kind: "id", selectedId, getId: row => row.id, onChange: setSelectedId }}
      onActivate={row => { if (row.ticker && row.ticker !== row.cusip) pinTicker(row.ticker, { floating: true }); }}
      onHeaderClick={setRanking} sortColumnId={ranking === "decreases" ? "weightChange" : ranking} sortDirection={ranking === "decreases" ? "asc" : "desc"}
      renderCell={(row, column, _index, state) => ({ text: column.id === "mine" ? mine.has(row.ticker) ? "yes" : "" : column.id === "totalValue" ? formatMoneyCompact(row.totalValue) : column.id === "weightChange" ? row.weightChange == null ? "--" : `${row.weightChange > 0 ? "+" : ""}${(row.weightChange * 100).toFixed(2)}` : String(row[column.id as keyof CrowdingRow] ?? "--"), color: state.selected ? colors.selectedText : colors.text })}
      emptyStateTitle={loading ? "Loading 13F crowding..." : error ? "13F crowding unavailable." : "No comparable positions."}
    />
  </Box>;
}
