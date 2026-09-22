import { useRemoteUiNode } from "../../../remote/semantic-tree";
import type { SurfaceExpiry, SurfaceGrid, SurfaceSnapshot } from "./model";

export interface VolSurfaceEvidenceInput {
  snapshot: SurfaceSnapshot | null | undefined;
  view: string;
  grid: SurfaceGrid | null;
  selectedExpiry: SurfaceExpiry | null;
  loading: boolean;
  bitmapAvailable: boolean;
  axis: string;
  tenors: string;
  overlaySmiles: boolean;
}

export interface VolSurfaceEvidence {
  kind: "volatility-surface";
  version: 1;
  symbol: string | null;
  view: string;
  renderer: "bitmap" | "table" | "chart";
  axis: string;
  tenors: string;
  ivSource: string | null;
  priceSide: string | null;
  spot: number | null;
  spotAsOf: string | number | null;
  loading: boolean;
  complete: boolean;
  requestedExpiries: number;
  loadedExpiries: number;
  failedExpiries: number;
  sourcePointCount: number;
  plottedValueCount: number;
  validQuadCount: number;
  selectedExpiration: number | null;
  overlaySmiles: boolean;
  expiries: Array<{
    expiration: number;
    years: number;
    state: SurfaceExpiry["state"];
    stale: boolean;
    error: string | null;
    source: string | null;
    asOf: string | null;
    rate: number | null;
    rateAsOf: string[];
    forward: number | null;
    fitMethod: string | null;
    sourcePointCount: number;
  }>;
  grid: { tenors: number[]; coordinates: number[]; values: (number | null)[][] } | null;
  smile: { expiration: number; points: Array<{ strike: number; volatility: number }> } | null;
  term: Array<{ expiration: number; years: number; atm: number; put25: number | null; call25: number | null }>;
  table: Array<{ expiration: number; values: (number | null)[] }>;
  failures: Array<{ expiration: number | null; message: string }>;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const iv = (value: unknown): value is number => finite(value) && value > 0;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function gridCounts(values: (number | null)[][]): { values: number; quads: number } {
  let count = 0, quads = 0;
  values.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (!iv(value)) return;
    count += 1;
    if (iv(row[columnIndex + 1]) && iv(values[rowIndex + 1]?.[columnIndex]) && iv(values[rowIndex + 1]?.[columnIndex + 1])) quads += 1;
  }));
  return { values: count, quads };
}

/** Evidence comes from the active rendered view's model, never from the presence of a canvas. */
export function volSurfaceSemanticEvidence(input: VolSurfaceEvidenceInput): VolSurfaceEvidence {
  const { snapshot, view, selectedExpiry } = input;
  const renderer = view === "surface" && input.bitmapAvailable ? "bitmap"
    : view === "smile" || view === "term" ? "chart" : "table";
  const grid = (view === "surface" || view === "table") && input.grid ? {
    tenors: [...input.grid.tenors], coordinates: [...input.grid.moneyness],
    values: input.grid.volatilities.map((row) => row.map((value) => iv(value) ? value : null)),
  } : null;
  const smile = view === "smile" && selectedExpiry?.fit && selectedExpiry.points.length >= 2 ? {
    expiration: selectedExpiry.expiration,
    points: selectedExpiry.points.filter((point) => iv(point.volatility) && iv(point.strike))
      .map((point) => ({ strike: point.strike, volatility: point.volatility })),
  } : null;
  const term = view === "term" ? (snapshot?.expiries ?? []).filter((expiry) => iv(expiry.atmIV))
    .map((expiry) => ({ expiration: expiry.expiration, years: expiry.years, atm: expiry.atmIV!,
      put25: expiry.skew.put25, call25: expiry.skew.call25 })) : [];
  const table = view === "skew" || view === "forwards" ? (snapshot?.expiries ?? []).map((expiry) => ({
    expiration: expiry.expiration,
    values: view === "forwards" ? [expiry.forward, expiry.dividendYield, expiry.rate]
      : [expiry.skew.put25, expiry.skew.call25, expiry.skew.riskReversal, expiry.skew.butterfly, expiry.skew.moneynessSkew, expiry.termSlope],
  })) : [];
  const counts = grid ? gridCounts(grid.values) : { values: 0, quads: 0 };
  const plottedValueCount = grid ? counts.values : smile ? smile.points.length : term.length
    || table.reduce((total, row) => total + row.values.filter(finite).length, 0);
  const loading = input.loading || snapshot?.phase === "loading" || (snapshot != null && snapshot.loaded < snapshot.requested);
  const relevantExpiries = view === "smile" ? selectedExpiry ? [selectedExpiry] : [] : snapshot?.expiries ?? [];
  return {
    kind: "volatility-surface", version: 1, symbol: snapshot?.symbol ?? null, view, renderer,
    axis: renderer === "bitmap" ? "forward" : input.axis,
    tenors: renderer === "bitmap" ? "listed" : input.tenors,
    ivSource: snapshot?.settings.ivSource ?? null, priceSide: snapshot?.settings.priceSide ?? null,
    spot: snapshot?.spot ?? null, spotAsOf: snapshot?.spotAsOf ?? null, loading,
    complete: !loading && !!snapshot && snapshot.phase === "ready" && snapshot.requested > 0
      && snapshot.loaded === snapshot.requested && snapshot.failed === 0 && snapshot.failures.length === 0
      && snapshot.expiries.every((expiry) => expiry.state === "ready" && !expiry.stale && !expiry.error),
    requestedExpiries: snapshot?.requested ?? 0, loadedExpiries: snapshot?.loaded ?? 0, failedExpiries: snapshot?.failed ?? 0,
    sourcePointCount: relevantExpiries.reduce((total, expiry) => total + expiry.points.length, 0),
    plottedValueCount, validQuadCount: counts.quads, selectedExpiration: selectedExpiry?.expiration ?? null,
    overlaySmiles: input.overlaySmiles,
    expiries: (snapshot?.expiries ?? []).map((expiry) => ({ expiration: expiry.expiration, years: expiry.years,
      state: expiry.state, source: expiry.source, asOf: expiry.asOf, rate: expiry.rate,
      stale: expiry.stale, error: expiry.error,
      rateAsOf: [...expiry.rateAsOf], forward: expiry.forward, fitMethod: expiry.fit?.method ?? null,
      sourcePointCount: expiry.points.length })),
    grid, smile, term, table, failures: snapshot?.failures.map((failure) => ({ ...failure })) ?? [],
  };
}

export function useVolSurfaceEvidence(input: VolSurfaceEvidenceInput): void {
  useRemoteUiNode({ role: "chart-data", label: "Rendered volatility observations",
    getMetadata: () => ({ ...volSurfaceSemanticEvidence(input) }) });
}

/** Verify values and recompute counts so asserted readiness alone cannot certify a chart. */
export function readVolSurfaceEvidence(value: unknown): VolSurfaceEvidence | null {
  if (!record(value) || value.kind !== "volatility-surface" || value.version !== 1
    || typeof value.symbol !== "string" || !iv(value.spot) || !Array.isArray(value.expiries)
    || !Array.isArray(value.failures) || !finite(value.sourcePointCount) || value.sourcePointCount <= 0
    || typeof value.complete !== "boolean" || typeof value.loading !== "boolean") return null;
  if (!value.expiries.every((expiry) => record(expiry) && iv(expiry.expiration) && iv(expiry.years)
    && finite(expiry.sourcePointCount) && expiry.sourcePointCount >= 0
    && ["loading", "ready", "empty", "error"].includes(String(expiry.state)))) return null;
  if (value.complete && (value.loading || !iv(value.requestedExpiries)
    || value.loadedExpiries !== value.requestedExpiries || value.expiries.length !== value.requestedExpiries
    || value.failedExpiries !== 0 || value.failures.length > 0 || !value.expiries.every((expiry) => record(expiry)
      && expiry.state === "ready" && expiry.stale === false && expiry.error === null && iv(expiry.sourcePointCount)))) return null;
  let count = 0, quads = 0;
  if (value.view === "surface" || value.view === "table") {
    const grid = value.grid;
    if (!record(grid) || !Array.isArray(grid.tenors) || !grid.tenors.every(iv)
      || !Array.isArray(grid.coordinates) || !grid.coordinates.every(finite)
      || !Array.isArray(grid.values) || grid.values.length !== grid.tenors.length
      || !grid.values.every((row) => Array.isArray(row) && row.length === (grid.coordinates as unknown[]).length
        && row.every((cell) => cell === null || iv(cell)))) return null;
    const counts = gridCounts(grid.values as (number | null)[][]);
    count = counts.values; quads = counts.quads;
    if (value.renderer === "bitmap" && quads === 0) return null;
  } else if (value.view === "smile") {
    const smile = value.smile;
    if (!record(smile) || !iv(smile.expiration) || !Array.isArray(smile.points)
      || !smile.points.every((point) => record(point) && iv(point.strike) && iv(point.volatility))) return null;
    count = smile.points.length;
    if (count < 2 || smile.expiration !== value.selectedExpiration) return null;
  } else if (value.view === "term") {
    if (!Array.isArray(value.term) || !value.term.every((point) => record(point)
      && iv(point.expiration) && iv(point.years) && iv(point.atm))) return null;
    count = value.term.length;
  } else if (value.view === "skew" || value.view === "forwards") {
    if (!Array.isArray(value.table) || !value.table.every((row) => record(row) && iv(row.expiration)
      && Array.isArray(row.values) && row.values.every((cell) => cell === null || finite(cell)))) return null;
    count = value.table.reduce((total: number, row) => total + (row as { values: unknown[] }).values.filter(finite).length, 0);
  } else return null;
  if (count === 0 || value.plottedValueCount !== count || value.validQuadCount !== quads) return null;
  return value as unknown as VolSurfaceEvidence;
}
