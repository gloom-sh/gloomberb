import { useCallback, useMemo, useRef, useState } from "react";
import { CompositeChart, DataTableStackView, DataTableView, PaneStatusBody, QueryBar, Tabs, usePaneFooter, usePaneHeaderTabs, usePaneNoticeFooter, usePaneStatusFooter, type DataTableColumn, type SelectControl } from "../../../components";
import { useAsyncResource, usePluginPaneState, useShortcut } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import type { CotBoardRow, CotClass, CotClassSummary, CotFamily } from "../../../api-client/cot";
import { ApiRequestError } from "../../../api-client/errors";
import { Box, type InputRenderable } from "../../../ui";
import { useAutoRefresh } from "../shared/auto-refresh";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { loadCotBoard, loadCotDetail } from "./client";
import { COT_CLASSES, COT_MAJOR_CODES, COT_SCOPES, cotChartSeries, cotClass, cotInteger, cotLegendValue, cotMarketName, cotScope, type CotScope } from "./model";

const FAMILIES = [{ value: "legacy", label: "Legacy" }, { value: "disaggregated", label: "Disaggregated" }];
const BOARD_COLUMNS: DataTableColumn[] = [
  { id: "name", label: "MARKET", width: 30, align: "left", flexGrow: 1 },
  { id: "code", label: "CODE", width: 7, align: "left" },
  { id: "net", label: "NET", width: 12, align: "right" },
  { id: "change", label: "1W Δ", width: 11, align: "right" },
  { id: "one", label: "PCTL 1Y", width: 8, align: "right" },
  { id: "three", label: "PCTL 3Y", width: 8, align: "right" },
  { id: "asOf", label: "AS OF", width: 10, align: "left" },
];
const POSITION_COLUMNS: DataTableColumn[] = [
  { id: "name", label: "CLASS", width: 20, align: "left" },
  { id: "long", label: "LONG", width: 11, align: "right" },
  { id: "short", label: "SHORT", width: 11, align: "right" },
  { id: "net", label: "NET", width: 11, align: "right" },
  { id: "change", label: "1W Δ", width: 10, align: "right" },
  { id: "one", label: "PCTL 1Y", width: 8, align: "right" },
  { id: "three", label: "PCTL 3Y", width: 8, align: "right" },
];
const clearDenied = (error: unknown) => error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
const rank = (value: number | null) => value == null ? "--" : value.toFixed(0);
const cotDetailTitle = (name: string | undefined, code: string | null) => name ? cotMarketName(name) : code ?? undefined;

export function CotPane(props: PaneProps) {
  const pane = usePaneInstance();
  const [family, setFamily] = usePluginPaneState<CotFamily>("report", pane?.settings?.report === "disaggregated" ? "disaggregated" : "legacy");
  const tabsInHeader = usePaneHeaderTabs({ tabs: FAMILIES, activeValue: family, onSelect: (value) => setFamily(value as CotFamily), focused: props.focused });
  return <Box width={props.width} height={props.height} flexDirection="column">
    {!tabsInHeader && <Tabs tabs={FAMILIES} activeValue={family} onSelect={(value) => setFamily(value as CotFamily)} focused={props.focused} dense />}
    <CotBoard key={family} {...props} height={Math.max(3, props.height - (tabsInHeader ? 0 : 1))} family={family} initialCode={pane?.params?.code ?? null} />
  </Box>;
}
function CotBoard({ width, height, focused, family, initialCode }: PaneProps & { family: CotFamily; initialCode: string | null }) {
  const colors = useThemeColors();
  const session = useResearchCloudSession();
  const [storedClass, setClass] = usePluginPaneState<CotClass>("class", COT_CLASSES[family][0]!.value);
  const traderClass = cotClass(family, storedClass);
  const [selected, setSelected] = usePluginPaneState<string | null>("selected", initialCode);
  const [open, setOpen] = usePluginPaneState<string | null>("open", initialCode);
  const [storedScope, setScope] = usePluginPaneState<CotScope>("scope", "major");
  const scope = cotScope(storedScope);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [sort, setSort] = useState({ id: "", direction: "desc" as "asc" | "desc" });
  const control = useRef<SelectControl>(null);
  const scopeControl = useRef<SelectControl>(null);
  const searchInput = useRef<InputRenderable | null>(null);
  const loader = useCallback((force: boolean) => loadCotBoard(family, traderClass, force), [family, traderClass, session.requestKey]);
  const resource = useAsyncResource(loader, { clearOnError: clearDenied });
  const data = resource.data?.traderClass === traderClass ? resource.data : null;
  const rows = useMemo(() => {
    // A typed query searches every market; the scope only shapes the unsearched board.
    const result = (data?.rows ?? []).filter((row) => query ? `${row.marketName} ${row.contractCode}`.toLowerCase().includes(query.toLowerCase())
      : scope === "all" || COT_MAJOR_CODES.has(row.contractCode));
    if (!sort.id) return result;
    const value = (row: CotBoardRow) => ({ name: cotMarketName(row.marketName), code: row.contractCode, net: row.position.net, change: row.position.weeklyChange,
      one: row.position.percentile1Y.value, three: row.position.percentile3Y.value, asOf: row.reportDate })[sort.id as "name"];
    return [...result].sort((a, b) => {
      const left = value(a), right = value(b);
      if (left == null) return right == null ? 0 : 1;
      if (right == null) return -1;
      const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
      return sort.direction === "asc" ? order : -order;
    });
  }, [data, query, scope, sort]);
  useAutoRefresh(resource.updatedAt, resource.load);
  // The class, scope and search controls live in the board's query bar, so
  // their keys only work once the board is on screen.
  const boardShown = !!data && !open;
  useShortcut((event) => {
    if (!focused || open || event.targetEditable || event.ctrl || event.meta || event.alt || event.super) return;
    if (event.name === "r") { event.preventDefault(); void resource.reload(); }
    if (!boardShown) return;
    if (event.name === "c") { event.preventDefault(); control.current?.open(); }
    if (event.name === "s") { event.preventDefault(); scopeControl.current?.open(); }
    if (event.name === "/") { event.preventDefault(); setSearching(true); setSearchFocus((value) => value + 1); }
  });
  usePaneFooter("cot:actions", () => ({ hints: boardShown ? [
    { id: "class", key: "c", label: "class", onPress: () => control.current?.open() },
    { id: "scope", key: "s", label: "cope", onPress: () => scopeControl.current?.open() },
    { id: "search", key: "/", label: "search", onPress: () => { setSearching(true); setSearchFocus((value) => value + 1); } },
  ] : [] }), [boardShown]);
  usePaneNoticeFooter({ registrationId: "cot:board-notices", focused, enabled: !open, notices: data?.gaps ?? [] });
  usePaneStatusFooter({ registrationId: "cot:board", enabled: !open, loading: resource.loading, error: resource.error,
    info: data ? [{ id: "as-of", parts: [{ text: `CFTC futures only · ${data.asOf ?? "--"} · contracts`, tone: "muted" }] },
      ...(data.status !== "available" ? [{ id: "partial", parts: [{ text: data.status, tone: "warning" as const }] }] : [])] : [] });
  if (!data && !open) return <PaneStatusBody loading={resource.loading} error={resource.error} empty={!resource.loading && !resource.error} subject="COT history" />;
  return <DataTableStackView<CotBoardRow> columns={BOARD_COLUMNS} items={rows} focused={focused && !searching}
    rootWidth={width} rootHeight={height} selection={{ kind: "id", selectedId: selected, getId: (row) => row.contractCode, onChange: setSelected }}
    getItemKey={(row) => row.contractCode} onActivate={(row) => setOpen(row.contractCode)} freezeFirstColumn
    sortable sortColumnId={sort.id || null} sortDirection={sort.direction} onHeaderClick={(id) => setSort((current) => ({ id, direction: current.id === id && current.direction === "desc" ? "asc" : "desc" }))}
    renderCell={(row, column) => {
      if (column.id === "name") return { text: cotMarketName(row.marketName) };
      if (column.id === "code") return { text: row.contractCode, color: colors.textMuted };
      if (column.id === "net") return { text: cotInteger(row.position.net, true) };
      if (column.id === "change") return { text: cotInteger(row.position.weeklyChange, true) };
      if (column.id === "one" || column.id === "three") return { text: rank(column.id === "one" ? row.position.percentile1Y.value : row.position.percentile3Y.value), color: colors.warning };
      return { text: row.reportDate, color: colors.textMuted };
    }}
    rootBefore={<QueryBar width={width}
      search={{ value: query, onChange: setQuery, placeholder: "market or CFTC code", focused, active: searching,
        onActiveChange: setSearching, focusToken: searchFocus, inputRef: searchInput }}
      filters={[
        { id: "class", label: "Class", value: traderClass, options: COT_CLASSES[family], onChange: setClass, controlRef: control },
        { id: "scope", label: "Scope", value: scope, defaultValue: "major", options: [...COT_SCOPES], onChange: setScope, controlRef: scopeControl },
      ]} />}
    emptyStateTitle={data ? query ? "No matching COT markets." : "No major markets in this report; switch the scope to all markets." : ""} detailOpen={!!open} onBack={() => setOpen(null)}
    detailTitle={cotDetailTitle(data?.rows.find((row) => row.contractCode === open)?.marketName, open)}
    detailContent={open ? <CotDetail key={`${family}:${open}`} width={width} height={Math.max(3, height - 2)} focused={focused}
      code={open} family={family} traderClass={traderClass} onClassChange={setClass} /> : null} />;
}

function CotDetail({ width, height, focused, code, family, traderClass, onClassChange }: Pick<PaneProps, "width" | "height" | "focused"> & { code: string; family: CotFamily; traderClass: CotClass; onClassChange: (value: CotClass) => void }) {
  const colors = useThemeColors();
  const session = useResearchCloudSession();
  const loader = useCallback(() => loadCotDetail(code, family), [code, family, session.requestKey]);
  const resource = useAsyncResource(loader, { clearOnError: clearDenied });
  const data = resource.data;
  const payload = data?.payload;
  const current = payload?.positions.find((row) => row.id === traderClass);
  const series = useMemo(() => data ? cotChartSeries(data.payload, traderClass, data.price, colors) : [], [data, traderClass, colors]);
  // The selected class row already carries the net and both ranks, and the
  // legend the charted net, so the detail opens on the chart. A rank over a
  // short history is a limitation, so it sits behind the warning.
  const partialRanks = current ? ([1, 3] as const).flatMap((years) => {
    const window = years === 1 ? current.percentile1Y : current.percentile3Y;
    return window.completeWindow ? [] : [`${years}Y percentiles rank a partial history${window.historyStart ? ` from ${window.historyStart}` : ""}.`];
  }) : [];
  const chartHeight = Math.max(6, Math.floor((height - 1) * 0.65));
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => {
    if (focused && !event.targetEditable && !event.ctrl && !event.meta && !event.alt && !event.super && event.name === "r") {
      event.preventDefault(); void resource.reload();
    }
  });
  usePaneNoticeFooter({ registrationId: "cot:detail-notices", focused, notices: [...(payload?.gaps ?? []), ...(data?.priceWarning ? [data.priceWarning] : []), ...partialRanks] });
  usePaneStatusFooter({ registrationId: "cot:detail", loading: resource.loading, error: resource.error,
    info: payload ? [{ id: "as-of", parts: [{ text: `CFTC ${payload.asOf ?? "--"} · contracts${data?.priceAsOf ? ` · ${data.priceSymbol} ${data.priceAsOf}` : ""}`, tone: "muted" }] },
      ...(payload.status !== "available" ? [{ id: "partial", parts: [{ text: payload.status, tone: "warning" as const }] }] : [])] : [] });
  return <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} empty={!!payload && !payload.contract} subject="COT contract">
    {payload && data ? <Box width={width} height={height} flexDirection="column">
      <CompositeChart series={series} panels={data.price.length ? [{ id: "price", height: 2 }, { id: "net", height: 1 }] : [{ id: "net" }]}
        width={width} height={chartHeight} focused={focused} showLegend showTimeAxis navigable={false} formatValue={cotLegendValue} remoteKind="cot-history" />
      <DataTableView columns={POSITION_COLUMNS} items={payload.positions} focused={focused} rootWidth={width} rootHeight={Math.max(3, height - chartHeight)}
        selection={{ kind: "id", selectedId: traderClass, getId: (row) => row.id, onChange: (id) => onClassChange(id as CotClass) }}
        onActivate={(row) => onClassChange(row.id)} getItemKey={(row) => row.id} sortColumnId={null} sortDirection="asc"
        renderCell={(row: CotClassSummary, column) => ({ text: column.id === "name" ? row.label : column.id === "one" ? rank(row.percentile1Y.value)
          : column.id === "three" ? rank(row.percentile3Y.value) : cotInteger(column.id === "change" ? row.weeklyChange : row[column.id as "long" | "short" | "net"], column.id === "net" || column.id === "change") })}
        emptyStateTitle="Position classes unavailable." />
    </Box> : null}
  </PaneStatusBody>;
}
