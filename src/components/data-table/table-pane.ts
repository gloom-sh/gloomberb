import { useEffect } from "react";
import type { DataTableKeyEvent } from "./view";
import type { PaneFooterSegment } from "../layout/pane/footer";
import { useShortcut } from "../../react/input";
import { isPlainKey } from "../../utils/keyboard";

export function loadingErrorFooterInfo(loading: boolean, error: string | null | undefined): PaneFooterSegment[] {
  const message = error?.trim() ?? "";
  return [
    ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    ...(message ? [{ id: "error", parts: [{ text: message, tone: "warning" as const }] }] : []),
  ];
}

export function handleRefreshKey(event: DataTableKeyEvent, reload: () => void, options: { stopPropagation?: boolean } = {}): boolean {
  // A modified r (Shift+R refresh all, CmdOrCtrl+Shift+R resize) belongs to the app.
  if (!isPlainKey(event, "r")) return false;
  event.preventDefault?.();
  if (options.stopPropagation) event.stopPropagation?.();
  reload();
  return true;
}

/**
 * Plain `r` reloads the focused pane in every state, including a failed load
 * that mounts no table. It has no footer hint (see status-footer.ts), and a
 * key something inside the pane already used is left alone.
 */
export function usePaneRefreshKey(
  reload: () => void,
  { focused, enabled = true }: { focused: boolean; enabled?: boolean },
): void {
  useShortcut((event) => {
    if (!event.defaultPrevented) handleRefreshKey(event, reload, { stopPropagation: true });
  }, { enabled: focused && enabled });
}

export function useClampSelectedIndex(
  rowCount: number,
  selectedIdx: number,
  setSelectedIdx: (value: number) => void,
): void {
  useEffect(() => {
    if (rowCount > 0 && selectedIdx >= rowCount) setSelectedIdx(rowCount - 1);
  }, [rowCount, selectedIdx, setSelectedIdx]);
}
