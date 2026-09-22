import { useRemoteUiNode } from "../../../remote/semantic-tree";
import type { ProjectedChartPoint } from "../../../components/chart/core/data";
import type { VolatilityLoadResult } from "./client";
import type { VolatilityBoardRow } from "./model";
import { volatilityCurveChartModel, volatilityHistoryChartModel, volatilityIndexHistoryPoints, volatilityRatioChartModel } from "./chart-model";

interface EvidenceSeries {
  id: string;
  unit: "index points" | "ratio";
  points: Array<{ date: string; value: number | null }>;
}
export interface VolatilityEvidence {
  kind: "volatility-indices";
  version: 1;
  view: "curve" | "history" | "board";
  loading: boolean;
  stale: boolean;
  complete: boolean;
  asOf: string | null;
  selectedIndexId: string | null;
  plottedValueCount: number;
  unavailableSources: string[];
  series: EvidenceSeries[];
  curve: Array<{ id: string; days: number; value: number | null; source: string | null }>;
  rows: Array<Pick<VolatilityBoardRow, "id" | "symbol" | "value" | "date" | "source" | "sampleSize" | "change1d" | "percentile1y">>;
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const dated = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const seriesFrom = (id: string, points: readonly ProjectedChartPoint[], unit: EvidenceSeries["unit"] = "index points"): EvidenceSeries => ({
  id, unit, points: points.map((point) => ({ date: point.date.toISOString(), value: finite(point.close) ? point.close : null })),
});

/** These are the same projections passed to the active StaticChartSurface views. */
export function volatilitySemanticEvidence(result: VolatilityLoadResult | null | undefined, view: string,
  selected: VolatilityBoardRow | null, loading: boolean): VolatilityEvidence {
  const data = result?.data;
  const activeView = view === "history" || view === "board" ? view : "curve";
  const series: EvidenceSeries[] = [];
  const unavailableSources: string[] = [];
  let stale = false;
  const curve: VolatilityEvidence["curve"] = [];
  const rows: VolatilityEvidence["rows"] = [];
  if (data && activeView === "curve") {
    curve.push(...data.curve.points.map(({ id, days, value, source }) => ({ id, days, value, source })));
    series.push(seriesFrom("curve", volatilityCurveChartModel(data.curve.points).points));
    for (const point of data.curve.points) {
      const row = data.board.find((entry) => entry.id === point.id);
      if (point.value == null || (data.curve.source !== "fred" && (row?.stale || row?.error))) unavailableSources.push(point.id);
    }
    stale = data.curve.source === "fred" ? data.fred.metrics.some((metric) => metric.stale)
      : data.curve.points.some((point) => data.board.find((row) => row.id === point.id)?.stale);
  } else if (data && activeView === "history") {
    const levels = volatilityHistoryChartModel(data.fred, "");
    series.push(seriesFrom("VIXCLS", levels.points));
    const back = levels.points.map((point) => ({ ...point, close: Number.NaN }));
    for (const overlay of levels.overlays) for (const point of overlay.points) {
      if (back[point.index]) back[point.index] = { ...back[point.index]!, close: point.value };
    }
    series.push(seriesFrom("VXVCLS", back));
    series.push(seriesFrom("3M/30D", volatilityRatioChartModel(data.fred, "").points, "ratio"));
    for (const metric of data.fred.metrics) {
      if (!metric.history.length || metric.error || metric.stale) unavailableSources.push(metric.seriesId);
    }
    if (!data.fred.ratioHistory.length) unavailableSources.push("3M/30D");
    stale = data.fred.metrics.some((metric) => metric.stale);
  } else if (data && activeView === "board") {
    rows.push(...data.board.map(({ id, symbol, value, date, source, sampleSize, change1d, percentile1y }) => ({
      id, symbol, value, date, source, sampleSize, change1d, percentile1y,
    })));
    if (selected) series.push(seriesFrom(selected.id, volatilityIndexHistoryPoints(selected.history, selected.missingDates)));
    unavailableSources.push(...data.board.filter((row) => row.value == null || row.error || row.stale).map((row) => row.symbol));
    stale = data.board.some((row) => row.stale);
  }
  const plottedValueCount = series.reduce((sum, entry) => sum + entry.points.filter((point) => finite(point.value)).length, 0)
    + rows.filter((row) => finite(row.value)).length;
  const pending = loading || !result || result.loaded < result.total;
  return { kind: "volatility-indices", version: 1, view: activeView, loading: pending, stale,
    complete: !pending && !stale && unavailableSources.length === 0 && plottedValueCount > 0,
    asOf: activeView === "history" ? data?.fred.termDate ?? null : activeView === "board" ? selected?.date ?? null : data?.curve.date ?? null,
    selectedIndexId: activeView === "board" ? selected?.id ?? null : null,
    plottedValueCount, unavailableSources, series, curve, rows };
}

export function useVolatilityEvidence(result: VolatilityLoadResult | null | undefined, view: string,
  selected: VolatilityBoardRow | null, loading: boolean): void {
  useRemoteUiNode({ role: "chart-data", label: "Rendered volatility index observations",
    getMetadata: () => ({ ...volatilitySemanticEvidence(result, view, selected, loading) }) });
}

/** Recount finite projections and check the plotted ratio against its dated legs. */
export function readVolatilityEvidence(value: unknown): VolatilityEvidence | null {
  if (!record(value) || value.kind !== "volatility-indices" || value.version !== 1
    || !["curve", "history", "board"].includes(String(value.view)) || typeof value.loading !== "boolean"
    || typeof value.stale !== "boolean" || typeof value.complete !== "boolean"
    || (value.asOf !== null && !dated(value.asOf)) || !Array.isArray(value.unavailableSources)
    || !value.unavailableSources.every((entry) => typeof entry === "string") || !Array.isArray(value.series)
    || !value.series.every((entry) => record(entry) && typeof entry.id === "string" && ["index points", "ratio"].includes(String(entry.unit))
      && Array.isArray(entry.points) && entry.points.every((point) => record(point) && dated(point.date)
        && (point.value === null || finite(point.value)))) || !Array.isArray(value.curve) || !Array.isArray(value.rows)) return null;
  const evidence = value as unknown as VolatilityEvidence;
  if (!evidence.rows.every((row) => record(row) && typeof row.id === "string" && typeof row.symbol === "string"
    && (row.value === null || finite(row.value)) && (row.date === null || dated(row.date))
    && finite(row.sampleSize) && row.sampleSize >= 0)) return null;
  if (evidence.view === "history") {
    if (evidence.series.length !== 3 || ["VIXCLS", "VXVCLS", "3M/30D"].some((id, index) => evidence.series[index]?.id !== id)) return null;
    const [front, back, ratios] = evidence.series;
    if (front!.points.length !== back!.points.length || front!.points.length !== ratios!.points.length) return null;
    if (!ratios!.points.every((point, index) => {
      const a = front!.points[index]!, b = back!.points[index]!;
      if (point.date !== a.date || point.date !== b.date) return false;
      return a.value == null || b.value == null ? point.value === null
        : a.value > 0 && point.value != null && Math.abs(point.value - b.value / a.value) < 1e-10;
    })) return null;
  } else if (evidence.view === "curve") {
    if (evidence.series.length !== 1 || evidence.series[0]?.id !== "curve" || !evidence.curve.length
      || evidence.curve.length !== evidence.series[0].points.length || !evidence.curve.every((point, index) => record(point)
        && finite(point.days) && point.days > 0 && (point.value === null || finite(point.value))
        && evidence.series[0]!.points[index]!.value === point.value)) return null;
  } else if (evidence.series.length > 1 || evidence.series.some((entry) => entry.id !== evidence.selectedIndexId)) return null;
  const count = evidence.series.reduce((sum, entry) => sum + entry.points.filter((point) => finite(point.value)).length, 0)
    + evidence.rows.filter((row) => finite(row.value)).length;
  if (count <= 0 || evidence.plottedValueCount !== count) return null;
  if (evidence.complete && (evidence.loading || evidence.stale || !evidence.asOf || evidence.unavailableSources.length > 0
    || (evidence.view === "curve" && evidence.curve.some((point) => point.value == null))
    || (evidence.view === "board" && evidence.rows.some((row) => row.value == null))
    || (evidence.view === "history" && evidence.series.some((entry) => !entry.points.some((point) => finite(point.value)))))) return null;
  return evidence;
}
