import type { CloudFredObservationPayload, CloudFredSeriesInfoPayload } from "../../../api-client";
import type { PricePoint } from "../../../types/financials";

export const VOLATILITY_SERIES = [
  { seriesId: "VIXCLS", label: "VIX", tenor: "30D", days: 30 },
  { seriesId: "VXVCLS", label: "VIX 3M", tenor: "3M", days: 93 },
] as const;
export type VolatilitySeriesId = typeof VOLATILITY_SERIES[number]["seriesId"];
export type TermState = "normal" | "inverted" | "flat" | "partial";
export const VOLATILITY_CURVE_INDICES = [
  { id: "vix9d", symbol: "^VIX9D", label: "VIX 9D", tenor: "9D", days: 9 },
  { id: "vix", symbol: "^VIX", label: "VIX", tenor: "30D", days: 30 },
  { id: "vix3m", symbol: "^VIX3M", label: "VIX 3M", tenor: "3M", days: 93 },
  { id: "vix6m", symbol: "^VIX6M", label: "VIX 6M", tenor: "6M", days: 184 },
  { id: "vix1y", symbol: "^VIX1Y", label: "VIX 1Y", tenor: "1Y", days: 366 },
] as const;
export const VOLATILITY_BOARD_INDICES = [
  { id: "vvix", symbol: "^VVIX", label: "VVIX" },
  { id: "skew", symbol: "^SKEW", label: "SKEW" },
  { id: "move", symbol: "^MOVE", label: "MOVE" },
  { id: "vxn", symbol: "^VXN", label: "Nasdaq 100" },
  { id: "rvx", symbol: "^RVX", label: "Russell 2000" },
  { id: "ovx", symbol: "^OVX", label: "Oil" },
  { id: "gvz", symbol: "^GVZ", label: "Gold" },
  { id: "evz", symbol: "^EVZ", label: "Euro FX" },
  { id: "vxeem", symbol: "^VXEEM", label: "Emerging markets" },
  { id: "vxewz", symbol: "^VXEWZ", label: "Brazil" },
  { id: "vxapl", symbol: "^VXAPL", label: "Apple" },
  { id: "vxazn", symbol: "^VXAZN", label: "Amazon" },
  { id: "vxgog", symbol: "^VXGOG", label: "Alphabet" },
  { id: "vxgs", symbol: "^VXGS", label: "Goldman Sachs" },
  { id: "vxibm", symbol: "^VXIBM", label: "IBM" },
  // CBOE S&P 500 implied correlation: daily closes come from Cloud (CBOE history), not Yahoo's single print.
  { id: "cor1m", symbol: "^COR1M", label: "S&P 500 corr 1M" },
  { id: "cor3m", symbol: "^COR3M", label: "S&P 500 corr 3M" },
] as const;
/** Board rows sourced from Cloud's CBOE implied correlation history. */
export const IMPLIED_CORRELATION_ROWS = { cor1m: "COR1M", cor3m: "COR3M" } as const;
export const VOLATILITY_INDICES = [...VOLATILITY_CURVE_INDICES, ...VOLATILITY_BOARD_INDICES] as const;
export type VolatilityIndexId = typeof VOLATILITY_INDICES[number]["id"];

export interface VolatilityHistoryPoint { date: string; observedAt: string; value: number }
export interface VolatilityHistoryInput {
  history: readonly PricePoint[];
  source: string | null;
  stale?: boolean;
  error?: string | null;
  fetchedAt?: number | null;
}
export interface VolatilitySeriesInput {
  observations: CloudFredObservationPayload[];
  info: CloudFredSeriesInfoPayload | null;
  stale?: boolean;
  error?: string | null;
  fetchedAt?: number | null;
}
export interface VolatilityInputs {
  history?: Partial<Record<VolatilityIndexId, VolatilityHistoryInput>>;
  fred?: Partial<Record<VolatilitySeriesId, VolatilitySeriesInput>>;
}
export interface VolatilityMetric {
  seriesId: VolatilitySeriesId;
  label: string;
  tenor: string;
  title: string;
  value: number | null;
  date: string | null;
  history: VolatilityHistoryPoint[];
  /** Explicit rejected/withdrawn observations remain chart gaps. */
  missingDates: string[];
  /** Metadata coverage can lag the actual observations. */
  observationEnd: string | null;
  stale: boolean;
  error: string | null;
}
export interface FredVolatilityHistory {
  metrics: VolatilityMetric[];
  termDate: string | null;
  ratio: number | null;
  slope: number | null;
  ratioHistory: Array<{ date: string; value: number }>;
  termState: TermState;
  warnings: string[];
}
export interface VolatilityCurvePoint {
  id: string;
  label: string;
  tenor: string;
  days: number;
  value: number | null;
  source: string | null;
  sourceId: string;
}
export interface VolatilityCurve {
  source: "market-history" | "fred";
  date: string | null;
  points: VolatilityCurvePoint[];
  ratio: number | null;
  /** Midpoint rank of the current 3M/30D ratio within the trailing year of FRED daily ratios. */
  ratioPercentile1y: number | null;
  ratioSampleSize: number;
  slope: number | null;
  termState: TermState;
  warnings: string[];
}
export interface VolatilityBoardRow {
  id: VolatilityIndexId;
  symbol: string;
  label: string;
  unit: "index points";
  value: number | null;
  date: string | null;
  source: string | null;
  previousDate: string | null;
  change1d: number | null;
  change1dPercent: number | null;
  percentile1y: number | null;
  sampleSize: number;
  coverageDays: number;
  history: VolatilityHistoryPoint[];
  missingDates: string[];
  status: "available" | "limited" | "unavailable";
  stale: boolean;
  error: string | null;
  warnings: string[];
  /** End of the FRED series, not a claim about CBOE publication. */
  publicationEnd?: string;
}
export interface VolatilityData {
  curve: VolatilityCurve;
  fred: FredVolatilityHistory;
  board: VolatilityBoardRow[];
  warnings: string[];
}

const DAY_MS = 86_400_000;
function validDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date;
}
interface NormalizedHistory {
  history: VolatilityHistoryPoint[];
  rows: Array<{ date: string; observedAt: string; value: number | null }>;
  warnings: string[];
}
/** Last supplied corrections win, including a correction that withdraws a value. */
function normalizeHistory(observations: readonly { date: Date | string; value: number | null | undefined }[], dateOnly = false): NormalizedHistory {
  const days = new Map<string, { date: string; observedAt: string; value: number | null }>();
  let invalidDates = false;
  for (const observation of observations) {
    const raw = observation.date;
    if (!(raw instanceof Date) && typeof raw !== "string") { invalidDates = true; continue; }
    const suppliedDate = typeof raw === "string" ? raw.slice(0, 10) : null;
    const time = new Date(raw).getTime();
    if (!Number.isFinite(time) || (suppliedDate != null && !validDate(suppliedDate))
      || (dateOnly && (typeof raw !== "string" || !validDate(raw)))) { invalidDates = true; continue; }
    const observedAt = new Date(time).toISOString();
    const date = observedAt.slice(0, 10);
    const value = observation.value != null && Number.isFinite(observation.value) && observation.value > 0 ? observation.value : null;
    days.set(date, { date, observedAt, value });
  }
  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { rows, history: rows.flatMap((row) => row.value == null ? [] : [{ ...row, value: row.value }]),
    warnings: [...(invalidDates ? ["Malformed observation dates rejected"] : []),
      ...(rows.some((row) => row.value == null) ? ["Nonpositive or missing closes rejected"] : [])] };
}
export function classifyTermState(spot: number | null, threeMonth: number | null): TermState {
  if (spot == null || threeMonth == null || !(spot > 0)) return "partial";
  return threeMonth > spot ? "normal" : threeMonth < spot ? "inverted" : "flat";
}
function fredHistory(inputs: VolatilityInputs["fred"]): FredVolatilityHistory {
  const warnings: string[] = [];
  const metrics = VOLATILITY_SERIES.map((definition): VolatilityMetric => {
    const input = inputs?.[definition.seriesId];
    const normalized = normalizeHistory(input?.observations ?? [], true);
    warnings.push(...normalized.warnings.map((warning) => `${definition.seriesId}: ${warning}`));
    if (input?.error) warnings.push(`${definition.seriesId}: ${input.error}`);
    if (input?.stale) warnings.push(`${definition.seriesId}: cached source is stale`);
    const latest = normalized.history.at(-1);
    return { ...definition, title: input?.info?.title ?? definition.label, value: latest?.value ?? null,
      date: latest?.date ?? null, history: normalized.history,
      missingDates: normalized.rows.filter((row) => row.value == null).map((row) => row.date),
      observationEnd: input?.info?.observationEnd ?? null,
      stale: input?.stale ?? false, error: input?.error ?? null };
  });
  const spot = new Map(metrics[0]!.history.map((point) => [point.date, point.value]));
  const ratioHistory = metrics[1]!.history.flatMap((point) => {
    const value = spot.get(point.date);
    return value == null ? [] : [{ date: point.date, value: point.value / value }];
  });
  const latest = ratioHistory.at(-1);
  const termDate = latest?.date ?? null;
  const front = termDate ? spot.get(termDate)! : null;
  const back = termDate ? metrics[1]!.history.find((point) => point.date === termDate)!.value : null;
  return { metrics, termDate, ratio: latest?.value ?? null, slope: front != null && back != null ? back - front : null,
    ratioHistory, termState: classifyTermState(front, back), warnings };
}
/** Declared order (tenor curve, then broad and asset-class indices, then single names), with unavailable rows last. */
export function boardOrder(rows: readonly VolatilityBoardRow[]): VolatilityBoardRow[] {
  const rank = new Map(VOLATILITY_INDICES.map((definition, index) => [definition.id, index]));
  return [...rows].sort((left, right) => {
    const missing = Number(left.value == null) - Number(right.value == null);
    return missing || (rank.get(left.id) ?? 0) - (rank.get(right.id) ?? 0);
  });
}

function midpointPercentile(values: readonly number[], current: number): number {
  return 100 * (values.filter((value) => value < current).length + 0.5 * values.filter((value) => value === current).length) / values.length;
}

function ratioPercentile(fred: FredVolatilityHistory, ratio: number | null, date: string | null): { percentile: number | null; sampleSize: number } {
  if (ratio == null || date == null) return { percentile: null, sampleSize: 0 };
  const cutoff = calendarYearCutoff(date);
  const window = fred.ratioHistory.filter((point) => Date.parse(point.date) > cutoff && point.date <= date);
  const coverageDays = window.length > 1 ? (Date.parse(window.at(-1)!.date) - Date.parse(window[0]!.date)) / DAY_MS : 0;
  return { percentile: window.length >= 200 && coverageDays >= 300 ? midpointPercentile(window.map((point) => point.value), ratio) : null,
    sampleSize: window.length };
}

function calendarYearCutoff(date: string): number {
  const cutoff = new Date(date);
  const month = cutoff.getUTCMonth();
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  if (cutoff.getUTCMonth() !== month) cutoff.setUTCDate(0);
  return cutoff.getTime();
}
function boardRow(definition: typeof VOLATILITY_INDICES[number], input: VolatilityHistoryInput | undefined): VolatilityBoardRow {
  const normalized = normalizeHistory((input?.history ?? []).map((point) => ({ date: point.date, value: point.close })));
  const latest = normalized.history.at(-1);
  const latestIndex = latest ? normalized.rows.findIndex((row) => row.date === latest.date) : -1;
  const previous = latestIndex > 0 ? normalized.rows[latestIndex - 1] : null;
  // Without an exchange calendar, a long source gap cannot establish a 1D change.
  const adjacent = !!latest && previous?.value != null && Date.parse(latest.date) - Date.parse(previous.date) <= 4 * DAY_MS;
  const change1d = adjacent ? latest!.value - previous!.value! : null;
  const cutoff = latest ? calendarYearCutoff(latest.date) : 0;
  const history = normalized.history.filter((point) => Date.parse(point.date) > cutoff);
  const coverageDays = history.length > 1 ? (Date.parse(history.at(-1)!.date) - Date.parse(history[0]!.date)) / DAY_MS : 0;
  const broadCoverage = history.length >= 200 && coverageDays >= 300;
  const percentile1y = latest && broadCoverage ? midpointPercentile(history.map((point) => point.value), latest.value) : null;
  const warnings = [...normalized.warnings];
  if (latest && latest.date !== normalized.rows.at(-1)?.date) warnings.push("Latest supplied close unavailable; showing last valid observation");
  if (latest && !adjacent) warnings.push("1D change unavailable: previous daily close missing or too far apart");
  if (latest && !broadCoverage) warnings.push(`1Y percentile unavailable: ${history.length} observations across ${coverageDays} days`);
  if (input?.stale) warnings.push("Cached daily history is stale");
  if (input?.error) warnings.push(input.error);
  if (definition.id === "evz") warnings.push("FRED EVZCLS discontinued after 2025-03-11");
  return { ...definition, unit: "index points", value: latest?.value ?? null, date: latest?.date ?? null,
    source: input?.source ?? null, previousDate: previous?.date ?? null, change1d,
    change1dPercent: change1d != null ? change1d / previous!.value! * 100 : null,
    percentile1y, sampleSize: history.length, coverageDays, history,
    missingDates: normalized.rows.filter((row) => row.value == null && Date.parse(row.date) > cutoff).map((row) => row.date),
    status: !latest ? "unavailable" : warnings.length > 0 ? "limited" : "available",
    stale: input?.stale ?? false, error: input?.error ?? null, warnings,
    ...(definition.id === "evz" ? { publicationEnd: "2025-03-11" } : {}) };
}
function alignedCurve(board: readonly VolatilityBoardRow[], fred: FredVolatilityHistory): VolatilityCurve {
  const rows = VOLATILITY_CURVE_INDICES.map((definition) => board.find((row) => row.id === definition.id)!);
  const front = rows[1]!, back = rows[2]!;
  if (front.history.length === 0 && back.history.length === 0 && fred.termDate != null) {
    const context = ratioPercentile(fred, fred.ratio, fred.termDate);
    return { source: "fred", date: fred.termDate, points: VOLATILITY_SERIES.map((definition, index) => ({
      id: index === 0 ? "vix" : "vix3m", label: definition.label, tenor: definition.tenor, days: definition.days,
      value: fred.metrics[index]!.history.find((point) => point.date === fred.termDate)?.value ?? null,
      source: "fred", sourceId: definition.seriesId,
    })), ratio: fred.ratio, ratioPercentile1y: context.percentile, ratioSampleSize: context.sampleSize, slope: fred.slope, termState: fred.termState,
    warnings: ["Market-history VIX core unavailable; showing the aligned FRED 30D/3M pair", ...fred.warnings] };
  }
  const frontDates = new Set(front.history.map((point) => point.date));
  let date = back.history.filter((point) => frontDates.has(point.date)).at(-1)?.date ?? null;
  if (date == null) {
    const counts = new Map<string, number>();
    for (const row of rows) for (const point of row.history) counts.set(point.date, (counts.get(point.date) ?? 0) + 1);
    date = [...counts.entries()].filter(([, count]) => count >= 2).map(([day]) => day).sort().at(-1)
      ?? [...counts.keys()].sort().at(-1) ?? null;
  }
  const points = VOLATILITY_CURVE_INDICES.map((definition, index): VolatilityCurvePoint => ({
    ...definition, sourceId: definition.symbol, source: rows[index]!.source,
    value: rows[index]!.history.find((point) => point.date === date)?.value ?? null,
  }));
  const spot = points[1]!.value, threeMonth = points[2]!.value;
  const warnings = points.flatMap((point, index) => [
    ...(point.value == null ? [`${point.label}: no close aligned to ${date ?? "a common date"}`] : []),
    ...(point.value != null && rows[index]!.stale ? [`${point.label}: aligned close is from stale cached history`] : []),
  ]);
  const ratio = spot != null && threeMonth != null ? threeMonth / spot : null;
  const context = ratioPercentile(fred, ratio, date);
  return { source: "market-history", date, points, ratio, ratioPercentile1y: context.percentile, ratioSampleSize: context.sampleSize,
    slope: spot != null && threeMonth != null ? threeMonth - spot : null,
    termState: classifyTermState(spot, threeMonth), warnings };
}

/** An index level observed by the quote stream, in index points at a millisecond instant. */
export interface VolatilityLiveLevel { value: number; observedAt: number }

/**
 * Today's streamed level becomes the latest observation of its index history,
 * so the level, the change against the previous close, the curve and the
 * one-year percentile read it exactly as they read a daily close (it replaces
 * a provisional bar for the same date). A level older than the latest close
 * is ignored. The CBOE correlation rows keep their published daily closes.
 */
export function withLiveVolatilityLevels(
  inputs: VolatilityInputs,
  levels: ReadonlyMap<VolatilityIndexId, VolatilityLiveLevel>,
): VolatilityInputs {
  if (levels.size === 0) return inputs;
  const history = { ...inputs.history };
  for (const [id, level] of levels) {
    if (id in IMPLIED_CORRELATION_ROWS || !(level.value > 0) || !Number.isFinite(level.value) || !Number.isFinite(level.observedAt)) continue;
    const input = history[id];
    const points = input?.history ?? [];
    const latest = points.reduce((max, point) => Math.max(max, new Date(point.date).getTime()), Number.NEGATIVE_INFINITY);
    const observed = new Date(level.observedAt);
    if (Number.isFinite(latest) && observed.toISOString().slice(0, 10) < new Date(latest).toISOString().slice(0, 10)) continue;
    history[id] = { source: input?.source ?? null, fetchedAt: input?.fetchedAt ?? null, stale: input?.stale, error: input?.error ?? null,
      ...input, history: [...points, { date: observed, close: level.value }] };
  }
  return { ...inputs, history };
}

/** Curve values share one date and source family; board rows keep their own dates. */
export function buildVolatilityData(inputs: VolatilityInputs): VolatilityData {
  const fred = fredHistory(inputs.fred);
  const board = VOLATILITY_INDICES.map((definition) => boardRow(definition, inputs.history?.[definition.id]));
  const curve = alignedCurve(board, fred);
  return { curve, fred, board, warnings: [...new Set([...curve.warnings, ...fred.warnings,
    ...board.flatMap((row) => row.warnings.map((warning) => `${row.label}: ${warning}`))])] };
}
