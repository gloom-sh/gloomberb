import type { AwardFilter, AwardsPayload } from "../../../api-client/awards";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { fetchAwards, validateAwards } from "./client";
import { awardTab, type AwardTab } from "./model";

interface AwardsEvidence { kind: "government-awards"; version: 1; complete: boolean; plottedValueCount: number; payload: AwardsPayload; tab: AwardTab }
export function useAwardsEvidence(payload: AwardsPayload | undefined, tab: AwardTab, plottedValueCount: number) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered government awards", getMetadata: () => ({ kind: "government-awards", version: 1,
    complete: !!payload, ready: !!payload, plottedValueCount, payload, tab }) });
}
export const awardsScreenshotEvidence: PaneScreenshotEvidenceHook<AwardsEvidence> = {
  paneId: "awards", kind: "government-awards", label: "government awards",
  async prepare({ resolved }) {
    const ticker = (resolved.createOptions?.symbol ?? resolved.createOptions?.arg)?.trim().toUpperCase();
    const query: AwardFilter = { ticker: ticker || undefined, awardType: (resolved.options.type as AwardFilter["awardType"]) ?? "prime", limit: 100 };
    for (const key of ["jurisdiction", "currency", "source", "agency", "sector", "parentId", "from", "to", "query"] as const) {
      if (resolved.options[key]) query[key] = String(resolved.options[key]);
    }
    const payload = await fetchAwards(query);
    return { settings: { awardsSnapshot: payload }, financials: ticker ? [[ticker, { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]] : [] };
  },
  read(value) {
    if (!isRecord(value) || value.kind !== "government-awards" || value.version !== 1 || value.complete !== true || !Number.isSafeInteger(value.plottedValueCount)
      || Number(value.plottedValueCount) < 0 || awardTab(value.tab) !== value.tab || !isRecord(value.payload)) return null;
    try { validateAwards(value.payload as unknown as AwardsPayload); return value as unknown as AwardsEvidence; } catch { return null; }
  },
  mismatches(evidence, { resolved, payload }) {
    const snapshot = payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId)?.settings?.awardsSnapshot;
    return [...(JSON.stringify(evidence.payload) !== JSON.stringify(snapshot) ? ["Award records differ from the captured source data"] : []),
      ...(evidence.tab !== awardTab(resolved.options.tab) ? ["Award tab differs from the request"] : [])];
  },
  unavailable(evidence) { return evidence?.complete ? [] : ["government awards"]; },
  symbols({ payload }) { return payload.financials.map(([symbol]) => symbol); },
};
