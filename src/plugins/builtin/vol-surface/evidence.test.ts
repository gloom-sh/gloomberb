import { expect, test } from "bun:test";
import { fitVolatilitySmile } from "../shared/volatility";
import { buildSurfaceGrid, DEFAULT_SURFACE_SETTINGS, pendingSurfaceExpiry, type SurfaceExpiry,
  type SurfacePoint, type SurfaceSnapshot } from "./model";
import { readVolSurfaceEvidence, volSurfaceSemanticEvidence, type VolSurfaceEvidenceInput } from "./evidence";

function input(view = "surface"): VolSurfaceEvidenceInput {
  const now = Date.UTC(2026, 8, 22);
  const expiries: SurfaceExpiry[] = [Date.UTC(2026, 11, 18), Date.UTC(2027, 2, 19)].map((date) => {
    const expiry = pendingSurfaceExpiry(date / 1000, now);
    const points = [90, 100, 110].map((strike) => ({ strike, volatility: 0.25, logMoneyness: Math.log(strike / 100), fitResidual: 0 })) as SurfacePoint[];
    return { ...expiry, state: "ready", points, forward: 100, rate: 0.04, dividendYield: 0.04,
      rateAsOf: ["2026-09-21"], source: "test", asOf: "2026-09-22T13:45:00Z", atmIV: 0.25,
      fit: fitVolatilitySmile(points, expiry.years) };
  });
  const snapshot: SurfaceSnapshot = { symbol: "AAPL", spot: 100, spotAsOf: "2026-09-22T14:00:00Z", phase: "ready",
    settings: DEFAULT_SURFACE_SETTINGS, requested: 2, loaded: 2, failed: 0, failures: [], warnings: [],
    catalogue: expiries.map((expiry) => expiry.expiration), expiries, rateAsOf: "2026-09-21", fetchedAt: now };
  return { snapshot, view, selectedExpiry: expiries[0]!, grid: buildSurfaceGrid(snapshot, { coordinates: [0.9, 1, 1.1] }),
    loading: false, bitmapAvailable: true, axis: "forward", tenors: "listed", overlaySmiles: false };
}

test("surface evidence requires finite plotted quads backed by source observations", () => {
  const rendered = input();
  const evidence = volSurfaceSemanticEvidence(rendered);
  expect(evidence.plottedValueCount).toBe(6);
  expect(evidence.validQuadCount).toBe(2);
  expect(evidence.complete).toBe(true);
  expect(readVolSurfaceEvidence(evidence)).not.toBeNull();
  expect(evidence.spotAsOf).toBe("2026-09-22T14:00:00Z");
  expect(evidence.expiries[0]!.asOf).toBe("2026-09-22T13:45:00Z");
  const singleRow = { ...rendered, grid: { ...rendered.grid!, rows: rendered.grid!.rows.slice(0, 1),
    tenors: rendered.grid!.tenors.slice(0, 1), volatilities: rendered.grid!.volatilities.slice(0, 1) } };
  expect(readVolSurfaceEvidence(volSurfaceSemanticEvidence(singleRow))).toBeNull();
  expect(readVolSurfaceEvidence(volSurfaceSemanticEvidence({ ...singleRow, bitmapAvailable: false }))).not.toBeNull();
  expect(readVolSurfaceEvidence({ ...evidence, plottedValueCount: 99 })).toBeNull();
  expect(readVolSurfaceEvidence({ ...evidence, sourcePointCount: 0 })).toBeNull();
  expect(readVolSurfaceEvidence({ ...evidence, grid: { ...evidence.grid!, values: [[null, null, null], [null, null, null]] } })).toBeNull();
});

test("partial, loading, rejected and stale expiry states cannot claim complete captures", () => {
  const rendered = input();
  const snapshot = rendered.snapshot!;
  for (const changed of [
    { ...snapshot, loaded: 1 },
    { ...snapshot, failed: 1, failures: [{ expiration: snapshot.expiries[0]!.expiration, message: "offline" }] },
    { ...snapshot, expiries: [{ ...snapshot.expiries[0]!, state: "empty" as const }, snapshot.expiries[1]!] },
    { ...snapshot, expiries: [{ ...snapshot.expiries[0]!, stale: true }, snapshot.expiries[1]!] },
  ]) {
    const evidence = volSurfaceSemanticEvidence({ ...rendered, snapshot: changed });
    expect(evidence.complete).toBe(false);
    expect(readVolSurfaceEvidence({ ...evidence, complete: true })).toBeNull();
  }
  expect(volSurfaceSemanticEvidence({ ...rendered, loading: true }).complete).toBe(false);
  expect(readVolSurfaceEvidence(volSurfaceSemanticEvidence({ ...rendered, snapshot: null, grid: null }))).toBeNull();
});

test("smile and term evidence follow the active plotted series and reject a wrong selected expiry", () => {
  const smile = volSurfaceSemanticEvidence(input("smile"));
  expect(smile.plottedValueCount).toBe(3);
  expect(smile.sourcePointCount).toBe(3);
  expect(smile.grid).toBeNull();
  expect(readVolSurfaceEvidence(smile)).not.toBeNull();
  expect(readVolSurfaceEvidence({ ...smile, selectedExpiration: 1 })).toBeNull();
  const rendered = input("term");
  const term = volSurfaceSemanticEvidence(rendered);
  expect(term.plottedValueCount).toBe(2);
  expect(term.term.map((point) => point.atm)).toEqual([0.25, 0.25]);
  expect(readVolSurfaceEvidence(term)).not.toBeNull();
  const empty = volSurfaceSemanticEvidence({ ...rendered,
    snapshot: { ...rendered.snapshot!, expiries: rendered.snapshot!.expiries.map((expiry) => ({ ...expiry, atmIV: null })) } });
  expect(readVolSurfaceEvidence(empty)).toBeNull();
});
