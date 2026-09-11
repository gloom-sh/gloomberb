import { useEffect } from "react";
// Deep imports on purpose: the components barrel re-exports this module for
// plugins, and importing the barrel back would make a cycle.
import type { DataTableKeyEvent } from "../../../components/data-table/view";
import type { PaneFooterSegment } from "../../../components/layout/pane/footer";

export function loadingErrorFooterInfo(loading: boolean, error: string | null | undefined): PaneFooterSegment[] {
  return [
    ...(loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
    ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
  ];
}

export function handleRefreshKey(event: DataTableKeyEvent, reload: () => void, options: { stopPropagation?: boolean } = {}): boolean {
  if (event.name !== "r") return false;
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
