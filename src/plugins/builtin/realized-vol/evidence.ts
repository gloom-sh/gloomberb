import { useRemoteUiNode } from "../../../remote/semantic-tree";
import type { ResolvedSeries } from "../../../time-series/types";

export interface RealizedVolEvidenceStatus {
  symbol: string;
  view: "graph" | "cone";
  estimator: string;
  windows: readonly number[];
  lookbackYears: number;
  showIv: boolean;
  loading: boolean;
  stale: boolean;
  source: string | null;
  asOf: string | null;
  errors: string[];
  currentIv: { value: number; date: string; label: string; source: string | null; expiration: number } | null;
}

export interface RealizedVolEvidence extends RealizedVolEvidenceStatus {
  kind: "realized-volatility";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  series: Array<{ id: string; unit: string; points: Array<{ date: string; value: number | null }> }>;
}

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const dated = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** The same resolved series passed to CompositeChart supplies the capture evidence. */
export function realizedVolSemanticEvidence(series: readonly ResolvedSeries[], status: RealizedVolEvidenceStatus): RealizedVolEvidence {
  const plotted = series.map((entry) => ({ id: entry.id, unit: entry.unit,
    points: entry.points.map((point) => ({ date: point.date.toISOString(), value: finite(point.value) ? point.value : null })),
  }));
  const plottedValueCount = plotted.reduce((sum, entry) => sum + entry.points.filter((point) => finite(point.value)).length, 0);
  return { ...status, kind: "realized-volatility", version: 1, series: plotted, plottedValueCount,
    complete: !status.loading && !status.stale && status.errors.length === 0 && !!status.asOf
      && plotted.length > 0 && plotted.every((entry) => entry.points.some((point) => finite(point.value)))
      && (!status.showIv || status.currentIv != null),
  };
}

export function useRealizedVolEvidence(series: readonly ResolvedSeries[], status: RealizedVolEvidenceStatus): void {
  useRemoteUiNode({ role: "chart-data", label: "Rendered realized volatility observations",
    getMetadata: () => ({ ...realizedVolSemanticEvidence(series, status) }) });
}

/** Recount actual observations; a canvas or asserted count alone cannot certify a capture. */
export function readRealizedVolEvidence(value: unknown): RealizedVolEvidence | null {
  if (!record(value) || value.kind !== "realized-volatility" || value.version !== 1
    || typeof value.symbol !== "string" || !value.symbol || !["graph", "cone"].includes(String(value.view))
    || typeof value.estimator !== "string" || !Array.isArray(value.windows) || !value.windows.every(finite)
    || !finite(value.lookbackYears) || typeof value.showIv !== "boolean" || typeof value.complete !== "boolean"
    || typeof value.loading !== "boolean" || typeof value.stale !== "boolean" || !dated(value.asOf)
    || !Array.isArray(value.errors) || !value.errors.every((error) => typeof error === "string")
    || !Array.isArray(value.series) || !value.series.every((entry) => record(entry) && typeof entry.id === "string"
      && typeof entry.unit === "string" && Array.isArray(entry.points) && entry.points.every((point) => record(point)
        && dated(point.date) && (point.value === null || finite(point.value))))) return null;
  const evidence = value as unknown as RealizedVolEvidence;
  const required = evidence.view === "graph" ? [...evidence.windows.map((window) => `hv-${window}`), "price",
    ...(evidence.showIv ? ["current-iv"] : [])] : ["min", "max", "mean", "current"];
  if (!required.length || (evidence.view === "graph" && !evidence.windows.length)
    || evidence.series.length !== required.length || new Set(evidence.series.map((entry) => entry.id)).size !== required.length
    || required.some((id) => !evidence.series.some((entry) => entry.id === id))) return null;
  const count = evidence.series.reduce((sum, entry) => sum + entry.points.filter((point) => finite(point.value)).length, 0);
  if (count <= 0 || count !== evidence.plottedValueCount) return null;
  if (evidence.currentIv != null && (!record(evidence.currentIv) || !finite(evidence.currentIv.value)
    || !dated(evidence.currentIv.date) || !finite(evidence.currentIv.expiration))) return null;
  if (evidence.view === "graph" && evidence.showIv && evidence.currentIv) {
    const points = evidence.series.find((entry) => entry.id === "current-iv")!.points;
    if (points.length !== 1 || points[0]!.date !== evidence.currentIv.date || points[0]!.value !== evidence.currentIv.value) return null;
  }
  if (evidence.complete && (evidence.loading || evidence.stale || evidence.errors.length > 0
    || (evidence.showIv && !evidence.currentIv)
    || evidence.series.some((entry) => !entry.points.some((point) => finite(point.value))))) return null;
  return evidence;
}
