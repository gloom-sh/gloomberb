import { useCallback, useMemo, useState } from "react";
import { CurveSurface, DataTableView, KeyValueRow, PaneStatusBody, Tabs, usePaneNoticeFooter, usePaneStatusFooter, type DataTableColumn } from "../../../components";
import { ApiRequestError } from "../../../api-client/errors";
import type { FuturesContract } from "../../../api-client/futures-curve";
import { useAsyncResource, usePluginPaneState, useShortcut } from "gloomberb/react";
import { usePaneInstance, usePaneTitle } from "../../../state/app/context";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "gloomberb/ui";
import { useAutoRefresh } from "../shared/auto-refresh";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { getCachedFuturesCurve, loadFuturesCurve } from "./client";
import { curvePrice, curveRank, curveTimestamp, futuresCurveSeries, normalizeCurveRoot, sortCurveContracts } from "./model";

const TABS = [{ value: "curve", label: "Curve" }, { value: "contracts", label: "Contracts" }];
const COLUMNS: DataTableColumn[] = [
  { id: "symbol", label: "CONTRACT", width: 15, align: "left" },
  { id: "expiry", label: "EXPIRY", width: 10, align: "left" },
  { id: "price", label: "PRICE", width: 12, align: "right" },
  { id: "percentile", label: "PCTL", width: 5, align: "right" },
  { id: "oi", label: "OPEN INT", width: 10, align: "right" },
  { id: "volume", label: "VOLUME", width: 10, align: "right" },
  { id: "asOf", label: "AS OF", width: 16, align: "left" },
];
const clearDenied = (error: unknown) => error instanceof ApiRequestError && [401, 403].includes(error.status ?? 0);
const signedPercent = (value: number | null) => value == null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
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
  const resource = useAsyncResource(loader, { initialData: () => getCachedFuturesCurve(root), clearOnError: clearDenied });
  const [tab, setTab] = usePluginPaneState("tab", "curve");
  const [selected, setSelected] = usePluginPaneState<string | null>("contract", null);
  const [sort, setSort] = useState({ id: "expiry", direction: "asc" as "asc" | "desc" });
  const data = resource.data;
  usePaneTitle(`CTM ${root}`);
  const curves = useMemo(() => data ? futuresCurveSeries(data) : [], [data]);
  const rows = useMemo(() => sortCurveContracts(data?.contracts ?? [], sort.id, sort.direction), [data, sort]);
  const selectedRow = data?.contracts.find((row) => row.symbol === selected) ?? data?.contracts[0];
  const curveHeight = tab === "curve" ? Math.max(8, Math.floor((height - 4) * 0.6)) : 0;
  useAutoRefresh(resource.updatedAt, resource.load);
  useShortcut((event) => {
    if (focused && !event.targetEditable && !event.ctrl && !event.meta && event.name === "r") {
      event.preventDefault(); void resource.reload();
    }
  });
  usePaneNoticeFooter({ registrationId: "futures-curve:notices", focused, notices: data?.gaps ?? [] });
  const delay = Math.max(0, ...(data?.contracts.map((row) => row.delayMinutes ?? 0) ?? []));
  usePaneStatusFooter({ registrationId: "futures-curve", loading: resource.loading, error: resource.error,
    info: data ? [
      { id: "source", parts: [{ text: `${data.source === "cboe" ? "Cboe settlement" : `Yahoo ${delay > 0 ? `${delay}m delayed` : "dated quotes"}`} · ${data.quoteUnit ?? data.currency ?? "units unavailable"} · ${curveTimestamp(data.asOf)}${data.asOf?.includes("T") ? " UTC" : ""}`, tone: "muted" }] },
      ...(data.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
      ...(data.status !== "available" ? [{ id: "partial", parts: [{ text: data.status, tone: "warning" as const }] }] : []),
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
    <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} focused={focused} dense />
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null}
      empty={!!data && !data.contracts.length} subject="futures curve">
      {data ? <>
        <Box flexDirection="column" paddingX={1} flexShrink={0}>
          {selectedRow ? <KeyValueRow label={selectedRow.symbol} value={curvePrice(selectedRow.price, root)}
            detail={`${curveTimestamp(selectedRow.asOf)} · ${curveRank(selectedRow.percentile, selectedRow.samples, selectedRow.historyStart, selectedRow.historyEnd)}`} /> : null}
          <KeyValueRow label="Ann. roll yield" value={signedPercent(data.slope.annualizedRollYield)}
            detail={`${curveTimestamp(data.slope.asOf)} · ${curveRank(data.slope.rollPercentile, data.slope.samples, data.slope.historyStart, data.slope.historyEnd)}`} />
        </Box>
        {tab === "curve" ? <CurveSurface series={curves} width={width} height={curveHeight}
          formatValue={(value) => curvePrice(value, root)} formatX={(value) => new Date(value).toISOString().slice(2, 10)}
          selectedPointId={selected} onSelectedPointChange={setSelected}
          slope={{ label: `M2-M1 ${data.slope.state}`, value: data.slope.value,
            percentile: data.slope.samples < 2 ? null : data.slope.percentile, window: `${data.slope.samples} obs`,
            asOf: data.slope.asOf, formatValue: (value) => curvePrice(value, root) }} /> : null}
        <DataTableView columns={COLUMNS} items={rows} focused={focused}
          rootWidth={width} rootHeight={Math.max(3, height - curveHeight - 3)}
          selection={{ kind: "id", selectedId: selectedRow?.symbol ?? null, getId: (row) => row.symbol, onChange: setSelected }}
          onActivate={(row) => setSelected(row.symbol)} getItemKey={(row) => row.symbol} renderCell={renderCell}
          sortColumnId={sort.id} sortDirection={sort.direction}
          onHeaderClick={(id) => setSort((current) => ({ id, direction: current.id === id && current.direction === "asc" ? "desc" : "asc" }))}
          emptyStateTitle="No listed contracts available." />
      </> : null}
    </PaneStatusBody>
  </Box>;
}
