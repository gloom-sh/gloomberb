import type { SupplyChainPayload } from "../../../api-client/supply-chain";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { fetchSupplyChain, validateSupplyChain } from "./client";

interface SupplyEvidence {
  kind: "supply-chain";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  payload: SupplyChainPayload;
  tab: string;
  view: string;
  rowIds: string[];
}
export function useSupplyEvidence(payload: SupplyChainPayload | null, tab: string, view: string, rowIds: string[]) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered supply chain disclosures", getMetadata: () => ({
    kind: "supply-chain", version: 1, complete: !!payload, ready: !!payload,
    plottedValueCount: rowIds.length, payload, tab, view, rowIds,
  }) });
}
export const supplyScreenshotEvidence: PaneScreenshotEvidenceHook<SupplyEvidence> = {
  paneId: "supply-chain", kind: "supply-chain", label: "supply chain",
  async prepare({ resolved }) {
    const symbol = resolved.createOptions?.symbol ?? resolved.createOptions?.arg;
    if (!symbol) throw new Error("A supply chain screenshot requires a ticker");
    const payload = await fetchSupplyChain(symbol);
    // A filing pane needs an identity, never fabricated prices or unrelated market requests.
    return { settings: { supplySnapshot: payload }, financials: [[payload.symbol, { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]] };
  },
  read(value) {
    if (!isRecord(value) || value.kind !== "supply-chain" || value.version !== 1 || !isRecord(value.payload)
      || !["table", "flow"].includes(String(value.tab)) || !["says", "names"].includes(String(value.view))
      || !Array.isArray(value.rowIds) || !value.rowIds.every((id) => typeof id === "string") || value.complete !== true) return null;
    try {
      const payload = validateSupplyChain(value.payload as unknown as SupplyChainPayload);
      const eligible = value.tab === "flow" ? [...payload.says, ...payload.names] : payload[value.view as "says" | "names"];
      if (value.plottedValueCount !== value.rowIds.length || value.rowIds.some((id) => !eligible.some((row) => row.id === id))) return null;
      return value as unknown as SupplyEvidence;
    } catch { return null; }
  },
  mismatches(evidence, { resolved, payload }) {
    const snapshot = payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId)?.settings?.supplySnapshot;
    const mismatches: string[] = [];
    if (JSON.stringify(evidence.payload) !== JSON.stringify(snapshot)) mismatches.push("Supply chain disclosures differ from the captured filing data");
    if (evidence.tab !== (resolved.options.tab ?? "table")) mismatches.push("Supply chain tab does not match");
    if (evidence.view !== (resolved.options.view ?? "says")) mismatches.push("Supply chain direction does not match");
    return mismatches;
  },
  unavailable(evidence) { return evidence?.complete ? [] : ["supply chain disclosures"]; },
  symbols({ payload }) { return payload.financials.map(([symbol]) => symbol); },
};
