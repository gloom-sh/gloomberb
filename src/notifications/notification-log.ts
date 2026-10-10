import type { AppNotificationRequest, AppNotificationType } from "../types/plugin";

export const NOTIFICATION_LOG_LIMIT = 300;
const IDENTICAL_BODY_DEDUPE_MS = 10 * 60 * 1000;

export interface NotificationLogEntry {
  id: string;
  title?: string;
  body: string;
  type: AppNotificationType;
  source: string;
  at: number;
  read: boolean;
  /** External key. The same refId updates that row instead of adding another. */
  refId?: string;
}

export interface NotificationLogStore {
  get(): readonly NotificationLogEntry[];
  set(entries: readonly NotificationLogEntry[]): void | Promise<void>;
}

let entries: NotificationLogEntry[] = [];
let store: NotificationLogStore | null = null;
let writeQueue = Promise.resolve();
const listeners = new Set<() => void>();

function normalizeEntry(value: unknown): NotificationLogEntry | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Partial<NotificationLogEntry>;
  if (typeof entry.id !== "string" || typeof entry.body !== "string" || typeof entry.at !== "number") return null;
  return {
    id: entry.id,
    ...(typeof entry.title === "string" && entry.title ? { title: entry.title } : {}),
    body: entry.body,
    type: entry.type === "success" || entry.type === "error" ? entry.type : "info",
    source: typeof entry.source === "string" && entry.source ? entry.source : "app",
    at: entry.at,
    read: entry.read === true,
    ...(typeof entry.refId === "string" && entry.refId ? { refId: entry.refId } : {}),
  };
}

function trim(next: readonly NotificationLogEntry[]): NotificationLogEntry[] {
  return next.slice(-NOTIFICATION_LOG_LIMIT);
}

function publish(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  if (!store) return;
  const snapshot = entries;
  const targetStore = store;
  writeQueue = writeQueue
    .then(() => targetStore.set(snapshot))
    .catch(() => {});
}

export function configureNotificationLog(nextStore: NotificationLogStore | null): void {
  store = nextStore;
  entries = trim((nextStore?.get() ?? []).map(normalizeEntry).filter((entry): entry is NotificationLogEntry => !!entry));
  publish();
}

export function subscribeNotificationLog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getNotificationLog(): readonly NotificationLogEntry[] {
  return entries;
}

export function appendNotificationLog(
  notification: AppNotificationRequest,
  source = "app",
  at = Date.now(),
): NotificationLogEntry {
  const entry: NotificationLogEntry = {
    id: `notification-${at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ...(notification.title?.trim() ? { title: notification.title.trim() } : {}),
    body: notification.body,
    type: notification.type ?? "info",
    source,
    at,
    read: notification.type === "success" && source === "app",
    ...(notification.refId ? { refId: notification.refId } : {}),
  };
  if (entry.refId) {
    const existingIndex = entries.findIndex((candidate) => candidate.refId === entry.refId);
    if (existingIndex >= 0) {
      const existing = entries[existingIndex]!;
      entries = trim([
        ...entries.slice(0, existingIndex),
        {
          ...existing,
          ...entry,
          id: existing.id,
          at: existing.at,
          read: entry.source === "alerts" ? false : existing.read,
          source: existing.source,
        },
        ...entries.slice(existingIndex + 1),
      ]);
      persist();
      publish();
      return existing;
    }
  } else {
    const duplicateIndex = entries.findIndex((candidate) => (
      candidate.body === entry.body
      && candidate.source === entry.source
      && at - candidate.at <= IDENTICAL_BODY_DEDUPE_MS
    ));
    if (duplicateIndex >= 0) {
      const existing = entries[duplicateIndex]!;
      persist();
      publish();
      return existing;
    }
  }
  entries = trim([...entries, entry]);
  persist();
  publish();
  return entry;
}

export function markNotificationLogRead(ids?: Iterable<string>): void {
  const selected = ids ? new Set(ids) : null;
  const next = entries.map((entry) => (
    (!selected || selected.has(entry.id)) && !entry.read ? { ...entry, read: true } : entry
  ));
  if (next.every((entry, index) => entry === entries[index])) return;
  entries = next;
  persist();
  publish();
}

export function markNotificationLogReadByRef(refIds: Iterable<string>): void {
  const wanted = new Set(refIds);
  if (wanted.size === 0) return;
  markNotificationLogRead(
    entries.filter((entry) => entry.refId && wanted.has(entry.refId)).map((entry) => entry.id),
  );
}

export function clearNotificationLog(): void {
  if (entries.length === 0) return;
  entries = [];
  persist();
  publish();
}

export async function flushNotificationLog(): Promise<void> {
  await writeQueue;
}

export function resetNotificationLogForTest(): void {
  entries = [];
  store = null;
  writeQueue = Promise.resolve();
  listeners.clear();
}
