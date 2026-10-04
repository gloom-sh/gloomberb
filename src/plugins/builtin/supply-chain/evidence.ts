import type { SupplyChainPayload, SupplyTierFilter } from "../../../api-client/supply-chain";
import type { GraphPayload } from "../../../api-client/supply-chain-graph";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { fetchSupplyChain, validateSupplyChain } from "./client";
import { isUnconfirmed, matchesSupplyOptions, supplyOptions } from "./trust";
import { fetchSupplyGraph, graphOptions, validateGraph } from "./graph-client";

type SupplyTab = "table" | "flow" | "graph" | "path";
interface SupplyEvidence {
  kind: "supply-chain";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  payload: SupplyChainPayload | GraphPayload;
  tab: SupplyTab;
  view?: string;
  rowIds: string[];
  evidenceOpen?: boolean;
  evidenceId?: string | null;
  tiers?: SupplyTierFilter[];
}
const graphTab = (tab: unknown) => tab === "graph" || tab === "path";
export function useSupplyEvidence(payload: SupplyChainPayload | null, tab: string, view: string, rowIds: string[], evidenceId: string | null = null, tiers: SupplyTierFilter[] = supplyOptions().tiers) {
  useRemoteUiNode(graphTab(tab) ? null : { role: "chart-data", label: "Rendered supply chain disclosures", getMetadata: () => ({
    kind: "supply-chain", version: 1, complete: !!payload, ready: !!payload,
    plottedValueCount: rowIds.length, payload, tab, view, rowIds, evidenceOpen: !!evidenceId, evidenceId, tiers,
  }) });
}
export const supplyScreenshotEvidence: PaneScreenshotEvidenceHook<SupplyEvidence> = {
  paneId: "supply-chain", kind: "supply-chain", label: "supply chain",
  async prepare({ resolved }) {
    const symbol = resolved.createOptions?.symbol ?? resolved.createOptions?.arg;
    if (!symbol) throw new Error("A supply chain screenshot requires a ticker");
    // A filing pane needs an identity, never fabricated prices or unrelated market requests.
    if (graphTab(resolved.options.tab)) {
      const target = String(resolved.options.to ?? "").trim();
      if (resolved.options.tab === "path" && !target) throw new Error("Path requires a target company: --to TICKER");
      const payload = await fetchSupplyGraph(symbol, graphOptions(resolved.options), target);
      return { settings: { graphSnapshot: payload }, financials: [[payload.symbol, { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]] };
    }
    const payload = await fetchSupplyChain(symbol, undefined, supplyOptions(resolved.options.tiers));
    return { settings: { supplySnapshot: payload }, financials: [[payload.symbol, { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]] };
  },
  read(value) {
    if (!isRecord(value) || value.kind !== "supply-chain" || value.version !== 1 || !isRecord(value.payload)
      || !["table", "flow", "graph", "path"].includes(String(value.tab))
      || !Array.isArray(value.rowIds) || !value.rowIds.every((id) => typeof id === "string") || value.complete !== true
      || value.evidenceOpen !== undefined && typeof value.evidenceOpen !== "boolean"
      || value.plottedValueCount !== value.rowIds.length || new Set(value.rowIds).size !== value.rowIds.length) return null;
    try {
      if (graphTab(value.tab)) {
        const payload = validateGraph(value.payload as unknown as GraphPayload);
        const eligible = new Set((value.tab === "graph" ? payload.links : payload.paths).map(row => row.id));
        if (value.rowIds.some(id => !eligible.has(id))) return null;
        const paths = [...payload.paths, ...[...payload.upstream, ...payload.downstream, ...payload.related].flatMap(row => [row.bestPath, row.shortestPath])];
        if (value.evidenceOpen && !paths.some(path => path.id === value.evidenceId)) return null;
      } else {
        if (!["says", "names"].includes(String(value.view))) return null;
        const payload = validateSupplyChain(value.payload as unknown as SupplyChainPayload);
        const options = supplyOptions(value.tiers);
        const eligible = (value.tab === "flow" ? [...payload.says, ...payload.names].filter(row => !isUnconfirmed(row)) : payload[value.view as "says" | "names"])
          .filter(row => matchesSupplyOptions(row, options));
        if (value.rowIds.some(id => !eligible.some(row => row.id === id))) return null;
        if ((value.evidenceOpen || value.evidenceId != null) && !eligible.some(row => row.id === value.evidenceId)) return null;
        // Return the validated payload: restricted quotes and glosses have been removed.
        return { ...value, payload } as unknown as SupplyEvidence;
      }
      return value as unknown as SupplyEvidence;
    } catch { return null; }
  },
  mismatches(evidence, { resolved, payload }) {
    const settings = payload.config.layout.instances.find(entry => entry.instanceId === payload.paneId)?.settings;
    const snapshot = settings?.[graphTab(evidence.tab) ? "graphSnapshot" : "supplySnapshot"];
    const mismatches: string[] = [];
    if (JSON.stringify(evidence.payload) !== JSON.stringify(snapshot)) mismatches.push("Supply chain disclosures differ from the captured filing data");
    if (resolved.options.evidence === true && (!evidence.evidenceOpen || !evidence.evidenceId)) mismatches.push("Supply chain evidence detail was not opened");
    if (evidence.tab !== (resolved.options.tab ?? "table")) mismatches.push("Supply chain tab does not match");
    if (!graphTab(evidence.tab)) {
      if (evidence.view !== (resolved.options.view ?? "says")) mismatches.push("Supply chain direction does not match");
      if (JSON.stringify(evidence.tiers) !== JSON.stringify(supplyOptions(resolved.options.tiers).tiers)) mismatches.push("Supply chain evidence tiers do not match");
    }
    return mismatches;
  },
  unavailable(evidence) { return evidence?.complete ? [] : ["supply chain disclosures"]; },
  symbols({ payload }) { return payload.financials.map(([symbol]) => symbol); },
};
