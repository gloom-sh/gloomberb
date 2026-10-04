import { useCallback } from "react";
import { PaneStatusBody, usePaneFooter, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { GpuBoard } from "./board";
import { getCachedGpuBoard, GPU_NOT_AVAILABLE, loadGpuBoard } from "./client";
import { GpuChanges } from "./changes";
import { GpuEquities } from "./equities";
import { GpuHistory } from "./history";
import { GPU_TABS, gpuTab, gpuTime } from "./model";

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
      {data ? tab === "board" ? <GpuBoard rows={data.rows} asOf={data.asOf} model={model} setModel={setModel} selectedId={selectedId}
        select={(row, open) => { setSelectedId(row.id); if (open) setTab("history"); }} {...body} />
        : tab === "history" ? <GpuHistory rows={data.rows} model={model} setModel={setModel} selectedId={selectedId} onSelect={setSelectedId} reloadBoard={reloadBoard} {...body} />
          : tab === "changes" ? <GpuChanges board={data.rows} model={model} setModel={setModel} reloadBoard={reloadBoard} {...body} />
            : <GpuEquities board={data.rows} model={model} setModel={setModel} reloadBoard={reloadBoard} {...body} /> : null}
    </PaneStatusBody>
  </Box>;
}
