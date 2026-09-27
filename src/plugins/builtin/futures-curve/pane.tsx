import { useCallback, useMemo, useState } from "react";
import { CurveSurface, curveGhostColors, DataTableView, PaneStatusBody, StatGrid, statGridRows, Tabs, usePaneHeaderTabs, usePaneNoticeFooter, usePaneStatusFooter, type DataTableColumn, type StatItem } from "../../../components";
import { isAccessDenied } from "../../../api-client/errors";
import { getTableWidth, hasMeaningfulTableHorizontalOverflow } from "../../../components/ui/table-layout";
import type { FuturesContract } from "../../../api-client/futures-curve";
import { useAsyncResource, usePaneSettingValue, usePluginPaneState, useShortcut } from "../../../public/react";
import { usePaneInstance, usePaneTitle } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { formatPercentRaw } from "../../../utils/format";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { futuresSessionRefreshInterval } from "../shared/futures-session";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { getCachedFuturesCurve, loadFuturesCurve } from "./client";
import { curveAxisPrice, curvePrice, curveRank, curveTimestamp, DEFAULT_CURVE_HORIZON, futuresCurveSeries, newestQuote, normalizeCurveRoot, sortCurveContracts } from "./model";

const TABS = [{ value: "curve", label: "Curve" }, { value: "contracts", label: "Contracts" }];
const COLUMNS: DataTableColumn[] = [
  { id: "symbol", label: "CONTRACT", width: 15, align: "left" },
  { id: "expiry", label: "EXPIRY", width: 10, align: "left" },
  { id: "price", label: "PRICE", width: 12, align: "right" },
  { id: "percentile", label: "PCTL", width: 5, align: "right" },
  { id: "oi", label: "OPEN INT", width: 10, align: "right" },
  { id: "volume", label: "VOLUME", width: 10, align: "right" },
  { id: "asOf", label: "AS OF UTC", width: 16, align: "left" },
];
const signedPercent = (value: number | null) => value == null ? "--" : formatPercentRaw(value);
const integer = (value: number | null) => value == null ? "--" : value.toLocaleString("en-US");

export function FuturesCurvePane(props: PaneProps) {
  const pane = usePaneInstance();
  const requested = pane?.settings?.root ?? pane?.params?.root ?? "ES";
  const root = normalizeCurveRoot(requested);
  return root ? <FuturesCurveView key={root} {...props} root={root} />
    : <PaneStatusBody error={`Unsupported futures root: ${String(requested)}`} subject="futures curve" />;
}

function FuturesCurveView({ width, height, focused, root }: PaneProps & { root: string }) {
  const colors = useThemeColors();
  const session = useResearchCloudSession();
  const loader = useCallback((force: boolean) => loadFuturesCurve(root, force), [root, session.requestKey]);
  const resource = useAsyncResource(loader, { initialData: () => getCachedFuturesCurve(root), clearOnError: isAccessDenied });
  const [tab, setTab] = usePluginPaneState("tab", "curve");
  const [selected, setSelected] = usePluginPaneState<string | null>("contract", null);
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: "expiry", direction: "asc" });
  const [horizon] = usePaneSettingValue("horizon", DEFAULT_CURVE_HORIZON);
  const data = resource.data;
  usePaneTitle(`CTM ${root}`);
  const staleCount = data?.contracts.filter((row) => row.stale).length ?? 0;
  const newest = data ? newestQuote(data.contracts) : null;
  // The footer carries the newest quote time, so the legend does not repeat it.
  const curves = useMemo(() => data ? futuresCurveSeries(data, { current: colors.positive, ghosts: curveGhostColors(colors) }, horizon)
    .map((series) => series.id === "current" && curveTimestamp(series.asOf ?? null) === curveTimestamp(newest) ? { ...series, asOf: undefined } : series) : [], [data, colors, horizon, newest]);
  const rows = useMemo(() => sortCurveContracts(data?.contracts ?? [], sort.columnId, sort.direction), [data, sort]);
  const selectedRow = data?.contracts.find((row) => row.symbol === selected) ?? data?.contracts[0];
  // The highlighted row carries the selected contract's price and rank.
  const slopeDate = data?.slope.asOf && curveTimestamp(data.slope.asOf) !== curveTimestamp(newest) ? curveTimestamp(data.slope.asOf) : null;
  const statItems: StatItem[] = data ? [
    { id: "roll", label: "Ann. roll yield", value: signedPercent(data.slope.annualizedRollYield),
      detail: curveRank(data.slope.rollPercentile, data.slope.samples) },
    { id: "spread", label: "M2-M1", value: data.slope.value == null ? "--" : curvePrice(data.slope.value, root),
      detail: [data.slope.state, curveRank(data.slope.percentile, data.slope.samples), slopeDate].filter(Boolean).join(" · ") },
  ] : [];
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused });
  const tabRows = tabsInHeader ? 0 : 1;
  // The contract table needs its header, rows and any scrollbar; the curve
  // takes the rest, and when that is too short to draw, the table takes it all.
  const bodyHeight = Math.max(1, height - tabRows - statGridRows(statItems, width));
  const contractRows = rows.length + 1 + (hasMeaningfulTableHorizontalOverflow(getTableWidth(COLUMNS), width) ? 1 : 0);
  const curveRoom = tab === "curve" ? bodyHeight - Math.max(3, Math.min(contractRows, Math.floor(bodyHeight * 0.4))) : 0;
  const curveHeight = curveRoom >= 8 ? curveRoom : 0;
  const tableHeight = bodyHeight - curveHeight;
  // Delayed contract quotes move all session; the curve follows them once a
  // minute while Globex trades and on the research cadence otherwise. A
  // settlement curve changes once a day.
  useAutoRefresh(resource.updatedAt, resource.load, {
    intervalMs: data?.source === "cboe" ? null : futuresSessionRefreshInterval(),
  });
  useShortcut((event) => {
    if (focused && !event.targetEditable && !event.ctrl && !event.meta && event.name === "r") {
      event.preventDefault(); void resource.reload();
    }
  });
  usePaneNoticeFooter({ registrationId: "futures-curve:notices", focused, notices: data?.gaps ?? [] });
  const delay = Math.max(0, ...(data?.contracts.map((row) => row.delayMinutes ?? 0) ?? []));
  usePaneStatusFooter({ registrationId: "futures-curve", loading: resource.loading, error: resource.error,
    info: data ? [
      { id: "source", parts: [{ text: `${data.source === "cboe" ? "settlement" : delay > 0 ? `${delay}m delayed` : "dated quotes"} · ${data.quoteUnit ?? data.currency ?? "units unavailable"} · ${curveTimestamp(newest)}${newest?.includes("T") ? " UTC" : ""}`, tone: "muted" }] },
      ...(staleCount ? [{ id: "stale", parts: [{ text: `${staleCount} of ${data.contracts.length} stale`, tone: "warning" as const }] }] : []),
    ] : [],
  });
  const renderCell = useCallback((row: FuturesContract, column: DataTableColumn) => {
    if (column.id === "symbol") return { text: row.symbol };
    if (column.id === "expiry") return { text: row.expiration, color: colors.textMuted };
    if (column.id === "price") return { text: curvePrice(row.price, root) };
    if (column.id === "percentile") return { text: row.samples < 2 || row.percentile == null ? "--" : row.percentile.toFixed(0) };
    if (column.id === "oi") return { text: integer(row.openInterest) };
    if (column.id === "volume") return { text: integer(row.volume) };
    return { text: curveTimestamp(row.asOf), color: row.stale ? colors.warning : colors.textMuted };
  }, [colors, root]);
  return <Box width={width} height={height} flexDirection="column">
    {!tabsInHeader && <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} focused={focused} dense />}
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null}
      empty={!!data && !data.contracts.length} subject="futures curve">
      {data ? <>
        <StatGrid items={statItems} width={width} />
        {curveHeight ? <CurveSurface series={curves} width={width} height={curveHeight} display="chart"
          formatValue={(value) => curvePrice(value, root)} formatAxisValue={(value, domain) => curveAxisPrice(value, domain, root)}
          formatX={(value) => new Date(Math.round(value / 86_400_000) * 86_400_000).toISOString().slice(0, 10)}
          selectedPointId={selectedRow?.symbol ?? null} onSelectedPointChange={setSelected} /> : null}
        <DataTableView columns={COLUMNS} items={rows} focused={focused}
          rootWidth={width} rootHeight={tableHeight}
          selection={{ kind: "id", selectedId: selectedRow?.symbol ?? null, getId: (row) => row.symbol, onChange: setSelected }}
          onActivate={(row) => setSelected(row.symbol)} getItemKey={(row) => row.symbol} renderCell={renderCell}
          sortColumnId={sort.columnId} sortDirection={sort.direction}
          onHeaderClick={(id) => setSort((current) => nextHeaderSort(current, id))}
          emptyStateTitle="No listed contracts available." />
      </> : null}
    </PaneStatusBody>
  </Box>;
}
