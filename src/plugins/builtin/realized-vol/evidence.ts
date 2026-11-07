import type { PaneScreenshotEvidenceHook } from "../../../cli/pane-functions/screenshot-evidence";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import type { ResolvedSeries } from "../../../time-series/types";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { isDateString, isFiniteNumber, isRecord, isStringArray } from "../../../utils/guards";
import { selectedWindows } from "./settings";

export interface RealizedVolEvidenceStatus {
  symbol: string;
  view: "graph" | "cone";
  estimator: string;
  windows: readonly number[];
  /** The cone window its chart legend reads; null on the history view. */
  legendWindow?: number | null;
  lookbackYears: number;
  showIv: boolean;
  loading: boolean;
  stale: boolean;
  source: string | null;
  asOf: string | null;
  errors: string[];
  /** The errors that are the current IV's alone: a chart missing only its IV point names that, not the symbol. */
  ivErrors?: string[];
  /** The windows the history is too short for: their series have no values, and the capture is whole without them. */
  shortWindows?: number[];
  currentIv: { value: number; date: string; label: string; source: string | null; expiration: number } | null;
  /**
   * An FX pair or currency future: it has no option chain, so no ATM IV is
   * missing from a whole capture. The currency fund's IV30 that stands in is
   * the IV point drawn, when there is one (`proxyIv`, in percent).
   */
  fxPair?: boolean;
  proxyIv?: { fund: string; value: number; date: string } | null;
}

/** The IV point the history view draws: the ATM IV, or for an FX pair the proxy fund's IV30. */
function ivPoint(status: Pick<RealizedVolEvidenceStatus, "showIv" | "currentIv" | "proxyIv">): { value: number; date: string } | null {
  return status.showIv ? status.currentIv ?? status.proxyIv ?? null : null;
}

/** Whether a capture still needs an ATM IV it does not have; an FX pair never has one. */
const missingIv = (status: Pick<RealizedVolEvidenceStatus, "showIv" | "currentIv" | "fxPair">) =>
  status.showIv && status.currentIv == null && status.fxPair !== true;

/** A series a short history leaves without values: a selected window it is too short for. */
function shortSeries(id: string, shortWindows: readonly number[] | undefined): boolean {
  return /^hv-\d+$/.test(id) && (shortWindows ?? []).includes(Number(id.slice(3)));
}

export interface RealizedVolEvidence extends RealizedVolEvidenceStatus {
  kind: "realized-volatility";
  version: 1;
  complete: boolean;
  plottedValueCount: number;
  series: Array<{ id: string; unit: string; points: Array<{ date: string; value: number | null }> }>;
}

/** The same resolved series passed to CompositeChart supplies the capture evidence. */
export function realizedVolSemanticEvidence(series: readonly ResolvedSeries[], status: RealizedVolEvidenceStatus): RealizedVolEvidence {
  const plotted = series.map((entry) => ({ id: entry.id, unit: entry.unit,
    points: entry.points.map((point) => ({ date: point.date.toISOString(), value: isFiniteNumber(point.value) ? point.value : null })),
  }));
  const plottedValueCount = plotted.reduce((sum, entry) => sum + entry.points.filter((point) => isFiniteNumber(point.value)).length, 0);
  return { ...status, kind: "realized-volatility", version: 1, series: plotted, plottedValueCount,
    complete: !status.loading && !status.stale && status.errors.length === 0 && !!status.asOf
      && plotted.length > 0 && plotted.some((entry) => entry.points.some((point) => isFiniteNumber(point.value)))
      && plotted.every((entry) => shortSeries(entry.id, status.shortWindows) || entry.points.some((point) => isFiniteNumber(point.value)))
      && !missingIv(status),
  };
}

export function useRealizedVolEvidence(series: readonly ResolvedSeries[], status: RealizedVolEvidenceStatus): void {
  useRemoteUiNode({ role: "chart-data", label: "Rendered realized volatility observations",
    getMetadata: () => ({ ...realizedVolSemanticEvidence(series, status), ready: !status.loading }) });
}

/** Recount actual observations; a canvas or asserted count alone cannot certify a capture. */
function readRealizedVolEvidence(value: unknown): RealizedVolEvidence | null {
  if (!isRecord(value) || value.kind !== "realized-volatility" || value.version !== 1
    || typeof value.symbol !== "string" || !value.symbol || !["graph", "cone"].includes(String(value.view))
    || typeof value.estimator !== "string" || !Array.isArray(value.windows) || !value.windows.every(isFiniteNumber)
    || !isFiniteNumber(value.lookbackYears) || typeof value.showIv !== "boolean" || typeof value.complete !== "boolean"
    || typeof value.loading !== "boolean" || typeof value.stale !== "boolean" || !isDateString(value.asOf)
    || !isStringArray(value.errors)
    || (value.shortWindows !== undefined && (!Array.isArray(value.shortWindows) || !value.shortWindows.every(isFiniteNumber)))
    || (value.ivErrors !== undefined && !isStringArray(value.ivErrors))
    || (value.fxPair !== undefined && typeof value.fxPair !== "boolean")
    || (value.proxyIv != null && (!isRecord(value.proxyIv) || typeof value.proxyIv.fund !== "string"
      || !isFiniteNumber(value.proxyIv.value) || !isDateString(value.proxyIv.date)))
    || !Array.isArray(value.series) || !value.series.every((entry) => isRecord(entry) && typeof entry.id === "string"
      && typeof entry.unit === "string" && Array.isArray(entry.points) && entry.points.every((point) => isRecord(point)
        && isDateString(point.date) && (point.value === null || isFiniteNumber(point.value))))) return null;
  const evidence = value as unknown as RealizedVolEvidence;
  // The IV point is drawn only when there is one: a chart without it matches its data, and is incomplete for it.
  const point = ivPoint(evidence);
  const required = evidence.view === "graph" ? [...evidence.windows.map((window) => `hv-${window}`), "price",
    ...(point ? ["current-iv"] : [])] : ["min", "max", "mean", "current"];
  if (!required.length || (evidence.view === "graph" && !evidence.windows.length)
    || evidence.series.length !== required.length || new Set(evidence.series.map((entry) => entry.id)).size !== required.length
    || required.some((id) => !evidence.series.some((entry) => entry.id === id))) return null;
  const count = evidence.series.reduce((sum, entry) => sum + entry.points.filter((point) => isFiniteNumber(point.value)).length, 0);
  if (count <= 0 || count !== evidence.plottedValueCount) return null;
  if (evidence.currentIv != null && (!isRecord(evidence.currentIv) || !isFiniteNumber(evidence.currentIv.value)
    || !isDateString(evidence.currentIv.date) || !isFiniteNumber(evidence.currentIv.expiration))) return null;
  if (evidence.view === "graph" && point) {
    const points = evidence.series.find((entry) => entry.id === "current-iv")!.points;
    if (points.length !== 1 || points[0]!.date !== point.date || points[0]!.value !== point.value) return null;
  }
  if (evidence.complete && (evidence.loading || evidence.stale || evidence.errors.length > 0
    || missingIv(evidence)
    || evidence.series.some((entry) => !shortSeries(entry.id, evidence.shortWindows) && !entry.points.some((point) => isFiniteNumber(point.value))))) return null;
  return evidence;
}

/** Drawn, current and whole but for the current IV, whose errors are the only ones. */
function missingOnlyIv(evidence: RealizedVolEvidence): boolean {
  const ivErrors = new Set(evidence.ivErrors ?? []);
  return evidence.view === "graph" && missingIv(evidence)
    && !evidence.loading && !evidence.stale && evidence.plottedValueCount > 0
    && evidence.errors.every((error) => ivErrors.has(error))
    && evidence.series.every((entry) => shortSeries(entry.id, evidence.shortWindows) || entry.points.some((point) => isFiniteNumber(point.value)));
}

export const realizedVolScreenshotEvidence: PaneScreenshotEvidenceHook<RealizedVolEvidence> = {
  paneId: "realized-vol",
  kind: "realized-volatility",
  label: "realized-volatility",
  read: readRealizedVolEvidence,
  mismatches(evidence, { resolved, payload }) {
    const mismatches: string[] = [];
    const symbol = payload.financials[0]?.[0] ?? resolved.createOptions?.symbol;
    const settings = { ...resolved.instance?.settings, ...resolved.options };
    if (symbol && evidence.symbol !== parsePublicTickerKey(symbol).symbol) mismatches.push("rendered realized volatility symbol does not match");
    if (evidence.view !== (settings.tab ?? settings.initialView ?? "graph")) mismatches.push("rendered realized volatility view does not match");
    if (evidence.estimator !== (settings.estimator ?? "close-to-close")) mismatches.push("rendered realized volatility estimator does not match");
    if (evidence.lookbackYears !== Number(settings.lookbackYears ?? 1)) mismatches.push("rendered realized volatility lookback does not match");
    if (evidence.showIv !== (settings.showIv !== false)) mismatches.push("rendered realized volatility IV selection does not match");
    if (evidence.windows.join(",") !== selectedWindows(settings.windows).join(",")) mismatches.push("rendered realized volatility windows do not match");
    return mismatches;
  },
  unavailable(evidence, { resolved, payload }) {
    const symbol = payload.financials[0]?.[0] ?? resolved.createOptions?.symbol;
    if (evidence?.complete && !evidence.loading) return [];
    // The volatility drawn whole and only the IV point missing: the capture names the IV, not the symbol.
    if (evidence && missingOnlyIv(evidence)) return [`${symbol ?? evidence.symbol} current ATM IV`];
    return [symbol ?? "realized volatility"];
  },
};
