import type { ExposureBasis, ExposureComponent, ExposureExtensionObservation, ExposureHolding, ExposurePayload, ExposureRange, ExposureScenario } from "../../../api-client/exposure";

export const TABS = [{ value: "table", label: "Table" }, { value: "drivers", label: "Drivers" }, { value: "paths", label: "Paths" }, { value: "portfolio", label: "Portfolio" }];
export const DEFAULT_SCENARIO: ExposureScenario = { id: "taiwan-disruption", label: "Taiwan disruption", shocks: [{ id: "taiwan", kind: "country", target: "TW", changePct: -100 }] };
export const basisLabel = (basis: string | null) => basis?.replaceAll("_", " ") ?? "Unknown basis";
const pct = (value: number) => `${value.toFixed(1)}%`;
export const rangeText = (range: ExposureRange | null) => !range ? "Unknown" : range.low === range.high ? pct(range.low) : `${range.low.toFixed(1)} to ${range.high.toFixed(1)}%`;
export const fraction = (value: number) => pct(value * 100);

/** A weighted list is entirely explicit. Never silently fill missing weights or normalize shorts. */
export function parseHoldings(text: string): ExposureHolding[] {
  const tokens = text.trim().split(/[\s,;]+/).filter(Boolean);
  if (!tokens.length) throw new Error("Enter holdings, for example AAPL=60% NVDA=40%.");
  if (tokens.length > 100) throw new Error("Use at most 100 holdings.");
  const weighted = tokens.some(token => token.includes("="));
  const seen = new Set<string>();
  return tokens.map(token => {
    const match = /^([A-Za-z0-9.:-]{1,40})(?:=([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%?))?$/.exec(token);
    if (!match || (weighted && match[2] === undefined)) throw new Error("Use tickers alone for equal weights, or give every holding a weight: AAPL=60% NVDA=-10%.");
    const symbol = match[1]!.toUpperCase();
    if (seen.has(symbol)) throw new Error(`Duplicate holding: ${symbol}`);
    seen.add(symbol);
    const weight = weighted ? Number(match[2]) / (match[3] === "%" ? 100 : 1) : 1 / tokens.length;
    if (!Number.isFinite(weight) || Math.abs(weight) > 10) throw new Error(`Weight for ${symbol} must be between -1000% and 1000%.`);
    return { symbol, weight };
  });
}
function onlyKeys(value: object, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
export function parseCustomScenario(text: string): ExposureScenario {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Custom scenario must be valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Custom scenario must be an object.");
  const scenario = value as ExposureScenario;
  if (!onlyKeys(scenario, ["id", "label", "shocks"]) || (scenario.id !== undefined && (typeof scenario.id !== "string" || scenario.id.length > 64))) throw new Error("Unsupported scenario field or invalid id (maximum 64 characters).");
  if (typeof scenario.label !== "string" || !scenario.label.trim() || scenario.label.trim().length > 160 || !Array.isArray(scenario.shocks) || !scenario.shocks.length || scenario.shocks.length > 8) throw new Error("A scenario needs a label (1 to 160 characters) and 1 to 8 shocks.");
  scenario.label = scenario.label.trim();
  const ids = new Set<string>();
  for (const shock of scenario.shocks) {
    if (!shock || typeof shock !== "object" || !onlyKeys(shock, ["id", "kind", "target", "changePct", "changeBps", "products", "transmission"]) || typeof shock.id !== "string" || !shock.id.trim() || shock.id.trim().length > 64 || ids.has(shock.id.trim()) || !["country", "commodity", "rate", "fx", "tariff", "supplier", "customer"].includes(shock.kind) || typeof shock.target !== "string" || !shock.target.trim() || shock.target.trim().length > 160) throw new Error("Each shock needs a unique id (up to 64 characters), supported kind and target (up to 160 characters), with no unsupported fields.");
    shock.id = shock.id.trim(); shock.target = shock.target.trim(); ids.add(shock.id);
    const change = shock.kind === "rate" ? shock.changeBps : shock.changePct;
    if (typeof change !== "number" || !Number.isFinite(change)) throw new Error("Each shock needs a finite changePct (or changeBps for rates).");
    if (shock.kind === "rate" ? Math.abs(change) > 10_000 || shock.changePct !== undefined : change < -100 || change > 1000 || shock.changeBps !== undefined) throw new Error("Rate shocks use only changeBps (-10000 to 10000); other shocks use only changePct (-100 to 1000).");
    if (shock.products !== undefined && (!["country", "tariff"].includes(shock.kind) || !Array.isArray(shock.products) || shock.products.length < 1 || shock.products.length > 12 || shock.products.some(p => typeof p !== "string" || !p.trim() || p.trim().length > 100))) throw new Error("Product restrictions require 1 to 12 names of up to 100 characters on a country or tariff shock.");
    if (shock.transmission !== undefined) {
      const t = shock.transmission;
      if (!t || typeof t !== "object" || !onlyKeys(t, ["basis", "exposurePct", "factor", "direction"]) || !["revenue", "cost", "purchases", "receivables", "operating_income", "interest_expense", "debt"].includes(t.basis) || !validRange(t.exposurePct) || !onlyKeys(t.exposurePct, ["low", "high"]) || t.exposurePct.low < 0 || t.exposurePct.high > 100 || !validRange(t.factor) || !onlyKeys(t.factor, ["low", "high"]) || t.factor.low < 0 || t.factor.high > 100 || ![undefined, 1, -1].includes(t.direction)) throw new Error("Transmission needs a basis, exposurePct and factor ranges within 0 to 100, direction 1 or -1, and no unsupported fields.");
    }
  }
  return scenario;
}
export function validRange(value: unknown): value is ExposureRange {
  const r = value as ExposureRange | null;
  return !!r && Number.isFinite(r.low) && Number.isFinite(r.high) && r.low <= r.high;
}
export interface ExposureRow {
  driver?: ExposureExtensionObservation;
  id: string; symbol: string; shockId: string; label: string; basis: ExposureBasis | null; period: string | null;
  exposure: ExposureRange | null; impact: ExposureRange | null; weight: number | null;
  classification: string; incomplete: boolean; concentration?: boolean; components: ExposureComponent[]; unknowns: string[];
}
function shockLabel(data: ExposurePayload, id: string): string {
  const shock = data.scenario.shocks.find(s => s.id === id);
  if (!shock) return id;
  const change = shock.changeBps ?? shock.changePct;
  return `${shock.target}${change == null ? "" : ` ${change > 0 ? "+" : ""}${change}${shock.kind === "rate" ? "bp" : "%"}`}`;
}
export function tableRows(data: ExposurePayload): ExposureRow[] {
  return data.holdings.flatMap<ExposureRow>(holding => [
    ...holding.measures.map((measure, i): ExposureRow => ({
      id: `${holding.symbol}:${i}`, symbol: holding.symbol, shockId: measure.shockId, label: shockLabel(data, measure.shockId),
      basis: measure.basis, period: measure.period, exposure: measure.exposurePct, impact: measure.impactPct,
      weight: holding.weight, classification: measure.classification, incomplete: measure.incomplete,
      components: holding.components.filter(c => measure.componentIds.includes(c.id)), unknowns: holding.unknowns,
    })),
    ...data.scenario.shocks.filter(shock => !holding.measures.some(m => m.shockId === shock.id)).map((shock): ExposureRow => ({
      id: `${holding.symbol}:unknown:${shock.id}`, symbol: holding.symbol, shockId: shock.id, label: shockLabel(data, shock.id), basis: null, period: null,
      exposure: null, impact: null, weight: holding.weight, classification: "unknown", incomplete: true,
      components: holding.components.filter(c => c.shockId === shock.id), unknowns: holding.unknowns,
    })),
  ]);
}
export function pathRows(data: ExposurePayload): ExposureRow[] {
  return data.holdings.flatMap(holding => holding.components.map(component => ({
    id: `${holding.symbol}:${component.id}`, symbol: holding.symbol, shockId: component.shockId,
    label: component.path.length ? [component.path[0]!.from.symbol ?? component.path[0]!.from.name, ...component.path.map(h => h.to.symbol ?? h.to.name)].join(" → ") : component.label,
    basis: component.basis, period: component.period, exposure: component.exposurePct, impact: component.impactPct,
    weight: holding.weight, classification: component.classification, incomplete: component.unknowns.length > 0,
    components: [component], unknowns: component.unknowns,
  })));
}
export function portfolioRows(data: ExposurePayload, view: string): ExposureRow[] {
  if (view === "stress") return data.portfolio.measures.map((m, i) => ({ id: `stress:${i}`, symbol: m.symbols.join(", "), shockId: m.shockId, label: shockLabel(data, m.shockId),
    basis: m.basis, period: m.period, exposure: m.signedExposurePct, impact: m.impactPct, weight: m.coveredGrossWeight,
    classification: "estimated", incomplete: m.unknownGrossWeight > 0, components: [], unknowns: [`Unknown gross holding weight: ${fraction(m.unknownGrossWeight)}`] }));
  return data.portfolio.concentrations.filter(c => c.kind === view).map((c, i) => ({
    id: `${c.kind}:${c.key}:${i}`, symbol: c.symbols.join(", "), shockId: "", label: c.label, basis: c.basis, period: c.period,
    exposure: c.grossExposurePct, impact: c.signedExposurePct, weight: c.grossHoldingWeight, classification: c.grossExposurePct === null ? "unknown" : "estimated", incomplete: c.incomplete, concentration: true,
    components: [{ id: c.key, shockId: "", label: c.label, channel: c.kind === "country" ? "geography" : c.kind, order: 0, basis: c.basis, period: c.period,
      classification: c.grossExposurePct === null ? "unknown" : "estimated", exposurePct: c.grossExposurePct, impactPct: null, evidence: c.evidence, path: [], unknowns: [] }], unknowns: c.incomplete ? ["Concentration includes unquantified relationships."] : [],
  }));
}
