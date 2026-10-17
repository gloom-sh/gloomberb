import { logFailure } from "../utils/log-failure";
import type { AppPluginStateStorePort } from "../core/app-service-ports";
import type { AppNotificationRequest } from "../types/plugin";

export const NOTIFICATION_LOG_LIMIT = 300;

/**
 * The notices worth finding again after their toast is gone: a price alert or
 * a catalyst that fired, and a team card. Chat keeps its own unread state on
 * the account, and plain info, success and error toasts are not logged.
 */
export type MissedNoticeKind = "price" | "catalyst" | "team";

const KIND_PREFIXES: ReadonlyArray<readonly [MissedNoticeKind, string]> = [
  ["price", "price:"],
  ["catalyst", "catalyst:"],
  ["team", "team:"],
];

export interface NotificationLogEntry {
  id: string;
  /** `price:<alertId>`, `catalyst:<eventId>` or `team:<cardId>`. A later notice with the same ref updates this row. */
  refId: string;
  title?: string;
  body: string;
  at: number;
  read: boolean;
}

interface NotificationLogStore {
  get(): readonly unknown[];
  set(entries: readonly NotificationLogEntry[]): void;
}

/** What a ref points at, and the id inside it; null for anything the log does not keep. */
export function parseNoticeRef(refId: string | undefined): { kind: MissedNoticeKind; id: string } | null {
  if (!refId) return null;
  for (const [kind, prefix] of KIND_PREFIXES) {
    if (refId.startsWith(prefix) && refId.length > prefix.length) return { kind, id: refId.slice(prefix.length) };
  }
  return null;
}

let entries: NotificationLogEntry[] = [];
let store: NotificationLogStore | null = null;
const listeners = new Set<() => void>();

function normalizeEntry(value: unknown): NotificationLogEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<NotificationLogEntry>;
  if (typeof entry.id !== "string" || typeof entry.body !== "string" || typeof entry.at !== "number") return null;
  if (typeof entry.refId !== "string" || !parseNoticeRef(entry.refId)) return null;
  return {
    id: entry.id,
    refId: entry.refId,
    ...(typeof entry.title === "string" && entry.title ? { title: entry.title } : {}),
    body: entry.body,
    at: entry.at,
    read: entry.read === true,
  };
}

/** One row per ref, oldest first, the newest {@link NOTIFICATION_LOG_LIMIT} kept. */
function settle(next: readonly NotificationLogEntry[]): NotificationLogEntry[] {
  const byRef = new Map<string, NotificationLogEntry>();
  for (const entry of next) {
    byRef.delete(entry.refId);
    byRef.set(entry.refId, entry);
  }
  return [...byRef.values()].sort((left, right) => left.at - right.at).slice(-NOTIFICATION_LOG_LIMIT);
}

function commit(next: NotificationLogEntry[]): void {
  entries = next;
  try {
    store?.set(entries);
  } catch (error) {
    logFailure("notifications.notification-log", "Saving notification history failed")(error);
  }
  for (const listener of listeners) listener();
}

/**
 * Loads the log from a device-local store. Notices recorded before the store
 * was attached are kept, so a fire during startup is not lost.
 */
function configureNotificationLog(nextStore: NotificationLogStore | null): void {
  store = nextStore;
  let saved: readonly unknown[] = [];
  try {
    saved = nextStore?.get() ?? [];
  } catch {
    saved = [];
  }
  const loaded = saved.map(normalizeEntry).filter((entry): entry is NotificationLogEntry => !!entry);
  commit(settle([...loaded, ...entries]));
}

const LOG_STATE_OWNER = "core.notifications";
const LOG_STATE_KEY = "missed";

/**
 * Keeps the log in the app's local state store (SQLite in the terminal and the
 * desktop app, browser storage on the web), never in config.json or synced
 * settings, so team text in a notice stays on this device. Returns the detach.
 */
export function attachNotificationLog(pluginState: Pick<AppPluginStateStorePort, "get" | "set">): () => void {
  configureNotificationLog({
    get: () => {
      const value = pluginState.get<unknown>(LOG_STATE_OWNER, LOG_STATE_KEY)?.value;
      return Array.isArray(value) ? value : [];
    },
    set: (next) => pluginState.set(LOG_STATE_OWNER, LOG_STATE_KEY, next),
  });
  return () => configureNotificationLog(null);
}

export function subscribeNotificationLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getNotificationLog(): readonly NotificationLogEntry[] {
  return entries;
}

export function unreadNotificationLogCount(log: readonly NotificationLogEntry[] = entries): number {
  let count = 0;
  for (const entry of log) if (!entry.read) count += 1;
  return count;
}

/**
 * Records a notice whose `refId` names a price alert, a catalyst or a team
 * card; anything else returns null and is not kept. The same ref replaces its
 * row: a price alert that fires again is new and unread again.
 */
export function appendNotificationLog(
  notification: Pick<AppNotificationRequest, "title" | "body" | "refId">,
  at = Date.now(),
): NotificationLogEntry | null {
  const refId = notification.refId;
  if (!refId || !parseNoticeRef(refId)) return null;
  const existing = entries.find((candidate) => candidate.refId === refId);
  const title = notification.title?.trim();
  const entry: NotificationLogEntry = {
    id: existing?.id ?? `notice-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    refId,
    ...(title ? { title } : {}),
    body: notification.body,
    at,
    read: false,
  };
  commit(settle([...entries, entry]));
  return entry;
}

export function markNotificationLogRead(ids?: Iterable<string>): void {
  const selected = ids ? new Set(ids) : null;
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.read || (selected && !selected.has(entry.id))) return entry;
    changed = true;
    return { ...entry, read: true };
  });
  if (changed) commit(next);
}

export function markNotificationLogReadByRef(refIds: Iterable<string>): void {
  const wanted = new Set(refIds);
  if (wanted.size === 0) return;
  markNotificationLogRead(entries.filter((entry) => wanted.has(entry.refId)).map((entry) => entry.id));
}

export function resetNotificationLogForTest(): void {
  entries = [];
  store = null;
  listeners.clear();
}
