import { apiClient } from "../../../api-client";
import type { ExposurePayload, ExposureRequest, ExposureScenario } from "../../../api-client/exposure";
import { isRecord } from "../../../utils/guards";
import { validRange, parseCustomScenario } from "./model";

const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const nullableRange = (v: unknown) => v === null || validRange(v);
const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === "string");
function evidence(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const safeUrl = v.url === null || (typeof v.url === "string" && /^https?:\/\//.test(v.url));
  return typeof v.id === "string" && safeUrl && (v.quote === null || typeof v.quote === "string")
    && ["structured", "primary", "secondary", "imported", "profile", "user"].includes(String(v.tier))
    && (v.confidence === null || (finite(v.confidence) && Number(v.confidence) >= 0 && Number(v.confidence) <= 1));
}
/** Reject malformed percentages and untrusted source links before displaying any result. */
export function validateExposure(value: ExposurePayload): ExposurePayload {
  const data = value as ExposurePayload;
  let valid = !!data && data.version === 1 && ["full", "preview"].includes(data.access)
    && Number.isInteger(data.depth) && data.depth >= 1 && data.depth <= 4
    && typeof data.evaluatedAt === "string" && Number.isFinite(Date.parse(data.evaluatedAt))
    && Number.isInteger(data.requestedHoldings) && Number.isInteger(data.lockedHoldings) && data.lockedHoldings >= 0
    && Array.isArray(data.holdings) && strings(data.unknowns) && strings(data.methodology);
  try { parseCustomScenario(JSON.stringify(data.scenario)); } catch { valid = false; }
  valid &&= data.holdings.every(h => typeof h.symbol === "string" && finite(h.weight) && Array.isArray(h.unknowns)
    && ["quantified", "partial", "unknown"].includes(h.status) && !!h.coverage
    && Array.isArray(h.measures) && h.measures.every(m => validRange(m.exposurePct) && nullableRange(m.impactPct) && strings(m.componentIds))
    && Array.isArray(h.components) && h.components.every(c => nullableRange(c.exposurePct) && nullableRange(c.impactPct)
      && (c.proportionalEstimatePct == null || finite(c.proportionalEstimatePct))
      && ["disclosed", "estimated", "unknown"].includes(c.classification) && Array.isArray(c.evidence) && c.evidence.every(evidence)
      && Array.isArray(c.path) && c.path.every(hop => !!hop.from && !!hop.to && Array.isArray(hop.evidence) && hop.evidence.every(evidence)) && strings(c.unknowns)));
  valid &&= !!data.portfolio && finite(data.portfolio.netWeight) && finite(data.portfolio.grossWeight) && finite(data.portfolio.residualWeight)
    && Array.isArray(data.portfolio.measures) && data.portfolio.measures.every(m => validRange(m.signedExposurePct) && validRange(m.grossExposurePct) && nullableRange(m.impactPct))
    && Array.isArray(data.portfolio.concentrations) && data.portfolio.concentrations.every(c => nullableRange(c.grossExposurePct) && nullableRange(c.signedExposurePct) && Array.isArray(c.evidence) && c.evidence.every(evidence));
  if (!valid) throw new Error("The server returned unreadable exposure data.");
  return data;
}
export async function fetchExposure(request: ExposureRequest, client: Pick<typeof apiClient, "analyzeCloudExposure"> = apiClient) {
  return validateExposure(await client.analyzeCloudExposure(request));
}
export async function fetchScenarios(client: Pick<typeof apiClient, "getCloudExposureScenarios"> = apiClient): Promise<ExposureScenario[]> {
  const data = await client.getCloudExposureScenarios();
  if (!Array.isArray(data.scenarios)) throw new Error("Scenario library is unavailable.");
  return data.scenarios.map(s => parseCustomScenario(JSON.stringify(s)));
}
