import {
  findPaneInstance,
  removePaneInstances,
  type LayoutConfig,
  type PaneInstanceConfig,
} from "../types/config";
import { getDockedPaneIds } from "../plugins/pane-manager";
import type { PaneDef } from "../types/plugin";
import type { PaneRuntimeState } from "../core/state/app/types";
import { fuzzyFilter } from "../utils/fuzzy-search";
import type { LayoutMarketplaceEntry } from "./payload";
import { paneImagery, type PaneImagery } from "./pane-imagery";

type PanePlacement = "docked" | "floating" | "detached";

export interface GalleryPaneSummary {
  instanceId: string;
  paneId: string;
  /** Registered pane name, or the raw pane id when the type is not installed. */
  name: string;
  icon: string;
  /** Public fixed ticker shown in the preview; follow bindings remain structural. */
  symbol: string | null;
  linked: boolean;
  placement: PanePlacement;
  missing: boolean;
  imagery: PaneImagery;
}

export interface GalleryEntry {
  id: string;
  marketplaceId: string | null;
  kind: "owned" | "community";
  name: string;
  layout: LayoutConfig;
  paneState: Record<string, PaneRuntimeState>;
  /** Index into config.layouts; community entries have none. */
  index: number | null;
  active: boolean;
  author: string | null;
  publishedAt: string | null;
}

/**
 * Saved layouts can keep instances that are no longer placed anywhere. Those
 * panes are invisible in the real workspace, so previews and counts ignore them.
 */
function placedInstances(layout: LayoutConfig): Array<{ instance: PaneInstanceConfig; placement: PanePlacement }> {
  const placements: Array<[readonly string[], PanePlacement]> = [
    [getDockedPaneIds(layout), "docked"],
    [layout.floating.map((entry) => entry.instanceId), "floating"],
    [(layout.detached ?? []).map((entry) => entry.instanceId), "detached"],
  ];
  const result: Array<{ instance: PaneInstanceConfig; placement: PanePlacement }> = [];
  for (const [instanceIds, placement] of placements) {
    for (const instanceId of instanceIds) {
      const instance = findPaneInstance(layout, instanceId);
      if (instance) result.push({ instance, placement });
    }
  }
  return result;
}

export function summarizeLayoutPanes(
  layout: LayoutConfig,
  panes: ReadonlyMap<string, PaneDef>,
): GalleryPaneSummary[] {
  return placedInstances(layout).map(({ instance, placement }) => {
    const def = panes.get(instance.paneId);
    return {
      instanceId: instance.instanceId,
      paneId: instance.paneId,
      name: def?.name ?? instance.paneId,
      icon: (def?.icon ?? instance.paneId.charAt(0) ?? "?").toUpperCase().slice(0, 2),
      symbol: instance.binding?.kind === "fixed" ? instance.binding.symbol : null,
      linked: instance.binding?.kind === "follow",
      placement,
      missing: !def,
      imagery: paneImagery(instance.paneId),
    };
  });
}

export function missingPaneIds(
  layout: LayoutConfig,
  panes: ReadonlyMap<string, PaneDef>,
): string[] {
  return [...new Set(placedInstances(layout)
    .map(({ instance }) => instance.paneId)
    .filter((paneId) => !panes.has(paneId)))];
}

export function describeArrangement(layout: LayoutConfig): string {
  const counts = { docked: 0, floating: 0, detached: 0 };
  for (const { placement } of placedInstances(layout)) counts[placement] += 1;
  const parts = [`${counts.docked} docked`];
  if (counts.floating > 0) parts.push(`${counts.floating} floating`);
  if (counts.detached > 0) parts.push(`${counts.detached} detached`);
  return parts.join(" · ");
}

function galleryEntrySearchText(
  entry: GalleryEntry,
  panes: ReadonlyMap<string, PaneDef>,
): string {
  return [
    entry.name,
    entry.author ?? "",
    ...summarizeLayoutPanes(entry.layout, panes).map((pane) => `${pane.paneId} ${pane.name}`),
  ].join(" ");
}

export function filterGalleryEntries(
  entries: GalleryEntry[],
  query: string,
  panes: ReadonlyMap<string, PaneDef>,
): GalleryEntry[] {
  return fuzzyFilter(entries, query.trim(), (entry) => galleryEntrySearchText(entry, panes));
}

function marketplaceAuthorLabel(author: LayoutMarketplaceEntry["author"]): string {
  return author.username ? `@${author.username}` : author.displayName;
}

export function formatPublishedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function buildOwnedEntries(
  layouts: readonly {
    name: string;
    layout: LayoutConfig;
    paneState?: Record<string, PaneRuntimeState>;
  }[],
  activeIndex: number,
): GalleryEntry[] {
  return layouts.map((saved, index) => ({
    id: `owned:${index}`,
    marketplaceId: null,
    kind: "owned" as const,
    name: saved.name,
    layout: removePaneInstances(
      saved.layout,
      saved.layout.instances
        .filter((instance) => instance.paneId === "layout-marketplace")
        .map((instance) => instance.instanceId),
    ),
    paneState: saved.paneState ?? {},
    index,
    active: index === activeIndex,
    author: null,
    publishedAt: null,
  }));
}

export function buildCommunityEntries(items: readonly LayoutMarketplaceEntry[]): GalleryEntry[] {
  return items.map((item) => ({
    id: `community:${item.id}`,
    marketplaceId: item.id,
    kind: "community" as const,
    name: item.name,
    layout: item.layout,
    paneState: item.paneState,
    index: null,
    active: false,
    author: marketplaceAuthorLabel(item.author),
    publishedAt: item.publishedAt,
  }));
}
