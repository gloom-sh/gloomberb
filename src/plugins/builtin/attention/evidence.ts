import type { AttentionPayload } from "../../../api-client/attention";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { validateAttention } from "./client";
import { attentionTab, attentionWindow } from "./model";
interface AttentionEvidence {
  kind: "attention"; version: 1; complete: boolean; plottedValueCount: number;
  payload: AttentionPayload; tab: string; selectedSymbol: string;
}
export function useAttentionEvidence(payload: AttentionPayload | null, tab: string, selectedSymbol: string, plottedValueCount: number) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered research attention", getMetadata: () => ({
    kind: "attention", version: 1, complete: !!payload, ready: !!payload, plottedValueCount, payload, tab, selectedSymbol,
  }) });
}
export const attentionScreenshotEvidence: PaneScreenshotEvidenceHook<AttentionEvidence> = {
  paneId: "attention", kind: "attention", label: "research attention",
  read(value) {
    if (!isRecord(value) || value.kind !== "attention" || value.version !== 1 || value.complete !== true
      || !isRecord(value.payload) || attentionTab(value.tab) !== value.tab || typeof value.selectedSymbol !== "string"
      || !Number.isInteger(value.plottedValueCount) || Number(value.plottedValueCount) < 0) return null;
    try { validateAttention(value.payload as unknown as AttentionPayload); return value as unknown as AttentionEvidence; } catch { return null; }
  },
  mismatches(evidence, { resolved }) {
    return [evidence.payload.window !== attentionWindow(resolved.options.window) ? "Attention window does not match" : null,
      evidence.tab !== attentionTab(resolved.options.tab) ? "Attention tab does not match" : null].filter((value): value is string => !!value);
  },
  unavailable(evidence) { return evidence?.complete ? [] : ["research attention"]; },
  symbols() { return []; },
};
