/**
 * EXTENSION POINT for the "Connect an AI assistant" dialog.
 *
 * The dialog sets up a client. Anything that reports on clients already
 * connected registers a section here and the dialog renders it under the key
 * row, in `order`, separated by a divider. The terminal control work ("Allow
 * it to control this terminal": which assistants are connected or approved,
 * and revoking one) plugs in here rather than growing the dialog itself.
 *
 * A section renders inside the dialog, so it gets the content width and the
 * dialog's keyboard scope; keys it binds must not clash with the dialog's own
 * (`c`, `k`, Left/Right, Enter, Esc).
 */
import { useSyncExternalStore, type ComponentType } from "react";

export interface McpConnectSectionProps {
  /** Content width in cells. */
  width: number;
  /** The dialog's keyboard scope, for `useDialogKeyboard`. */
  dialogId?: string;
}

export interface McpConnectSection {
  id: string;
  /** Lower first. */
  order?: number;
  Component: ComponentType<McpConnectSectionProps>;
}

const sections = new Map<string, McpConnectSection>();
const listeners = new Set<() => void>();
let snapshot: readonly McpConnectSection[] = [];

function publish(): void {
  snapshot = [...sections.values()].sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  for (const listener of listeners) listener();
}

/** Adds a section to the dialog; the returned function removes it. A second registration with the same id replaces the first. */
export function registerMcpConnectSection(section: McpConnectSection): () => void {
  sections.set(section.id, section);
  publish();
  return () => {
    if (sections.get(section.id) !== section) return;
    sections.delete(section.id);
    publish();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The registered sections, in order; follows registrations made while the dialog is open. */
export function useMcpConnectSections(): readonly McpConnectSection[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
