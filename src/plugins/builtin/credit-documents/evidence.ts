import type { CreditDocumentsPayload, CreditInstrument, CreditScreenPayload } from "../../../api-client/credit-documents";
import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { isRecord } from "../../../utils/guards";
import { fetchCreditDocuments, fetchCreditInstrument, fetchCreditScreen, validateCreditDocuments, validateCreditInstrument, validateCreditScreen } from "./client";
import { CREDIT_TABS, screenRowId } from "./model";
interface CreditEvidence {
  kind: "credit-documents";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  payload: CreditDocumentsPayload;
  screen: CreditScreenPayload | null;
  instrument: CreditInstrument | null;
  tab: string;
  view: string;
  rowIds: string[];
  instrumentId: string | null;
  factId: string | null;
}
export function useCreditEvidence(payload: CreditDocumentsPayload | null, screen: CreditScreenPayload | null, instrument: CreditInstrument | null, tab: string, view: string, rowIds: string[], instrumentId: string | null, factId: string | null) {
  useRemoteUiNode({ role: "chart-data", label: "Rendered credit-document evidence", getMetadata: () => ({
    kind: "credit-documents", version: 1, complete: !!payload && (tab !== "screen" || !!screen), ready: !!payload && (tab !== "screen" || !!screen),
    plottedValueCount: rowIds.length, payload, screen, instrument, tab, view, rowIds, instrumentId, factId,
  }) });
}
export const creditScreenshotEvidence: PaneScreenshotEvidenceHook<CreditEvidence> = {
  paneId: "credit-documents", kind: "credit-documents", label: "credit documents",
  async prepare({ resolved }) {
    const symbol = resolved.createOptions?.symbol ?? resolved.createOptions?.arg;
    if (!symbol) throw new Error("A credit-document screenshot requires an issuer ticker");
    const payload = await fetchCreditDocuments(symbol);
    const screen = resolved.options.tab === "screen" ? await fetchCreditScreen({ headroomBelow: Number(resolved.options.headroom ?? 20), springingWithinMonths: Number(resolved.options.months ?? 12), limit: 100 }) : null;
    const instrument = resolved.options.instrument ? await fetchCreditInstrument(symbol, String(resolved.options.instrument)) : null;
    return { settings: { creditSnapshot: payload, creditScreenSnapshot: screen, creditInstrumentSnapshot: instrument }, financials: [[symbol, { annualStatements: [], quarterlyStatements: [], priceHistory: [] }]] };
  },
  read(value) {
    if (!isRecord(value) || value.kind !== "credit-documents" || value.version !== 1 || value.complete !== true || !CREDIT_TABS.some((tab) => tab.value === value.tab)
      || !["terms", "history"].includes(String(value.view)) || !Array.isArray(value.rowIds) || !value.rowIds.every((id) => typeof id === "string") || value.plottedValueCount !== value.rowIds.length) return null;
    try {
      const payload = validateCreditDocuments(value.payload as CreditDocumentsPayload);
      if (value.screen) validateCreditScreen(value.screen as CreditScreenPayload);
      if (value.instrument) validateCreditInstrument(value.instrument as CreditInstrument);
      const screen = value.screen as CreditScreenPayload | null;
      const eligible = new Set(value.tab === "capital" ? payload.instruments.map((row) => row.id) : value.tab === "covenants" ? payload.covenants.map((row) => row.id) : value.tab === "screen" ? (screen?.rows ?? []).map(screenRowId) : payload.maturities.flatMap((row) => row.instruments.map((instrument) => `${row.year}:${instrument.id}`)));
      if (new Set(value.rowIds).size !== value.rowIds.length || value.rowIds.some((id) => !eligible.has(id as string))) return null;
      return value as unknown as CreditEvidence;
    } catch { return null; }
  },
  mismatches(evidence, { resolved, payload }) {
    const settings = payload.config.layout.instances.find((entry) => entry.instanceId === payload.paneId)?.settings;
    const mismatches: string[] = [];
    if (JSON.stringify(evidence.payload) !== JSON.stringify(settings?.creditSnapshot)) mismatches.push("Credit documents differ from captured filing evidence");
    if (evidence.tab === "screen" && JSON.stringify(evidence.screen) !== JSON.stringify(settings?.creditScreenSnapshot)) mismatches.push("Credit screen differs from captured results");
    if (resolved.options.instrument && JSON.stringify(evidence.instrument) !== JSON.stringify(settings?.creditInstrumentSnapshot)) mismatches.push("Instrument history differs from captured revisions");
    if (evidence.tab !== (resolved.options.tab ?? "capital")) mismatches.push("Credit-document tab does not match");
    if (resolved.options.instrument && evidence.instrumentId !== resolved.options.instrument) mismatches.push("Requested credit instrument is not open");
    if (resolved.options.fact && evidence.factId !== resolved.options.fact) mismatches.push("Requested credit evidence is not open");
    if (evidence.view !== (resolved.options.view ?? "terms")) mismatches.push("Credit-document evidence view does not match");
    return mismatches;
  },
  unavailable(evidence) { return evidence?.complete ? [] : ["credit documents"]; },
  symbols({ payload }) { return payload.financials.map(([symbol]) => symbol); },
};
