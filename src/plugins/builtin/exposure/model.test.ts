import { expect, test } from "bun:test";
import type { ExposurePayload, ExposureScenario } from "../../../api-client/exposure";
import { parseCustomScenario, parseHoldings, pathRows, portfolioRows, tableRows } from "./model";
import { validateExposure } from "./client";
import audited from "./fixtures/taiwan.fixture.json";

const payload = () => structuredClone(audited) as ExposurePayload;
test("explicit signed NAV weights preserve shorts, leverage, residual and listing identity", () => {
  expect(parseHoldings("AAPL=120% NVDA=-30% 2330:TWSE=.15")).toEqual([
    { symbol: "AAPL", weight: 1.2 }, { symbol: "NVDA", weight: -.3 }, { symbol: "2330:TWSE", weight: .15 },
  ]);
  expect(parseHoldings("AAPL,NVDA").map(h => h.weight)).toEqual([.5, .5]);
  expect(() => parseHoldings("AAPL=.8 NVDA")).toThrow("every holding");
  expect(() => parseHoldings("AAPL=NaN")).toThrow();
  expect(() => parseHoldings("AAPL aapl")).toThrow("Duplicate");
});
test("custom assumptions validate intervals and units without inventing rate or FX sensitivities", () => {
  const scenario = { label: "Rates", shocks: [{ id: "rate", kind: "rate", target: "USD", changeBps: 100,
    transmission: { basis: "interest_expense", exposurePct: { low: 20, high: 40 }, factor: { low: .2, high: 1 }, direction: 1 } }] } satisfies ExposureScenario;
  expect(parseCustomScenario(JSON.stringify(scenario))).toEqual(scenario);
  expect(() => parseCustomScenario(JSON.stringify({ ...scenario, shocks: [scenario.shocks[0], scenario.shocks[0]] }))).toThrow("unique");
  expect(() => parseCustomScenario(JSON.stringify({ label: "Oil", shocks: [{ id: "oil", kind: "commodity", target: "oil", changePct: "20" }] }))).toThrow("finite");
  scenario.shocks[0]!.transmission.exposurePct.low = 50;
  expect(() => parseCustomScenario(JSON.stringify(scenario))).toThrow("Transmission");
});
test("audited disclosure projections keep different periods separate and preserve missing paths", () => {
  const data = validateExposure(payload());
  const rows = tableRows(data);
  expect(rows.find(r => r.symbol === "NVDA")?.exposure?.low).toBeCloseTo(19.6097954);
  expect(rows.find(r => r.symbol === "AAPL")?.exposure?.low).toBe(0);
  expect(rows.find(r => r.symbol === "AAPL")?.exposure?.high).toBeGreaterThan(15);
  expect(pathRows(data).some(r => r.exposure === null && r.classification === "unknown")).toBe(true);
  expect(portfolioRows(data, "stress").length).toBe(data.portfolio.measures.length);
  for (const row of rows) for (const component of row.components) expect(component.basis).toBe(row.basis);
});
test("wire validator rejects inverted exposure bounds, executable URLs and malformed scenarios", () => {
  const data = payload(); data.holdings[0]!.measures[0]!.exposurePct = { low: 30, high: 20 };
  expect(() => validateExposure(data)).toThrow("unreadable");
  const link = payload(); link.holdings[0]!.components[0]!.evidence[0]!.url = "javascript:alert(1)";
  expect(() => validateExposure(link)).toThrow("unreadable");
  const scenario = payload(); scenario.scenario.shocks[0]!.changePct = Number.NaN;
  expect(() => validateExposure(scenario)).toThrow("unreadable");
});
test("multiple shock legs retain unknowns beside quantified legs and never combine their ranges", () => {
  const data = payload();
  data.scenario.shocks.push({ id: "rates", kind: "rate", target: "USD", changeBps: 100 });
  const rows = tableRows(data).filter(r => r.symbol === "NVDA");
  expect(rows).toHaveLength(2);
  expect(rows.map(r => r.shockId)).toEqual(["taiwan", "rates"]);
  expect(rows[1]).toMatchObject({ label: "USD +100bp", exposure: null, classification: "unknown" });
  const concentration = portfolioRows(data, "supplier").find(r => r.exposure === null);
  if (concentration) expect(concentration).toMatchObject({ classification: "unknown", concentration: true });
});
test("custom editor refuses backend-invalid units, fields and magnitude before saving", () => {
  const base = { label: "Custom", shocks: [{ id: "one", kind: "country", target: "TW", changePct: -100 }] };
  for (const shock of [
    { ...base.shocks[0], changePct: -101 }, { ...base.shocks[0], changeBps: 100 },
    { ...base.shocks[0], kind: "fx", products: ["chips"] }, { ...base.shocks[0], target: "X".repeat(161) },
  ]) expect(() => parseCustomScenario(JSON.stringify({ ...base, shocks: [shock] }))).toThrow();
  expect(() => parseCustomScenario(JSON.stringify({ ...base, asOf: "2020-01-01" }))).toThrow("Unsupported");
  expect(() => parseHoldings("A/B=1")).toThrow();
  expect(() => parseHoldings("X".repeat(41))).toThrow();
});
test("quantified proportional chains are numeric estimates and concentration details are signed exposures", () => {
  const data = payload(); data.holdings[0]!.components[0]!.proportionalEstimatePct = 0;
  expect(validateExposure(data).holdings[0]!.components[0]!.proportionalEstimatePct).toBe(0);
  const rows = portfolioRows(data, "country");
  expect(rows[0]!.concentration).toBe(true);
  expect(rows[0]!.impact).toEqual(data.portfolio.concentrations.find(c => c.kind === "country")!.signedExposurePct);
});
