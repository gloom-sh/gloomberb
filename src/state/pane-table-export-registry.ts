import { createCsvExportFilename } from "../utils/csv";

export type PaneTableExporter = (filename: string) => Promise<string>;

interface RegisteredExporter {
  exporter: PaneTableExporter;
  /** What the table is of, which names the file: a watchlist's name, not the pane's ("Portfolio"). */
  name?: () => string | null | undefined;
}

const exporters = new Map<string, Map<symbol, RegisteredExporter>>();

export function registerPaneTableExporter(
  paneId: string,
  exporter: PaneTableExporter,
  name?: () => string | null | undefined,
): () => void {
  const token = Symbol(paneId);
  const paneExporters = exporters.get(paneId) ?? new Map<symbol, RegisteredExporter>();
  paneExporters.set(token, { exporter, ...name ? { name } : {} });
  exporters.set(paneId, paneExporters);

  return () => {
    const current = exporters.get(paneId);
    current?.delete(token);
    if (current?.size === 0) exporters.delete(paneId);
  };
}

export function hasPaneTableExporter(paneId: string): boolean {
  return exporters.get(paneId)?.size === 1;
}

function activeExporter(paneId: string): RegisteredExporter {
  const paneExporters = exporters.get(paneId);
  if (paneExporters?.size !== 1) {
    throw new Error("This pane does not have one active exportable table.");
  }
  return [...paneExporters.values()][0]!;
}

export async function exportPaneTable(paneId: string, filename: string): Promise<string> {
  return activeExporter(paneId).exporter(filename);
}

/**
 * Shared entry point for the pane menu, the keyboard shortcut, and pane settings so
 * every surface produces the same filename and the same success/failure notification.
 */
export async function exportPaneTableCsv(
  paneId: string,
  title: string,
  notify: (notification: { body: string; type: "success" | "error" }) => void,
): Promise<void> {
  try {
    // The file is named after what the table is of when it says (the watchlist shown), else the pane.
    const named = exporters.get(paneId)?.size === 1 ? activeExporter(paneId).name?.()?.trim() : null;
    const location = await exportPaneTable(paneId, createCsvExportFilename(named || title));
    notify({ body: `Exported to ${location}`, type: "success" });
  } catch {
    notify({ body: "Failed to export CSV", type: "error" });
  }
}
