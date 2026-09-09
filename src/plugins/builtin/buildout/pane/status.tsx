import { PaneStatusBody, type PaneFooterSegment } from "../../../../components";
import type {
  BuildoutList,
  BuildoutLoadState,
  BuildoutTabId,
} from "../model/types";

export function activeBuildoutPage(
  state: BuildoutLoadState,
  activeTab: BuildoutTabId,
  selectedList: BuildoutList | null,
) {
  if (state.status !== "ready") return null;
  if (activeTab === "companies") return selectedList ? state.companies : null;
  if (activeTab === "sites") return state.sites;
  return state.intel;
}

export function updateBuildoutFooterInfo(
  state: BuildoutLoadState,
  activeTab: BuildoutTabId,
  selectedList: BuildoutList | null,
  favoriteMessage: string | null,
): PaneFooterSegment[] {
  if (state.status === "loading") {
    return [{ id: "loading", parts: [{ text: "loading", tone: "value" }] }];
  }

  if (state.status === "error") {
    return [{ id: "error", parts: [{ text: "load failed", tone: "negative" }] }];
  }

  const info: PaneFooterSegment[] = [{
    id: "access",
    parts: [{
      text: state.access === "pro"
        ? "pro access"
        : activeTab === "intel" ? "delayed 72h" : "upgrade for full data",
      tone: state.access === "pro" ? "positive" : "warning",
    }],
  }];

  const page = activeBuildoutPage(state, activeTab, selectedList);
  if (page?.loadingMore) {
    info.push({ id: "loading-more", parts: [{ text: "loading more", tone: "value" }] });
  }
  if (page?.error) {
    info.push({ id: "page-error", parts: [{ text: page.error, tone: "negative" }] });
  }
  if (favoriteMessage) {
    info.push({ id: "favorite-error", parts: [{ text: favoriteMessage, tone: "negative" }] });
  }

  return info;
}

export function renderBuildoutPageStatus(
  state: BuildoutLoadState,
  activeTab: BuildoutTabId,
  selectedList: BuildoutList | null,
) {
  const page = activeBuildoutPage(state, activeTab, selectedList);
  if (!page) return null;
  if (page.loadingMore && page.items.length === 0) {
    return <PaneStatusBody loading loadingLabel={`Loading ${selectedList?.name ?? activeTab}...`} />;
  }
  if (page.error) return <PaneStatusBody error={page.error} errorTitle="Could not load rows." />;
  return null;
}
