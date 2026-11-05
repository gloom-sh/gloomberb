import { fnv1aHex, stableStringify } from "../utils/hash";
import type { AppConfig, SavedLayout } from "../types/config";
import { isRecord } from "../utils/guards";
import { sanitizeUnknown } from "./sanitize";

/**
 * What a saved layout mirrors from the live session rather than from the
 * workspace the user arranged. None of it crosses the network: it is the view
 * this device is looking at right now, not a layout two devices should agree
 * on. Syncing it made every poll hand each client the other's open detail,
 * cursor and scroll position, and each apply pushed the view straight back.
 */
const SESSION_SAVED_LAYOUT_KEYS = ["paneState", "focusedPaneId", "activePanel"] as const;

/** Together these are the workspace: the tabs, the one showing, and its arrangement. */
const LAYOUT_SYNC_KEYS = ["layout", "layouts", "activeLayoutIndex"] as const;

export function collectLayoutPayload(config: Pick<AppConfig, typeof LAYOUT_SYNC_KEYS[number]>) {
  return sanitizeUnknown({
    layout: config.layout,
    layouts: config.layouts.map(withoutSessionLayoutState),
    activeLayoutIndex: config.activeLayoutIndex,
  }) as Record<string, unknown>;
}

function withoutSessionLayoutState(savedLayout: SavedLayout): SavedLayout {
  if (!isRecord(savedLayout)) return savedLayout;
  if (!SESSION_SAVED_LAYOUT_KEYS.some((key) => key in savedLayout)) return savedLayout;
  const { paneState: _paneState, focusedPaneId: _focusedPaneId, activePanel: _activePanel, ...rest } = savedLayout;
  return rest;
}

/**
 * A pulled layout list describes the workspace; the session state stays with
 * this device. Entries are matched by name first so a renamed or reordered
 * list still hands each layout back its own pane state.
 */
export function withLocalSessionLayoutState(
  pulled: SavedLayout[],
  local: SavedLayout[],
): SavedLayout[] {
  const localByName = new Map(local.map((savedLayout) => [savedLayout?.name, savedLayout]));
  return pulled.map((savedLayout, index) => {
    if (!isRecord(savedLayout)) return savedLayout;
    const stripped = withoutSessionLayoutState(savedLayout);
    const source = localByName.get(savedLayout.name) ?? local[index];
    if (!source) return stripped;
    return {
      ...stripped,
      paneState: source.paneState,
      focusedPaneId: source.focusedPaneId,
    };
  });
}

/** A dock tree with no stack's shown tab: like stacking order, it follows whichever pane was focused last. */
function withoutShownTabs(node: unknown): unknown {
  if (!isRecord(node) || node.kind !== "split") return node;
  const { tabs, ...rest } = node;
  return {
    ...rest,
    first: withoutShownTabs(node.first),
    second: withoutShownTabs(node.second),
    ...(tabs === undefined ? {} : { tabs: true }),
  };
}

/**
 * A layout as the user arranged it. Stacking order and the tab a stack shows
 * follow whichever pane was focused last, and a pane in its own desktop window
 * is one a terminal draws inline as a floating pane, so none of them tells two
 * copies apart.
 */
function arrangedLayout(layout: unknown): unknown {
  if (!isRecord(layout)) return layout;
  const windows = [
    ...(Array.isArray(layout.floating) ? layout.floating : []),
    ...(Array.isArray(layout.detached) ? layout.detached : []),
  ].map((entry) => {
    if (!isRecord(entry)) return entry;
    const { zIndex: _zIndex, ...rest } = entry;
    return rest;
  });
  const instanceId = (entry: unknown) => (isRecord(entry) ? String(entry.instanceId) : "");
  windows.sort((left, right) => instanceId(left).localeCompare(instanceId(right)));
  return { ...layout, dockRoot: withoutShownTabs(layout.dockRoot), floating: windows, detached: [] };
}

// Pulled and last synced payloads are compared on every sync and never change.
const layoutIntents = new WeakMap<object, string | null>();

/**
 * A key for the workspace a payload describes, equal for two copies that only
 * differ in what reflects one device, so a real edit can be told from them.
 * Null when the payload holds no complete workspace.
 */
export function layoutIntent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.layouts)) return null;
  if (!LAYOUT_SYNC_KEYS.every((key) => key in payload)) return null;
  const cached = layoutIntents.get(payload);
  if (cached !== undefined) return cached;
  const intent = stableStringify(sanitizeUnknown({
    layout: arrangedLayout(payload.layout),
    layouts: payload.layouts.map((entry) => (
      isRecord(entry)
        ? { ...withoutSessionLayoutState(entry as unknown as SavedLayout), layout: arrangedLayout(entry.layout) }
        : entry
    )),
    activeLayoutIndex: payload.activeLayoutIndex,
  }));
  const key = `${fnv1aHex(intent)}:${intent.length}`;
  layoutIntents.set(payload, key);
  return key;
}

/** The workspace keys of a payload, with the time its layout was last edited when it says. */
function pickLayoutPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const picked = Object.fromEntries([...LAYOUT_SYNC_KEYS, "layoutEditedAt"].flatMap((key) => (
    key in payload ? [[key, payload[key]]] : []
  )));
  // An older build still sent the view it was looking at with each layout.
  if (Array.isArray(picked.layouts)) {
    picked.layouts = picked.layouts.map((entry) => (isRecord(entry) ? withoutSessionLayoutState(entry as unknown as SavedLayout) : entry));
  }
  return picked;
}

/**
 * What this device remembers about its workspace between syncs: when it last
 * edited it (null when that happened while the app was closed, so the time is
 * unknown), or, when it took the workspace from the cloud, that copy as synced.
 */
interface LayoutMemo {
  intent: string;
  editedAt: number | null;
  synced?: Record<string, unknown>;
}

export function readLayoutMemo(value: unknown): LayoutMemo | null {
  if (!isRecord(value) || typeof value.intent !== "string") return null;
  return {
    intent: value.intent,
    editedAt: typeof value.editedAt === "number" && Number.isFinite(value.editedAt) ? value.editedAt : null,
    ...(isRecord(value.synced) ? { synced: value.synced } : {}),
  };
}

/**
 * When a pulled workspace was last edited. A copy from a build that did not
 * date edits counts as edited when it was pushed, which is never earlier.
 */
export function pulledLayoutEditedAt(payload: Record<string, unknown>, pushedAt: string | undefined): number {
  if (typeof payload.layoutEditedAt === "number" && Number.isFinite(payload.layoutEditedAt)) return payload.layoutEditedAt;
  const pushed = pushedAt ? Date.parse(pushedAt) : Number.NaN;
  return Number.isFinite(pushed) ? pushed : Number.POSITIVE_INFINITY;
}

/**
 * Whether a pulled workspace replaces this device's, three ways: against the
 * copy this device last synced, the one it had when the pull started, and the
 * pulled one. Only a real edit here keeps the local copy; the pane state,
 * focus and window stacking that change on every launch never do.
 */
export function shouldAdoptPulledLayout({
  local,
  atPullStart,
  lastSynced,
  pulled,
  memo,
  pulledEditedAt,
}: {
  local: string | null;
  atPullStart: string | null;
  lastSynced: string | null;
  pulled: string | null;
  memo: LayoutMemo | null;
  pulledEditedAt: number;
}): boolean {
  if (pulled === null || pulled === local) return false;
  // Edited while the pull was in flight: newer than anything it carries.
  if (local !== atPullStart) return false;
  const takenFromCloud = !!memo?.synced && memo.intent === local;
  const editedHere = lastSynced !== null && local !== lastSynced && !takenFromCloud;
  if (!editedHere) return true;
  // The cloud still holds what this device last synced: only this side changed.
  if (pulled === lastSynced) return false;
  // Both sides changed since: the later edit wins, and an undated local one loses.
  const localEditedAt = memo?.intent === local ? memo.editedAt : null;
  return localEditedAt === null || localEditedAt <= pulledEditedAt;
}

/**
 * The workspace as the cloud already has it unless this device really edited
 * it, so what only reflects this device never replaces another device's copy,
 * and a real edit goes out dated.
 */
export function withLayoutProvenance(
  payload: Record<string, unknown>,
  lastSyncedPayload: unknown,
  memoValue: unknown,
): Record<string, unknown> {
  const local = layoutIntent(payload);
  if (local === null) return payload;
  const memo = readLayoutMemo(memoValue);
  if (memo?.synced && memo.intent === local) return { ...payload, ...memo.synced };
  if (isRecord(lastSyncedPayload) && layoutIntent(lastSyncedPayload) === local) {
    return { ...payload, ...pickLayoutPayload(lastSyncedPayload) };
  }
  return {
    ...payload,
    layoutEditedAt: memo?.intent === local && memo.editedAt !== null ? memo.editedAt : Date.now(),
  };
}

/**
 * Dates a workspace edit when it happens, online or not, so a later conflict
 * with another device's edit goes to the newer one.
 */
export function noteLayoutEdit(config: AppConfig, lastSyncedPayload: unknown, memoValue: unknown, launch: boolean): LayoutMemo | null {
  const lastSynced = layoutIntent(lastSyncedPayload);
  if (lastSynced === null) return null;
  const local = layoutIntent(collectLayoutPayload(config));
  if (local === null || local === lastSynced) return null;
  if (readLayoutMemo(memoValue)?.intent === local) return null;
  // Seen at launch, it was made while the app was closed or just before it
  // quit; when is unknown, so it gives way to a dated edit elsewhere.
  return { intent: local, editedAt: launch ? null : Date.now() };
}

/**
 * Once this device holds the cloud's workspace, by taking it or because the
 * two already matched, it remembers that copy as synced, keyed by how it
 * looks here once applied. The next push then sends the cloud's own copy back
 * rather than this device's rendering of it.
 */
export function rememberCloudLayout(
  payload: Record<string, unknown>,
  pushedAt: string | undefined,
  applied: AppConfig,
  memo: { get(): unknown; set(value: unknown): void },
  adopted: boolean,
): void {
  const local = layoutIntent(collectLayoutPayload(applied));
  if (local === null || (!adopted && local !== layoutIntent(payload))) return;
  const current = readLayoutMemo(memo.get());
  if (!adopted && current?.synced && current.intent === local) return;
  const editedAt = pulledLayoutEditedAt(payload, pushedAt);
  memo.set({
    intent: local,
    editedAt: Number.isFinite(editedAt) ? editedAt : null,
    synced: pickLayoutPayload(payload),
  } satisfies LayoutMemo);
}

export interface LayoutMergeContext {
  memo?: unknown;
  /** When the pulled copy was pushed, for one from a build that did not date layout edits. */
  pushedAt?: string;
}
