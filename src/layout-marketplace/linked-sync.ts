import { useEffect, useRef } from "react";
import { apiClient } from "../api-client";
import { rememberLayoutRequirements } from "../components/layout/missing-pane";
import type { PluginRegistry } from "../plugins/registry";
import { teamStore } from "../plugins/builtin/cloud/team/store";
import { useAppDispatch, useAppSelector } from "../state/app/context";
import { decideLinkedAction, linkedLayoutStatus, linkedLayoutUpdates, originFromEntry } from "./linked";
import { materializeMarketplaceLayout } from "./payload";

/**
 * Keeps linked tabs current, following the plan's rule: a clean tab with a
 * newer team revision pulls silently; a dirty one gets a card and waits for
 * the person to decide in the gallery. Runs on start, whenever sign-in or the
 * tab list changes, and when a layout-updated card arrives.
 */
export function useLinkedLayoutSync(pluginRegistry: PluginRegistry): void {
  const dispatch = useAppDispatch();
  const layouts = useAppSelector((state) => state.config.layouts);
  const layoutsRef = useRef(layouts);
  layoutsRef.current = layouts;
  const checkedRef = useRef(new Map<string, number>());

  useEffect(() => {
    let cancelled = false;

    const check = async (onlyLayoutId?: string) => {
      if (!apiClient.isVerified()) return;
      const panes = pluginRegistry.panes;
      const current = layoutsRef.current;
      for (let index = 0; index < current.length; index += 1) {
        const saved = current[index]!;
        const origin = saved.origin;
        if (!origin || (onlyLayoutId && origin.layoutId !== onlyLayoutId)) continue;
        let cloud: Awaited<ReturnType<typeof apiClient.getCloudLayout>>;
        try {
          cloud = await apiClient.getCloudLayout(origin.layoutId);
        } catch {
          continue;
        }
        if (cancelled) return;
        if (!cloud) {
          linkedLayoutUpdates.forget(origin.layoutId);
          continue;
        }
        rememberLayoutRequirements(cloud.id, cloud.requires);
        linkedLayoutUpdates.setRemoteRevision(cloud.id, cloud.revision);
        const status = linkedLayoutStatus(saved, panes, cloud.revision);
        const action = decideLinkedAction(status);
        if (action === "pull") {
          const nextOrigin = originFromEntry(cloud);
          if (!nextOrigin) continue;
          const installed = materializeMarketplaceLayout(cloud);
          const liveIndex = layoutsRef.current.findIndex((entry) => entry.origin?.layoutId === origin.layoutId);
          if (liveIndex === -1) continue;
          dispatch({
            type: "REPLACE_LAYOUT_CONTENT",
            index: liveIndex,
            layout: installed.layout,
            paneState: installed.paneState,
            origin: nextOrigin,
            name: cloud.name,
          });
          pluginRegistry.notify({ body: `"${cloud.name}" updated to r${cloud.revision} from the team.`, type: "info" });
        } else if (action === "ask" && checkedRef.current.get(origin.layoutId) !== cloud.revision) {
          pluginRegistry.notify({
            body: `The team published "${cloud.name}" r${cloud.revision}. You have local edits; open LAY to pull or publish.`,
            type: "info",
            action: { label: "Open", onClick: () => pluginRegistry.showPane("layout-marketplace") },
          });
        }
        checkedRef.current.set(origin.layoutId, cloud.revision);
      }
    };

    void check();
    const unsubscribeUser = apiClient.subscribeCurrentUser(() => {
      void check();
    });
    const unsubscribeTeam = apiClient.subscribeTeamNotifications((notification) => {
      if (notification.type !== "layout-updated") return;
      const data = notification.data;
      if (data.kind !== "layout-updated") return;
      linkedLayoutUpdates.setRemoteRevision(data.layoutId, data.revision);
      void check(data.layoutId);
    });
    // Cards left over from the previous session for tabs still linked here.
    const unsubscribeStore = teamStore.subscribe((snapshot) => {
      for (const card of snapshot.notifications) {
        if (card.data.kind === "layout-updated") {
          linkedLayoutUpdates.setRemoteRevision(card.data.layoutId, card.data.revision);
        }
      }
    });
    return () => {
      cancelled = true;
      unsubscribeUser();
      unsubscribeTeam();
      unsubscribeStore();
    };
    // Re-run when the set of linked layout ids changes, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, pluginRegistry, layouts.map((layout) => layout.origin?.layoutId ?? "").join("|")]);
}
