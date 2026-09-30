import type { PaneRuntimeState } from "../core/state/app/types";
import type { LayoutConfig, LayoutOrigin, SavedLayout } from "../types/config";
import type { PaneDef } from "../types/plugin";
import { layoutContentFingerprint, type CloudLayoutEntry } from "./cloud";
import { publishableMarketplaceLayout } from "../shares/portable-layout";

export interface LinkedLayoutStatus {
  origin: LayoutOrigin;
  /** Local content differs from the revision the tab last matched. */
  dirty: boolean;
  /** The team holds a revision newer than the one linked. */
  updateAvailable: number | null;
}

/**
 * Fingerprints a saved tab the same way the server sees it: through the
 * publishable projection, so private fields and geometry never count as
 * edits. Throws only when the layout cannot be projected at all.
 */
export function fingerprintSavedLayout(
  layout: LayoutConfig,
  paneState: Record<string, PaneRuntimeState>,
  panes: ReadonlyMap<string, PaneDef>,
): string | null {
  try {
    return layoutContentFingerprint(publishableMarketplaceLayout(layout, paneState, panes));
  } catch {
    return null;
  }
}

export function linkedLayoutStatus(
  saved: Pick<SavedLayout, "layout" | "paneState" | "origin">,
  panes: ReadonlyMap<string, PaneDef>,
  remoteRevision: number | null | undefined,
): LinkedLayoutStatus | null {
  if (!saved.origin) return null;
  const fingerprint = fingerprintSavedLayout(
    saved.layout,
    (saved.paneState ?? {}) as Record<string, PaneRuntimeState>,
    panes,
  );
  return {
    origin: saved.origin,
    dirty: fingerprint !== null && fingerprint !== saved.origin.contentHash,
    updateAvailable: remoteRevision != null && remoteRevision > saved.origin.revision ? remoteRevision : null,
  };
}

/** Marker for a status bar tab: `*` dirty, `↓` update waiting, both when both. */
export function linkedLayoutMarker(status: LinkedLayoutStatus | null): string {
  if (!status) return "";
  return `${status.dirty ? "*" : ""}${status.updateAvailable ? "↓" : ""}`;
}

type Listener = () => void

/**
 * What the last check said each linked layout's team revision is. Small and
 * in memory: it is re-derived on start and whenever a layout-updated card
 * arrives, so nothing here needs to survive a restart.
 */
class LinkedLayoutUpdates {
  private remote = new Map<string, number>();
  private readonly listeners = new Set<Listener>();

  remoteRevision(layoutId: string): number | null {
    return this.remote.get(layoutId) ?? null;
  }

  setRemoteRevision(layoutId: string, revision: number): void {
    if (this.remote.get(layoutId) === revision) return;
    this.remote = new Map(this.remote).set(layoutId, revision);
    for (const listener of this.listeners) listener();
  }

  forget(layoutId: string): void {
    if (!this.remote.has(layoutId)) return;
    this.remote = new Map(this.remote);
    this.remote.delete(layoutId);
    for (const listener of this.listeners) listener();
  }

  snapshot(): ReadonlyMap<string, number> {
    return this.remote;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const linkedLayoutUpdates = new LinkedLayoutUpdates();

/**
 * The auto-pull rule from the plan, decided per tab:
 * clean and newer on the server pulls silently; dirty and newer asks.
 */
export function decideLinkedAction(
  status: LinkedLayoutStatus | null,
): "pull" | "ask" | "none" {
  if (!status || !status.updateAvailable) return "none";
  return status.dirty ? "ask" : "pull";
}

export function originFromEntry(entry: CloudLayoutEntry): LayoutOrigin | null {
  if (entry.owner.kind !== "team") return null;
  return {
    kind: "team",
    teamId: entry.owner.id,
    layoutId: entry.id,
    revision: entry.revision,
    contentHash: layoutContentFingerprint(entry),
    syncedAt: new Date().toISOString(),
  };
}
