import { apiClient } from "../../../api-client";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { isRecord } from "../../../utils/guards";
import { resolveIssuerListing } from "../shared/headless-market-data";
import { companyQuery, fetchCompanyData, validateCompanyData, type CompanyDataset, type CompanyMode } from "./client";
import { allGuidance, allObservations } from "./model";

interface Evidence { kind: "company-disclosures"; version: 1; complete: boolean; plottedValueCount: number; payload: CompanyDataset; mode: CompanyMode; tab: string; rowIds: string[]; }
export function useCompanyEvidence(payload: CompanyDataset | null, mode: CompanyMode, tab: string, rowIds: string[]) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered company disclosures", getMetadata: () => ({
    kind: "company-disclosures", version: 1, complete: !!payload, ready: !!payload, plottedValueCount: rowIds.length, payload, mode, tab, rowIds,
  }) });
}
function screenshotEvidence(mode: CompanyMode): PaneScreenshotEvidenceHook<Evidence> {
  return {
    paneId: mode === "kpis" ? "company-kpis" : "company-guidance", kind: "company-disclosures", label: "company disclosures",
    async prepare({ resolved, context }) {
      const symbol = resolved.createOptions?.symbol ?? resolved.createOptions?.arg;
      if (!symbol) throw new Error("A company disclosure screenshot requires a ticker");
      // A bare symbol takes the saved listing's venue, as the pane does.
      const saved = parsePublicTickerKey(symbol).exchange ? null : await context.store.loadTicker(symbol).catch(() => null);
      const listing = await resolveIssuerListing(symbol, saved?.metadata.exchange, context.dataProvider);
      const payload = await fetchCompanyData(mode, symbol, companyQuery(resolved.options), apiClient, listing);
      // Keyed by the requested ticker: a listing abroad is answered under its bare symbol.
      return { settings: { companySnapshot: payload }, financials: [[symbol.trim().toUpperCase(), { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]] };
    },
    read(value) {
      if (!isRecord(value) || value.kind !== "company-disclosures" || value.version !== 1 || value.mode !== mode || !isRecord(value.payload)
        || !["table", "chart", "history", "evidence"].includes(String(value.tab)) || !Array.isArray(value.rowIds) || !value.rowIds.every((id) => typeof id === "string") || value.complete !== true) return null;
      try {
        const payload = validateCompanyData(value.payload as unknown as CompanyDataset);
        const rows = "series" in payload ? allObservations(payload) : allGuidance(payload);
        if (value.plottedValueCount !== value.rowIds.length || value.rowIds.some((id) => !rows.some((row) => row.id === id))) return null;
        return value as unknown as Evidence;
      } catch { return null; }
    },
    mismatches(evidence, { resolved, payload }) {
      const snapshot = payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId)?.settings?.companySnapshot;
      const issues: string[] = [];
      if (JSON.stringify(evidence.payload) !== JSON.stringify(snapshot)) issues.push("Company disclosures differ from the captured source data");
      if (evidence.tab !== (resolved.options.tab ?? "table")) issues.push("Company disclosure tab does not match");
      return issues;
    },
    unavailable: (evidence) => evidence?.complete ? [] : ["company disclosures"],
    symbols: ({ payload }) => payload.financials.map(([symbol]) => symbol),
  };
}
export const companyKpisScreenshotEvidence = screenshotEvidence("kpis");
export const companyGuidanceScreenshotEvidence = screenshotEvidence("guidance");
