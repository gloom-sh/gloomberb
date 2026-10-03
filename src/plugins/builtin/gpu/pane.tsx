import { useCallback, useMemo } from "react";
import type { GpuBoardRow, GpuEvent } from "../../../api-client/gpu";
import { DataTableView, PaneStatusBody, QueryBar, usePaneFooter, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type DataTableColumn } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { getCachedGpuBoard, GPU_NOT_AVAILABLE, loadGpuBoard, loadGpuEvents } from "./client";
import { GpuEquities } from "./equities";
import { GpuHistory } from "./history";
import { GPU_TABS, gpuBasisLabel, gpuChange, gpuLabel, gpuPrice, gpuRows, gpuSource, gpuTab, gpuTime } from "./model";

const BOARD_COLUMNS: DataTableColumn[] = [
  { id: "gpu", label: "GPU", width: 16, align: "left" }, { id: "source", label: "Source", width: 24, flexGrow: 1, align: "left" },
  { id: "basis", label: "Basis", width: 23, align: "left" }, { id: "price", label: "$/GPU-hr", width: 10, align: "right" },
  { id: "change1d", label: "1D", width: 7, align: "right" }, { id: "change7d", label: "7D", width: 7, align: "right" },
  { id: "change30d", label: "30D", width: 7, align: "right" }, { id: "availability", label: "Avail", width: 15, align: "left" },
  { id: "asof", label: "As of (UTC)", width: 13, align: "left" },
];
type BoardItem = { id: string; locked: true } | (GpuBoardRow & { locked?: false });
const locked: BoardItem = { id: "licensed", locked: true };

function ModelQuery({ rows, model, setModel, width }: { rows: GpuBoardRow[]; model: string; setModel: (value: string) => void; width: number }) {
  return <QueryBar width={width} filters={[{ id: "gpu", label: "GPU", value: model, defaultValue: "",
    options: [{ value: "", label: "All GPUs" }, ...[...new Set(rows.map((row) => row.gpuModel))].sort().map((value) => ({ value, label: value }))], onChange: setModel }]} />;
}

function GpuBoard({ rows, model, setModel, selectedId, select, width, height, focused }: {
  rows: GpuBoardRow[]; model: string; setModel: (value: string) => void; selectedId: string; select: (row: GpuBoardRow, open?: boolean) => void;
  width: number; height: number; focused: boolean;
}) {
  const sorted = useMemo(() => gpuRows(rows, model), [rows, model]);
  // Keep the unavailable licensed slot visible beside the headline aggregates.
  const items = useMemo<BoardItem[]>(() => {
    const firstDirect = sorted.findIndex((row) => row.providerClass !== "aggregate");
    const split = firstDirect < 0 ? sorted.length : firstDirect;
    return [...sorted.slice(0, split), locked, ...sorted.slice(split)];
  }, [sorted]);
  const compact = width < 125;
  const columns = compact ? BOARD_COLUMNS.map((column, index) => ({ ...column, width: [13, 16, 5, 8, 4, 4, 4, 7, 5][index]!, label: column.id === "asof" ? "UTC" : column.label })) : BOARD_COLUMNS;
  return <DataTableView columns={columns} items={items} rootWidth={width} rootHeight={height} focused={focused}
    rootBefore={<ModelQuery rows={rows} model={model} setModel={setModel} width={width} />}
    selection={{ kind: "id", selectedId: selectedId || sorted[0]?.id || null, getId: (row) => row.id,
      onChange: (_id, row) => { if (!row.locked) select(row); } }} isNavigable={(row) => !row.locked}
    getItemKey={(row) => row.id} onActivate={(row) => { if (!row.locked) select(row, true); }} sortColumnId={null} sortDirection="asc"
    selectedTextOverridesCellColor renderCell={(row, column) => {
      if (row.locked) return { text: column.id === "source" ? "Index (licensed)" : column.id === "basis" ? "Locked" : "-" };
      if (column.id === "gpu") return { text: gpuLabel(row) };
      if (column.id === "source") return { text: `${compact && row.providerClass === "aggregate" ? gpuSource(row).replace(" list median", " median") : gpuSource(row)}${row.providerClass === "aggregate" ? ` (${row.stats?.n ?? "-"})` : ""}` };
      if (column.id === "basis") return { text: gpuBasisLabel(row.basis, compact) };
      if (column.id === "price") return { text: gpuPrice(row.pricePerGpuHr), value: row.pricePerGpuHr };
      if (column.id === "availability") return { text: row.availability ?? "-" };
      if (column.id === "asof") return { text: `${compact ? row.observedAt.slice(11, 16) : gpuTime(row.observedAt, true)}${row.stale ? " stale" : ""}`, value: row.observedAt };
      const change = row[column.id as "change1d" | "change7d" | "change30d"];
      return { text: gpuChange(change), value: change };
    }} emptyStateTitle="No GPU rental prices match." />;
}

const CHANGE_COLUMNS: DataTableColumn[] = [
  { id: "date", label: "Date (UTC)", width: 17, align: "left" }, { id: "gpu", label: "GPU", width: 16, align: "left" },
  { id: "source", label: "Source", width: 23, flexGrow: 1, align: "left" }, { id: "basis", label: "Basis", width: 23, align: "left" },
  { id: "old", label: "Old $/GPU-hr", width: 13, align: "right" }, { id: "new", label: "New $/GPU-hr", width: 13, align: "right" },
  { id: "change", label: "Change", width: 8, align: "right" }, { id: "event", label: "Event", width: 25, align: "left" },
];

function GpuChanges({ board, model, setModel, reloadBoard, width, height, focused }: {
  board: GpuBoardRow[]; model: string; setModel: (value: string) => void; reloadBoard: () => void; width: number; height: number; focused: boolean;
}) {
  const loader = useCallback((force: boolean) => loadGpuEvents(model || undefined, force), [model]);
  const resource = useAsyncResource(loader);
  const [selected, setSelected] = usePluginPaneState<string | null>("eventSelected", null);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { reloadBoard(); void resource.reload(); }, { focused });
  usePaneStatusFooter({ registrationId: "gpu:changes", loading: resource.loading, error: resource.error, stale: resource.data?.stale });
  usePaneNoticeFooter({ registrationId: "gpu:change-notices", focused, notices: resource.data?.refreshError ? [resource.data.refreshError] : [] });
  const events = resource.data?.payload.events ?? [];
  const compact = width < 145;
  const columns = compact ? CHANGE_COLUMNS.map((column, index) => ({ ...column, width: [14, 13, 9, 5, 7, 7, 8, 10][index]!,
    label: column.id === "old" ? "Old $/h" : column.id === "new" ? "New $/h" : column.label })) : CHANGE_COLUMNS;
  return <PaneStatusBody loading={resource.loading && !resource.data} error={!resource.data ? resource.error : null} subject="GPU price changes">
    <DataTableView<GpuEvent> columns={columns} items={events} rootWidth={width} rootHeight={height} focused={focused}
      rootBefore={<ModelQuery rows={board} model={model} setModel={setModel} width={width} />}
      selection={{ kind: "id", selectedId: selected ?? events[0]?.id ?? null, getId: (row) => row.id, onChange: setSelected }}
      getItemKey={(row) => row.id} onActivate={(row) => setSelected(row.id)} sortColumnId={null} sortDirection="desc"
      renderCell={(event, column) => {
        if (column.id === "date") { const at = event.effectiveAt ?? event.observedAt; return { text: event.effectiveAt ? `Eff ${at.slice(0, 10)}` : compact ? at.slice(0, 10) : `${at.slice(0, 10)} ${at.slice(11, 16)}`, value: at }; }
        if (column.id === "gpu") return { text: gpuLabel(event) };
        if (column.id === "source") return { text: gpuSource(event) };
        if (column.id === "basis") return { text: gpuBasisLabel(event.basis, compact) };
        if (column.id === "old") return { text: gpuPrice(event.oldPrice), value: event.oldPrice };
        if (column.id === "new") return { text: gpuPrice(event.newPrice), value: event.newPrice };
        if (column.id === "change") return { text: gpuChange(event.changePct), value: event.changePct };
        return { text: event.kind === "membership" ? `Basket: ${event.oldMembers?.length ?? 0} to ${event.newMembers?.length ?? 0} providers`
          : event.origin === "published" ? compact ? "Published" : "Published price change" : compact ? "Observed" : "Observed price change" };
      }} emptyStateTitle="No price changes recorded yet." />
  </PaneStatusBody>;
}

export function GpuPane({ width, height, focused }: PaneProps) {
  const params = usePaneInstance()?.params;
  const [openingTab] = usePaneSettingValue<string>("tab", "board");
  const [storedTab, setTab] = usePluginPaneState<string>("tab", openingTab);
  const tab = gpuTab(storedTab);
  const [model, setModel] = usePluginPaneState<string>("model", params?.gpuModel ?? "");
  const [selectedId, setSelectedId] = usePluginPaneState<string>("series", "");
  const resource = useAsyncResource(loadGpuBoard, { initialData: getCachedGpuBoard });
  const data = resource.data?.payload;
  const { createPaneFromTemplate } = usePluginAppActions();
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused: focused && (tab === "board" || !data) });
  const notAvailable = !data && resource.error === GPU_NOT_AVAILABLE;
  usePaneStatusFooter({ registrationId: "gpu", loading: resource.loading, error: notAvailable ? null : resource.error,
    stale: !!data && (data.stale || resource.data?.stale), info: data?.asOf ? [{ id: "asof", parts: [{ text: `as of ${gpuTime(data.asOf)}`, tone: "muted" }] }] : [] });
  usePaneNoticeFooter({ registrationId: "gpu:notices", focused,
    notices: [...(data?.gaps ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneFooter("gpu:actions", () => ({ hints: [{ id: "buildout", key: "t", label: "BO", title: "Open TheBuildout",
    onPress: () => createPaneFromTemplate("buildout-pane") }] }), [createPaneFromTemplate]);
  const { strip, rows: tabRows } = usePaneTabs(data ? { tabs: [...GPU_TABS], activeValue: tab, onSelect: setTab, focused, dense: true } : null);
  const body = { width, height: Math.max(3, height - tabRows), focused };
  const reloadBoard = useCallback(() => { void resource.reload(); }, [resource.reload]);
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={resource.loading && !data} error={!data && !notAvailable ? resource.error : null}
      empty={notAvailable} emptyTitle={GPU_NOT_AVAILABLE} subject="GPU rental prices">
      {data ? tab === "board" ? <GpuBoard rows={data.rows} model={model} setModel={setModel} selectedId={selectedId}
        select={(row, open) => { setSelectedId(row.id); if (open) setTab("history"); }} {...body} />
        : tab === "history" ? <GpuHistory rows={data.rows} selectedId={selectedId} onSelect={setSelectedId} initialModel={model || "H100"} reloadBoard={reloadBoard} {...body} />
          : tab === "changes" ? <GpuChanges board={data.rows} model={model} setModel={setModel} reloadBoard={reloadBoard} {...body} />
            : <GpuEquities board={data.rows} model={model} setModel={setModel} reloadBoard={reloadBoard} {...body} /> : null}
    </PaneStatusBody>
  </Box>;
}
