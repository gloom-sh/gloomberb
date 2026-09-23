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

/**
 * Only what changes: the free tier's delay on intel, a list the free tier
 * cannot see the end of, loading and failures. "pro access" was fixed text,
 * and the upgrade pitch is the `$` hint.
 */
export function updateBuildoutFooterInfo(
  state: BuildoutLoadState,
  activeTab: BuildoutTabId,
  selectedList: BuildoutList | null,
  messages: {
    favoriteMessage: string | null;
    upgradeMessage: string | null;
    partialList: boolean;
    onUpgrade: () => void;
    /** What the open company's live price is (`real-time`, `15m delayed`). */
    quoteFreshness?: string | null;
  },
): PaneFooterSegment[] {
  if (state.status === "loading") {
    return [{ id: "loading", parts: [{ text: "loading", tone: "muted" }] }];
  }

  if (state.status === "error") {
    return [{ id: "error", parts: [{ text: "load failed", tone: "negative" }] }];
  }

  const info: PaneFooterSegment[] = [];
  if (messages.quoteFreshness) {
    info.push({ id: "quote", parts: [{ text: messages.quoteFreshness, tone: "muted" }] });
  }
  if (state.access !== "pro" && activeTab === "intel") {
    info.push({ id: "access", onPress: messages.onUpgrade, parts: [{ text: "72h delayed", tone: "warning" }] });
  }
  if (messages.partialList) {
    info.push({ id: "partial", onPress: messages.onUpgrade, parts: [{ text: "partial list", tone: "warning" }] });
  }
  if (state.refreshing) {
    info.push({ id: "loading", parts: [{ text: "loading", tone: "muted" }] });
  }
  if (state.refreshError) {
    info.push({ id: "refresh-error", parts: [{ text: state.refreshError, tone: "warning" }] });
  }

  const page = activeBuildoutPage(state, activeTab, selectedList);
  if (page?.loadingMore) {
    info.push({ id: "loading-more", parts: [{ text: "loading more", tone: "muted" }] });
  }
  if (page?.error) {
    info.push({ id: "page-error", parts: [{ text: page.error, tone: "negative" }] });
  }
  if (messages.favoriteMessage) {
    info.push({ id: "favorite-error", parts: [{ text: messages.favoriteMessage, tone: "negative" }] });
  }
  if (messages.upgradeMessage) {
    info.push({ id: "upgrade-error", parts: [{ text: messages.upgradeMessage, tone: "negative" }] });
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
