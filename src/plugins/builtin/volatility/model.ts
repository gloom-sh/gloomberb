import { PERIOD_BASE_MAX_GAP_DAYS, periodBaseDay } from "../../../market-data/market/period-return";
import type { CloudFredObservationPayload, CloudFredSeriesInfoPayload } from "../../../api-client";
import type { PricePoint } from "../../../types/financials";
import { VOLATILITY_CURVE_INDICES, VOLATILITY_INDICES } from "../shared/volatility-indices";

export const VOLATILITY_SERIES = [
  { seriesId: "VIXCLS", label: "VIX", tenor: "30D", days: 30 },
  { seriesId: "VXVCLS", label: "VIX 3M", tenor: "3M", days: 93 },
] as const;
export type VolatilitySeriesId = typeof VOLATILITY_SERIES[number]["seriesId"];
/** The curve's shape from VIX to VIX 3M; partial when either close is missing. */
export type TermState = "contango" | "backwardation" | "flat" | "partial";
const TERM_STATE_LABELS: Readonly<Record<Exclude<TermState, "partial">, string>> = {
  contango: "Contango", backwardation: "Backwardation", flat: "Flat",
};
/** The one word the pane, the report and the glossary use for a curve's shape; null when it has none. */
export function termStateLabel(state: TermState): string | null {
  return state === "partial" ? null : TERM_STATE_LABELS[state];
}
/** Who published the closes a ratio was read from: Cboe's own, or FRED's republished copy. */
type VolatilityPublisher = "Cboe" | "FRED";
/** Board rows sourced from Cloud's CBOE implied correlation history. */
export const IMPLIED_CORRELATION_ROWS = { cor1m: "COR1M", cor3m: "COR3M" } as const;
export type VolatilityIndexId = typeof VOLATILITY_INDICES[number]["id"];

interface VolatilityHistoryPoint { date: string; observedAt: string; value: number }
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
interface VolatilityMetric {
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
interface FredVolatilityHistory {
  metrics: VolatilityMetric[];
  termDate: string | null;
  ratio: number | null;
  slope: number | null;
  ratioHistory: Array<{ date: string; value: number }>;
  termState: TermState;
  warnings: string[];
}
interface VolatilityTermLeg {
  id: "vix" | "vix3m";
  label: string;
  history: Array<{ date: string; value: number }>;
  /** Dates a publisher withdrew or rejected, kept as chart gaps. */
  missingDates: string[];
}
/**
 * VIX and VIX 3M with their 3M/30D ratio, each date read from one publisher:
 * Cboe's daily closes (the board's, with any streamed level for today) where
 * it has both, FRED's republished closes on the dates Cboe lacks, such as
 * before the board's year. The curve and this history end on the same date.
 */
export interface VolatilityTermHistory {
  legs: [VolatilityTermLeg, VolatilityTermLeg];
  ratioHistory: Array<{ date: string; value: number; publisher: VolatilityPublisher }>;
  termDate: string | null;
  ratio: number | null;
  slope: number | null;
  termState: TermState;
  /** Who published the closes of the latest ratio. */
  publisher: VolatilityPublisher | null;
  /** The latest ratio rests on cached closes a refresh could not replace. */
  stale: boolean;
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
  /** Midpoint rank of the current 3M/30D ratio within the trailing year of the ratio history. */
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
}
export interface VolatilityData {
  curve: VolatilityCurve;
  fred: FredVolatilityHistory;
  term: VolatilityTermHistory;
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
  // A null value is a source placeholder (FRED's "." on a holiday): a gap, not a rejected close.
  const rejected = new Set<string>();
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
    if (value == null && observation.value != null) rejected.add(date);
    else rejected.delete(date);
    days.set(date, { date, observedAt, value });
  }
  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { rows, history: rows.flatMap((row) => row.value == null ? [] : [{ ...row, value: row.value }]),
    warnings: [...(invalidDates ? ["Malformed observation dates rejected"] : []),
      ...(rejected.size > 0 ? ["Nonpositive or invalid closes rejected"] : [])] };
}
function classifyTermState(spot: number | null, threeMonth: number | null): TermState {
  if (spot == null || threeMonth == null || !(spot > 0)) return "partial";
  return threeMonth > spot ? "contango" : threeMonth < spot ? "backwardation" : "flat";
}
interface TermSource {
  publisher: VolatilityPublisher;
  legs: [ReadonlyMap<string, number>, ReadonlyMap<string, number>];
  missing: [readonly string[], readonly string[]];
  stale: boolean;
}
/** One publisher per date, so a ratio never divides one publisher's close by another's. */
function termHistory(sources: readonly TermSource[]): VolatilityTermHistory {
  const dates = [...new Set(sources.flatMap((source) => source.legs.flatMap((leg) => [...leg.keys()])))].sort();
  const legs: VolatilityTermHistory["legs"] = [
    { id: "vix", label: "VIX", history: [], missingDates: [] },
    { id: "vix3m", label: "VIX 3M", history: [], missingDates: [] },
  ];
  const ratioHistory: VolatilityTermHistory["ratioHistory"] = [];
  const chosen = new Map<string, TermSource>();
  for (const date of dates) {
    const source = sources.find((candidate) => candidate.legs.every((leg) => leg.has(date)))
      ?? sources.find((candidate) => candidate.legs.some((leg) => leg.has(date)))!;
    chosen.set(date, source);
    const [spot, threeMonth] = source.legs.map((leg) => leg.get(date));
    if (spot != null) legs[0].history.push({ date, value: spot });
    if (threeMonth != null) legs[1].history.push({ date, value: threeMonth });
    if (spot != null && threeMonth != null) ratioHistory.push({ date, value: threeMonth / spot, publisher: source.publisher });
  }
  legs.forEach((leg, index) => {
    const shown = new Set(leg.history.map((point) => point.date));
    leg.missingDates = [...new Set(sources.flatMap((source) => source.missing[index]!))].filter((date) => !shown.has(date)).sort();
  });
  const latest = ratioHistory.at(-1);
  const source = latest ? chosen.get(latest.date)! : null;
  const front = latest ? source!.legs[0].get(latest.date)! : null;
  const back = latest ? source!.legs[1].get(latest.date)! : null;
  return { legs, ratioHistory, termDate: latest?.date ?? null, ratio: latest?.value ?? null,
    slope: front != null && back != null ? back - front : null, termState: classifyTermState(front, back),
    publisher: latest?.publisher ?? null, stale: source?.stale ?? false };
}
function boardTermSource(spot: VolatilityBoardRow | undefined, threeMonth: VolatilityBoardRow | undefined): TermSource {
  const days = (row: VolatilityBoardRow | undefined) => new Map((row?.history ?? []).map((point) => [point.date, point.value]));
  return { publisher: "Cboe", legs: [days(spot), days(threeMonth)], missing: [spot?.missingDates ?? [], threeMonth?.missingDates ?? []],
    stale: !!spot?.stale || !!threeMonth?.stale };
}
function fredTermSource(fred: FredVolatilityHistory): TermSource {
  const [spot, threeMonth] = fred.metrics;
  return { publisher: "FRED", legs: [new Map(spot!.history.map((point) => [point.date, point.value])),
    new Map(threeMonth!.history.map((point) => [point.date, point.value]))],
  missing: [spot!.missingDates, threeMonth!.missingDates], stale: fred.metrics.some((metric) => metric.stale) };
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

function ratioPercentile(term: VolatilityTermHistory, ratio: number | null, date: string | null): { percentile: number | null; sampleSize: number } {
  if (ratio == null || date == null) return { percentile: null, sampleSize: 0 };
  const cutoff = calendarYearCutoff(date);
  const window = term.ratioHistory.filter((point) => Date.parse(point.date) > cutoff && point.date <= date);
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
  return { ...definition, unit: "index points", value: latest?.value ?? null, date: latest?.date ?? null,
    source: input?.source ?? null, previousDate: previous?.date ?? null, change1d,
    change1dPercent: change1d != null ? change1d / previous!.value! * 100 : null,
    percentile1y, sampleSize: history.length, coverageDays, history,
    missingDates: normalized.rows.filter((row) => row.value == null && Date.parse(row.date) > cutoff).map((row) => row.date),
    status: !latest ? "unavailable" : warnings.length > 0 ? "limited" : "available",
    stale: input?.stale ?? false, error: input?.error ?? null, warnings };
}
function alignedCurve(board: readonly VolatilityBoardRow[], fred: FredVolatilityHistory, term: VolatilityTermHistory): VolatilityCurve {
  const rows = VOLATILITY_CURVE_INDICES.map((definition) => board.find((row) => row.id === definition.id)!);
  const front = rows[1]!, back = rows[2]!;
  if (front.history.length === 0 && back.history.length === 0 && fred.termDate != null) {
    const context = ratioPercentile(term, fred.ratio, fred.termDate);
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
  const context = ratioPercentile(term, ratio, date);
  return { source: "market-history", date, points, ratio, ratioPercentile1y: context.percentile, ratioSampleSize: context.sampleSize,
    slope: spot != null && threeMonth != null ? threeMonth - spot : null,
    termState: classifyTermState(spot, threeMonth), warnings };
}

export type VolatilityLookbackId = "1W" | "1M";

/** The curve's tenors on one earlier date: a week or a calendar month before the curve's own. */
export interface VolatilityCurveLookback {
  id: VolatilityLookbackId;
  date: string | null;
  values: Partial<Record<string, number>>;
}

/** A week back is seven calendar days; a month back is the same day of the previous month, or its last day (periodBaseDay). */
export function volatilityLookbackDate(date: string, id: VolatilityLookbackId): string {
  return periodBaseDay(date, id);
}

/**
 * The curve a week and a month before its date, read from the same daily
 * histories and aligned the same way: the last date on or before the look-back
 * where the 30D and 3M both closed, else where two tenors did, within a market closure of it (PERIOD_BASE_MAX_GAP_DAYS).
 * A tenor without a close on that date is a gap, never a neighbouring day.
 */
export function volatilityCurveLookbacks(data: Pick<VolatilityData, "curve" | "board" | "fred">): VolatilityCurveLookback[] {
  const { curve } = data;
  if (!curve.date) return [];
  const histories = new Map<string, ReadonlyMap<string, number>>(curve.points.map((point) => {
    const history = curve.source === "fred"
      ? data.fred.metrics.find((metric) => metric.seriesId === point.sourceId)?.history
      : data.board.find((row) => row.id === point.id)?.history;
    return [point.id, new Map((history ?? []).map((entry) => [entry.date, entry.value]))];
  }));
  return (["1W", "1M"] as const).map((id) => {
    const target = volatilityLookbackDate(curve.date!, id);
    const floor = new Date(Date.parse(target) - PERIOD_BASE_MAX_GAP_DAYS * DAY_MS).toISOString().slice(0, 10);
    const counts = new Map<string, number>();
    for (const history of histories.values()) for (const day of history.keys()) {
      if (day >= floor && day <= target) counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    const days = [...counts.keys()].sort().toReversed();
    const front = histories.get("vix"), back = histories.get("vix3m");
    const date = days.find((day) => front?.has(day) && back?.has(day))
      ?? days.find((day) => counts.get(day)! >= 2) ?? days[0] ?? null;
    const values: Partial<Record<string, number>> = {};
    if (date) for (const [pointId, history] of histories) {
      const value = history.get(date);
      if (value != null) values[pointId] = value;
    }
    return { id, date, values };
  });
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

/** The 3M/30D ratio's history alone, read as `buildVolatilityData` reads it, for a chart of the ratio. */
export function buildVolatilityTermHistory(inputs: VolatilityInputs): VolatilityTermHistory {
  const [spot, threeMonth] = (["vix", "vix3m"] as const).map((id) =>
    boardRow(VOLATILITY_INDICES.find((definition) => definition.id === id)!, inputs.history?.[id]));
  return termHistory([boardTermSource(spot, threeMonth), fredTermSource(fredHistory(inputs.fred))]);
}

/** Curve values share one date and source family; board rows keep their own dates. */
export function buildVolatilityData(inputs: VolatilityInputs): VolatilityData {
  const fred = fredHistory(inputs.fred);
  const board = VOLATILITY_INDICES.map((definition) => boardRow(definition, inputs.history?.[definition.id]));
  const term = termHistory([boardTermSource(board.find((row) => row.id === "vix"), board.find((row) => row.id === "vix3m")),
    fredTermSource(fred)]);
  const curve = alignedCurve(board, fred, term);
  return { curve, fred, term, board, warnings: [...new Set([...curve.warnings, ...fred.warnings,
    ...board.flatMap((row) => row.warnings.map((warning) => `${row.label}: ${warning}`))])] };
}
