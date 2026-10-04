import type { CatalystResponse } from "../../../api-client/catalysts";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { fetchCatalystDetail, fetchCatalysts, validateCatalysts } from "./client";
import { catalystQuery } from "./model";

interface CatalystEvidence {
  kind: "catalysts"; version: 1; complete: boolean; plottedValueCount: number;
  payload: CatalystResponse; tab: string; openId: string | null; rowIds: string[];
}
export function useCatalystEvidence(payload: CatalystResponse | null, tab: string, openId: string | null, rowIds: string[]) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered catalyst events", getMetadata: () => ({ kind: "catalysts", version: 1, ready: !!payload,
    complete: !!payload, plottedValueCount: rowIds.length, payload, tab, openId, rowIds }) });
}
function screenshotEvidence(paneId: string): PaneScreenshotEvidenceHook<CatalystEvidence> {
  return {
    paneId, kind: "catalysts", label: "catalyst events",
    async prepare({ resolved }) {
      const symbol = resolved.createOptions?.symbol ?? resolved.createOptions?.arg;
      const query = catalystQuery(resolved.options, symbol, paneId === "litigation");
      const payload = await fetchCatalysts({ ...query, limit: 100 });
      const openId = typeof resolved.options.event === "string" ? resolved.options.event : null;
      const detail = openId ? await fetchCatalystDetail(openId) : null;
      if (detail && !payload.events.some((event) => event.id === openId)) payload.events = [detail.event, ...payload.events];
      return { settings: { catalystSnapshot: payload, filters: resolved.options, ...(openId && detail ? { open: openId, catalystDetails: { [openId]: detail } } : {}) },
        financials: symbol ? [[symbol, { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]] : [] };
    },
    read(value) {
      if (!isRecord(value) || value.kind !== "catalysts" || value.version !== 1 || !isRecord(value.payload) || value.complete !== true || !Array.isArray(value.rowIds)) return null;
      try {
        const payload = validateCatalysts(value.payload as unknown as CatalystResponse);
        if (value.rowIds.some((id) => !payload.events.some((event) => event.id === id)) || value.plottedValueCount !== value.rowIds.length) return null;
        return value as unknown as CatalystEvidence;
      } catch { return null; }
    },
    mismatches(evidence, { resolved, payload }) {
      const snapshot = payload.config.layout.instances.find((pane) => pane.instanceId === payload.paneId)?.settings?.catalystSnapshot;
      return [JSON.stringify(evidence.payload) !== JSON.stringify(snapshot) ? "Catalyst rows differ from captured source records" : null,
        evidence.tab !== (resolved.options.tab ?? "calendar") ? "Catalyst tab does not match" : null].filter((message): message is string => !!message);
    },
    unavailable(evidence) { return evidence?.complete ? [] : ["catalyst events"]; },
    symbols({ payload }) { return payload.financials.map(([symbol]) => symbol); },
  };
}
export const catalystsScreenshotEvidence = screenshotEvidence("catalysts");
export const litigationScreenshotEvidence = screenshotEvidence("litigation");
