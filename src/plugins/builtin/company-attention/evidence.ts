import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { fetchAppRank, fetchAttention, fetchBuilding, fetchMoves, fetchSignals, validateAttention, type AttentionPayload } from "./client";
import { isBuildingFilter } from "./building-model";
import { isMovesFilter } from "./moves-model";
import { isSignalGroup, isSignalsFilter } from "./signals-model";
import type { AttentionKind } from "./model";
import type { AppChart, AppRankPayload } from "../../../api-client/app-attention";

interface AttentionEvidence {
  kind: AttentionKind;
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  payload: AttentionPayload | AppRankPayload;
  tab: string;
  rowIds: string[];
}
export function useAttentionEvidence(kind: AttentionKind, payload: AttentionPayload | null, tab: string, rowIds: string[]) {
  useRemoteUiNode({ role: "chart-data", label: `Rendered ${kind} observations`, getMetadata: () => ({ kind, version: 1, complete: !!payload, ready: !!payload, plottedValueCount: rowIds.length, payload, tab, rowIds }) });
}
export function attentionScreenshotEvidence(kind: AttentionKind): PaneScreenshotEvidenceHook<AttentionEvidence> {
  return {
    paneId: kind, kind, label: kind,
    async prepare({ resolved }) {
      if (kind === "apps" && typeof resolved.options.appId === "string" && resolved.options.appId) {
        const payload = await fetchAppRank({ store: resolved.options.store === "google-play" ? "google-play" : "app-store", appId: resolved.options.appId, name: resolved.options.appId, country: String(resolved.options.country || "US"), chart: (resolved.options.chart || "free") as AppChart }, Number(resolved.options.days) || 90);
        return { settings: { appRankSnapshot: payload, appRankName: payload.rankHistory[0]?.name ?? payload.appId }, financials: [] };
      }
      const symbol = resolved.createOptions?.symbol ?? resolved.createOptions?.arg;
      const payload = await fetchAttention(kind, symbol, { country: typeof resolved.options.country === "string" ? resolved.options.country : undefined, chart: resolved.options.chart as "free" | "paid" | undefined, days: Number(resolved.options.days) || 90 });
      // HIRE's Moves tab reads its own payload.
      const moves = kind === "hiring" && resolved.options.tab === "moves"
        ? await fetchMoves(symbol, { filter: typeof resolved.options.moves === "string" && isMovesFilter(resolved.options.moves) ? resolved.options.moves : "moves" }) : null;
      // So do Expansion and Anomalies.
      const group = kind === "hiring" && typeof resolved.options.tab === "string" && isSignalGroup(resolved.options.tab) ? resolved.options.tab : null;
      const signalsKind = typeof resolved.options.kind === "string" ? resolved.options.kind : "all";
      const signals = group ? await fetchSignals(group, symbol, { filter: isSignalsFilter(group, signalsKind) ? signalsKind : "all" }) : null;
      // And Building.
      const dimension = typeof resolved.options.dimension === "string" && isBuildingFilter(resolved.options.dimension) ? resolved.options.dimension : "all";
      const building = kind === "hiring" && resolved.options.tab === "building" ? await fetchBuilding(symbol, { filter: dimension }) : null;
      return { settings: { attentionSnapshot: payload, ...(moves ? { movesSnapshot: moves } : {}), ...(group && signals ? { [`${group}Snapshot`]: signals } : {}), ...(building ? { buildingSnapshot: building } : {}) }, financials: symbol ? [[symbol, { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]] : [] };
    },
    read(value) {
      if (!isRecord(value) || value.kind !== kind || value.version !== 1 || value.complete !== true || !isRecord(value.payload)
        || !["table", "chart", "mix", "peers", "evidence", ...(kind === "hiring" ? ["moves", "expansion", "anomalies", "building"] : [])].includes(String(value.tab)) || !Array.isArray(value.rowIds) || !value.rowIds.every((id) => typeof id === "string") || value.plottedValueCount !== value.rowIds.length) return null;
      try { if (!(kind === "apps" && Array.isArray(value.payload.rankHistory))) validateAttention(kind, value.payload as unknown as AttentionPayload); return value as unknown as AttentionEvidence; } catch {
        // Intentional ignore: invalid captured observations are rejected as evidence by returning null.
        return null;
      }
    },
    mismatches(evidence, { resolved, payload }) {
      const settings = payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId)?.settings;
      const snapshot = settings?.appRankSnapshot ?? settings?.attentionSnapshot;
      return [...(JSON.stringify(snapshot) !== JSON.stringify(evidence.payload) ? ["Rendered observations differ from the captured evidence."] : []), ...(evidence.tab !== (resolved.options.tab ?? "table") ? ["Rendered tab differs from the requested tab."] : [])];
    },
    unavailable(evidence) { return evidence?.complete ? [] : [`${kind} observations`]; },
    symbols({ payload }) { return payload.financials.map(([symbol]) => symbol); },
  };
}
