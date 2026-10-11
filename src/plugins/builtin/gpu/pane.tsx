import { usePlanAccess } from "../../../api-client/plan-access";
import { isAccessDenied } from "../../../api-client/errors";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { useCallback, useMemo } from "react";
import { PaneStatusBody, usePaneFooter, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { GpuBoard } from "./board";
import { getCachedGpuBoard, gpuCacheScope, GPU_NOT_AVAILABLE, gpuPreviewModels, loadGpuBoard, loadGpuModelPreviews } from "./client";
import { GpuChanges } from "./changes";
import { GpuEquities } from "./equities";
import { GpuHistory } from "./history";
import { GPU_TABS, gpuEquityModels, gpuFamilies, gpuFamily, gpuNoMatch, gpuTab, gpuTime } from "./model";

export function GpuPane(props: PaneProps) {
  usePlanAccess();
  return <GpuView key={gpuCacheScope()} {...props} />;
}

function GpuView({ width, height, focused }: PaneProps) {
  const session = useResearchCloudSession();
  const upgrade = useCloudUpgradeAction("gpu");
  const params = usePaneInstance()?.params;
  const [openingTab] = usePaneSettingValue<string>("tab", "board");
  const [storedTab, setTab] = usePluginPaneState<string>("tab", openingTab);
  const tab = gpuTab(storedTab);
  const [model, setModel] = usePluginPaneState<string>("model", params?.gpuModel ?? "");
  const [selectedId, setSelectedId] = usePluginPaneState<string>("series", "");
  const resource = useAsyncResource(loadGpuBoard, { initialData: getCachedGpuBoard, clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const { createPaneFromTemplate } = usePluginAppActions();
  const locked = !!data?.access?.locked;
  const families = useMemo(() => gpuFamilies(data?.rows ?? []), [data]);
  // What was typed ("h-100", "H100 80GB SXM") reads as the GPU it names; a name that matches none stays as typed and says so.
  const activeModel = model ? gpuFamily(model, families) ?? model : "";
  const unknownModel = !!model && !families.includes(activeModel);
  // The free board is one GPU's three rows; another GPU's free preview stands in for the rows it leaves out.
  const previewKey = useMemo(() => data && !unknownModel ? gpuPreviewModels(data, tab === "equities" ? gpuEquityModels(activeModel || "H100")
    : tab === "changes" ? [] : tab === "history" ? [activeModel || "H100"] : [activeModel]).join("\n") : "", [data, unknownModel, tab, activeModel]);
  const previewLoader = useCallback((force: boolean) => loadGpuModelPreviews(previewKey.split("\n"), force), [previewKey]);
  const preview = useAsyncResource(previewKey ? previewLoader : null);
  const rows = useMemo(() => data ? [...data.rows, ...(previewKey ? preview.data ?? [] : [])] : [], [data, previewKey, preview.data]);
  const models = useMemo(() => locked ? [...families].sort() : [...new Set(rows.map((row) => row.gpuModel))].sort(), [locked, families, rows]);
  // A failed preview is the footer's error; the body does not repeat it.
  const emptyTitle = unknownModel ? gpuNoMatch(model, families)
    : preview.error ? `No ${activeModel} rental prices to show.` : `No ${activeModel} rental prices have been observed yet.`;
  useAutoRefresh(resource.updatedAt, resource.load);
  useAutoRefresh(preview.updatedAt, preview.load);
  usePaneRefreshKey(() => { void resource.reload(); void preview.reload(); }, { focused: focused && (tab === "board" || !data) });
  const signIn = !data && (session.needsVerification || isCloudSessionRequired(resource.error));
  const notAvailable = !data && resource.error === GPU_NOT_AVAILABLE;
  usePaneStatusFooter({ registrationId: "gpu", loading: resource.loading || preview.loading, error: notAvailable || signIn ? null : resource.error ?? preview.error,
    stale: !!data && (data.stale || resource.data?.stale), info: data?.asOf ? [{ id: "asof", asOf: true, parts: [{ text: `as of ${gpuTime(data.asOf)}`, tone: "muted" }] }] : [] });
  usePaneNoticeFooter({ registrationId: "gpu:notices", focused,
    notices: [...(data?.gaps ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneFooter("gpu:actions", () => ({ info: data?.access?.preview ? [{ id: "preview", parts: [{ text: "Free preview", tone: "muted" }] }] : [],
    hints: [...(data?.access?.locked ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Unlock full GPU history with Pro", onPress: upgrade }] : []), { id: "buildout", key: "t", label: "BO", title: "Open TheBuildout",
    onPress: () => createPaneFromTemplate("buildout-pane") }] }), [createPaneFromTemplate, data?.access, upgrade]);
  const { strip, rows: tabRows } = usePaneTabs(data ? { tabs: [...GPU_TABS], activeValue: tab, onSelect: setTab, focused, dense: true } : null);
  const body = { width, height: Math.max(3, height - tabRows), focused };
  const reloadBoard = useCallback(() => { void resource.reload(); void preview.reload(); }, [resource.reload, preview.reload]);
  if (signIn) return <SignInWall placement="gpu" width={width} height={height} action="browse GPU rental prices" needsVerification={session.needsVerification} />;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={(resource.loading && !data) || (!!previewKey && preview.loading && !preview.data)} error={!data && !notAvailable ? resource.error : null}
      empty={notAvailable} emptyTitle={GPU_NOT_AVAILABLE} subject="GPU rental prices">
      {data ? tab === "board" ? <GpuBoard rows={rows} models={models} asOf={data.asOf} model={activeModel} setModel={setModel} selectedId={selectedId} emptyTitle={emptyTitle}
        select={(row, open) => { setSelectedId(row.id); if (open) setTab("history"); }} {...body} />
        : tab === "history" ? <GpuHistory rows={rows} models={models} model={unknownModel ? "" : activeModel} setModel={setModel} selectedId={selectedId} onSelect={setSelectedId} reloadBoard={reloadBoard} {...body} />
          : tab === "changes" ? <GpuChanges models={models} model={unknownModel ? "" : activeModel} setModel={setModel} reloadBoard={reloadBoard} {...body} />
            : <GpuEquities board={rows} models={models} locked={locked} model={unknownModel ? "" : activeModel} setModel={setModel} reloadBoard={reloadBoard} {...body} /> : null}
    </PaneStatusBody>
  </Box>;
}
