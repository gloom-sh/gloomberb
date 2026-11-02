import { isUsableRect, type Rect } from "./geometry";

/**
 * The desktop app's windows as this machine keeps them, beside the config
 * and never synced: which layout tabs each extra window shows, and for each
 * monitor arrangement where every window sat. A laptop that docks to two
 * screens and undocks to its own has two arrangements, and each comes back
 * as it was left.
 */
export const MAIN_WINDOW_ID = "main";

export interface WindowPlacement {
  frame: Rect;
  maximized: boolean;
  fullscreen: boolean;
  /** The display the window was on (geometry.ts `displayKey`), when it was on one. */
  display?: string;
}

interface ArrangementSetup {
  /** When a window in this arrangement last moved; the oldest arrangements are dropped first. */
  savedAt: number;
  windows: Record<string, WindowPlacement>;
}

/** A window besides the main one: the layout tabs it shows, by saved layout id. The main window shows every other tab. */
export interface ExtraWindowRecord {
  id: string;
  layoutIds: string[];
  activeLayoutId?: string;
}

export interface ScreenSetup {
  version: 1;
  windows: ExtraWindowRecord[];
  arrangements: Record<string, ArrangementSetup>;
}

/** Arrangements kept: a home desk, an office, a projector or two. */
const MAX_ARRANGEMENTS = 12;
const MAX_EXTRA_WINDOWS = 16;

export function emptyScreenSetup(): ScreenSetup {
  return { version: 1, windows: [], arrangements: {} };
}

function parsePlacement(raw: unknown): WindowPlacement | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const frame = record.frame as Rect | undefined;
  if (!isUsableRect(frame)) return null;
  return {
    frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
    maximized: record.maximized === true,
    fullscreen: record.fullscreen === true,
    ...(typeof record.display === "string" && record.display ? { display: record.display } : {}),
  };
}

function parseWindowRecord(raw: unknown): ExtraWindowRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id || record.id === MAIN_WINDOW_ID) return null;
  const layoutIds = Array.isArray(record.layoutIds)
    ? [...new Set(record.layoutIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
    : [];
  return {
    id: record.id,
    layoutIds,
    ...(typeof record.activeLayoutId === "string" && record.activeLayoutId ? { activeLayoutId: record.activeLayoutId } : {}),
  };
}

/** Reads what was saved, keeping every part that is well formed. Anything else starts empty. */
export function parseScreenSetup(raw: unknown): ScreenSetup {
  if (!raw || typeof raw !== "object") return emptyScreenSetup();
  const record = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const windows = (Array.isArray(record.windows) ? record.windows : [])
    .map(parseWindowRecord)
    .filter((entry): entry is ExtraWindowRecord => {
      if (!entry || seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    })
    .slice(0, MAX_EXTRA_WINDOWS);
  const arrangements: Record<string, ArrangementSetup> = {};
  const rawArrangements = record.arrangements && typeof record.arrangements === "object"
    ? record.arrangements as Record<string, unknown>
    : {};
  for (const [key, value] of Object.entries(rawArrangements)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const placements: Record<string, WindowPlacement> = {};
    const rawWindows = entry.windows && typeof entry.windows === "object" ? entry.windows as Record<string, unknown> : {};
    for (const [windowId, placement] of Object.entries(rawWindows)) {
      const parsed = parsePlacement(placement);
      if (parsed) placements[windowId] = parsed;
    }
    if (Object.keys(placements).length === 0) continue;
    arrangements[key] = {
      savedAt: typeof entry.savedAt === "number" && Number.isFinite(entry.savedAt) ? entry.savedAt : 0,
      windows: placements,
    };
  }
  return withoutStrayPlacements({ version: 1, windows, arrangements: pruneArrangements(arrangements) });
}

function pruneArrangements(arrangements: Record<string, ArrangementSetup>): Record<string, ArrangementSetup> {
  const entries = Object.entries(arrangements);
  if (entries.length <= MAX_ARRANGEMENTS) return arrangements;
  return Object.fromEntries(
    entries.sort(([, a], [, b]) => b.savedAt - a.savedAt).slice(0, MAX_ARRANGEMENTS),
  );
}

export function placementFor(setup: ScreenSetup, arrangement: string, windowId: string): WindowPlacement | null {
  return setup.arrangements[arrangement]?.windows[windowId] ?? null;
}

/**
 * Where a window last sat under any other arrangement, for screens the setup
 * has not seen: the most recently saved arrangement that has it.
 */
export function latestPlacementFor(setup: ScreenSetup, windowId: string, except: string): WindowPlacement | null {
  let latest: { savedAt: number; placement: WindowPlacement } | null = null;
  for (const [key, entry] of Object.entries(setup.arrangements)) {
    const placement = entry.windows[windowId];
    if (key === except || !placement) continue;
    if (!latest || entry.savedAt > latest.savedAt) latest = { savedAt: entry.savedAt, placement };
  }
  return latest?.placement ?? null;
}

export function hasArrangement(setup: ScreenSetup, arrangement: string): boolean {
  return !!setup.arrangements[arrangement];
}

function samePlacement(a: WindowPlacement | null, b: WindowPlacement): boolean {
  return !!a
    && a.frame.x === b.frame.x
    && a.frame.y === b.frame.y
    && a.frame.width === b.frame.width
    && a.frame.height === b.frame.height
    && a.maximized === b.maximized
    && a.fullscreen === b.fullscreen
    && a.display === b.display;
}

/** Records where a window is in this arrangement. Returns the same object when nothing changed. */
export function rememberPlacement(
  setup: ScreenSetup,
  arrangement: string,
  windowId: string,
  placement: WindowPlacement,
  now: number,
): ScreenSetup {
  const current = setup.arrangements[arrangement];
  if (samePlacement(current?.windows[windowId] ?? null, placement)) return setup;
  return {
    ...setup,
    arrangements: pruneArrangements({
      ...setup.arrangements,
      [arrangement]: {
        savedAt: now,
        windows: { ...current?.windows, [windowId]: placement },
      },
    }),
  };
}

/** A window that closed for good: its tabs went back to the main window, and no arrangement opens it again. */
export function forgetWindow(setup: ScreenSetup, windowId: string): ScreenSetup {
  if (windowId === MAIN_WINDOW_ID) return setup;
  const arrangements: Record<string, ArrangementSetup> = {};
  for (const [key, entry] of Object.entries(setup.arrangements)) {
    const { [windowId]: _removed, ...rest } = entry.windows;
    if (Object.keys(rest).length > 0) arrangements[key] = { ...entry, windows: rest };
  }
  return {
    ...setup,
    windows: setup.windows.filter((entry) => entry.id !== windowId),
    arrangements,
  };
}

/**
 * Puts back a window `forgetWindow` took out: its tab list and its
 * placements, as `before` had them. Placements saved since stay.
 */
export function restoreWindow(setup: ScreenSetup, before: ScreenSetup, windowId: string): ScreenSetup {
  const record = before.windows.find((entry) => entry.id === windowId);
  if (!record) return setup;
  const arrangements = { ...setup.arrangements };
  for (const [key, entry] of Object.entries(before.arrangements)) {
    const placement = entry.windows[windowId];
    if (!placement) continue;
    const current = arrangements[key] ?? { ...entry, windows: {} };
    if (current.windows[windowId]) continue;
    arrangements[key] = { ...current, windows: { ...current.windows, [windowId]: placement } };
  }
  return {
    ...setup,
    windows: setup.windows.some((entry) => entry.id === windowId) ? setup.windows : [...setup.windows, record],
    arrangements,
  };
}

/**
 * Only the placements of windows that can open: the main window and the
 * extra windows listed. One whose tabs are gone was not restored, and its
 * placements would stay for good.
 */
function withoutStrayPlacements(setup: ScreenSetup): ScreenSetup {
  const kept = new Set([MAIN_WINDOW_ID, ...setup.windows.map((entry) => entry.id)]);
  let changed = false;
  const arrangements: Record<string, ArrangementSetup> = {};
  for (const [key, entry] of Object.entries(setup.arrangements)) {
    const windows = Object.fromEntries(Object.entries(entry.windows).filter(([windowId]) => kept.has(windowId)));
    const count = Object.keys(windows).length;
    if (count === Object.keys(entry.windows).length) arrangements[key] = entry;
    else {
      changed = true;
      if (count > 0) arrangements[key] = { ...entry, windows };
    }
  }
  return changed ? { ...setup, arrangements } : setup;
}

/** Replaces the extra windows' tab lists, as the workspace has them now; a window no longer listed loses its placements. */
export function withExtraWindows(setup: ScreenSetup, windows: readonly ExtraWindowRecord[]): ScreenSetup {
  const next = windows.slice(0, MAX_EXTRA_WINDOWS).map((entry) => ({
    id: entry.id,
    layoutIds: [...entry.layoutIds],
    ...(entry.activeLayoutId ? { activeLayoutId: entry.activeLayoutId } : {}),
  }));
  return withoutStrayPlacements(JSON.stringify(next) === JSON.stringify(setup.windows) ? setup : { ...setup, windows: next });
}

let windowSeq = 0;

/** A new extra window's id: unique on this machine, and never `main`. */
export function createExtraWindowId(now = Date.now()): string {
  windowSeq += 1;
  return `window:${now.toString(36)}${windowSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
