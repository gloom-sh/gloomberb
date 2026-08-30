export type PaneTableExporter = (filename: string) => Promise<string>;

const exporters = new Map<string, Map<symbol, PaneTableExporter>>();

export function registerPaneTableExporter(
  paneId: string,
  exporter: PaneTableExporter,
): () => void {
  const token = Symbol(paneId);
  const paneExporters = exporters.get(paneId) ?? new Map<symbol, PaneTableExporter>();
  paneExporters.set(token, exporter);
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

export async function exportPaneTable(paneId: string, filename: string): Promise<string> {
  const paneExporters = exporters.get(paneId);
  if (paneExporters?.size !== 1) {
    throw new Error("This pane does not have one active exportable table.");
  }
  return [...paneExporters.values()][0]!(filename);
}
