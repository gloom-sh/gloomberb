import { useEffect } from "react";
import type { DataTableKeyEvent } from "./view";
import type { PaneFooterSegment } from "../layout/pane/footer";
import { isPlainKey } from "../../utils/keyboard";

export function loadingErrorFooterInfo(loading: boolean, error: string | null | undefined): PaneFooterSegment[] {
  return [
    ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
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

export function useClampSelectedIndex(
  rowCount: number,
  selectedIdx: number,
  setSelectedIdx: (value: number) => void,
): void {
  useEffect(() => {
    if (rowCount > 0 && selectedIdx >= rowCount) setSelectedIdx(rowCount - 1);
  }, [rowCount, selectedIdx, setSelectedIdx]);
}
