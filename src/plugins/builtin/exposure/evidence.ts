import type { ExposurePayload } from "../../../api-client/exposure";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { validateExposure } from "./client";
import { pathRows, portfolioRows, tableRows } from "./model";
import { driverRows } from "./drivers";

interface ExposureCapture { kind: "exposure"; version: 1; complete: boolean; plottedValueCount: number; payload: ExposurePayload; tab: string; view: string; rowIds: string[]; }
export function useExposureEvidence(payload: ExposurePayload | null, tab: string, view: string, rowIds: string[]) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered exposure analysis", getMetadata: () => ({ kind: "exposure", version: 1, complete: !!payload, ready: !!payload, payload, tab, view, rowIds, plottedValueCount: rowIds.length }) });
}
export const exposureScreenshotEvidence: PaneScreenshotEvidenceHook<ExposureCapture> = {
  paneId: "exposure", kind: "exposure", label: "exposure",
  async prepare({ loadModel }) {
    const model = await loadModel();
    const result = model.result;
    if (!("metadata" in result) || !isRecord(result.metadata)) throw new Error("Exposure screenshot needs its analyzed payload.");
    const payload = validateExposure(result.metadata.payload as ExposurePayload);
    return { settings: { exposureSnapshot: payload }, financials: payload.holdings.map(h => [h.symbol, { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]) };
  },
  read(metadata) {
    if (!isRecord(metadata) || metadata.kind !== "exposure" || metadata.version !== 1 || metadata.complete !== true || !["table", "drivers", "paths", "portfolio"].includes(String(metadata.tab)) || !Array.isArray(metadata.rowIds)) return null;
    try {
      const payload = validateExposure(metadata.payload as ExposurePayload);
      const rows = metadata.tab === "drivers" ? driverRows(payload) : metadata.tab === "paths" ? pathRows(payload) : metadata.tab === "portfolio" ? portfolioRows(payload, String(metadata.view)) : tableRows(payload);
      if (metadata.plottedValueCount !== rows.length || metadata.rowIds.length !== rows.length || metadata.rowIds.some(id => !rows.some(r => r.id === id))) return null;
      return metadata as unknown as ExposureCapture;
    } catch { return null; }
  },
  mismatches(evidence, { resolved, payload }) {
    const snapshot = payload.config.layout.instances.find(i => i.instanceId === payload.paneId)?.settings?.exposureSnapshot;
    return [...(JSON.stringify(evidence.payload) !== JSON.stringify(snapshot) ? ["Exposure output differs from the captured analysis"] : []),
      ...(evidence.tab !== (resolved.options.tab ?? "table") ? ["Exposure tab does not match"] : []),
      ...(evidence.view !== (resolved.options.view ?? "stress") ? ["Exposure concentration view does not match"] : [])];
  },
  unavailable: evidence => evidence?.complete ? [] : ["exposure analysis"],
  symbols: ({ payload }) => payload.financials.map(([symbol]) => symbol),
};
