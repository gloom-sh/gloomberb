import { apiClient } from "../../../api-client";
import type { CloudCurvePoint, CloudCurveId, CloudCurveView } from "../../../api-client/yield-curves";
import type { CurveBasis } from "./forward";
import { yieldSpreads, type YieldLookbackCurves } from "./chart";
import { completeYieldCurve, loadHistoricalYieldCurve, yieldCurveDate } from "./history";
import { isYieldObservationDate, loadYieldCurve, type YieldPoint } from "./treasury-data";

export type CurveId = CloudCurveId;

export interface CurveOption {
  id: CurveId;
  /** The picker's word for it. */
  label: string;
  /** What the GC argument accepts: `GC JGB`, `GC TIPS 2024-01-02`. */
  aliases: readonly string[];
}

export const CURVE_OPTIONS: readonly CurveOption[] = [
  { id: "us", label: "UST", aliases: ["ust", "us", "treasury", "treasuries", "usd"] },
  { id: "us-real", label: "TIPS real", aliases: ["tips", "real"] },
  { id: "us-breakeven", label: "Breakeven", aliases: ["breakeven", "breakevens", "be", "bei", "inflation"] },
  { id: "eu-aaa", label: "Euro AAA", aliases: ["euro", "eur", "eu", "aaa", "ea"] },
  { id: "de", label: "Bund", aliases: ["bund", "bunds", "de", "germany"] },
  { id: "gb", label: "Gilt", aliases: ["gilt", "gilts", "uk", "gb", "gbp"] },
  { id: "jp", label: "JGB", aliases: ["jgb", "jgbs", "jp", "japan", "jpy"] },
  { id: "ca", label: "Canada", aliases: ["canada", "ca", "goc", "cad"] },
];

export function isCurveId(value: unknown): value is CurveId {
  return CURVE_OPTIONS.some((option) => option.id === value);
}

/** A curve id or any of its aliases ("jgb", "bund"), from a setting or an option. */
export function curveIdOf(value: unknown): CurveId | null {
  if (typeof value !== "string") return null;
  const word = value.trim().toLowerCase();
  return CURVE_OPTIONS.find((option) => option.id === word || option.aliases.includes(word))?.id ?? null;
}

export function curveOption(id: CurveId): CurveOption {
  return CURVE_OPTIONS.find((option) => option.id === id) ?? CURVE_OPTIONS[0]!;
}

/** `GC`, `GC 2026-01-02`, `GC JGB`, `GC TIPS 2024-01-02`: a curve word and a date, either order. */
export function parseCurveArgument(value: unknown, now = new Date()): { curve: CurveId | null; date: string } {
  const words = typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean) : [];
  let curve: CurveId | null = null;
  const rest: string[] = [];
  for (const word of words) {
    const match = CURVE_OPTIONS.find((option) => option.aliases.includes(word.toLowerCase()));
    if (match && !curve) curve = match.id;
    else rest.push(word);
  }
  return { curve, date: yieldCurveDate(rest.join(" ") || null, now) };
}

export interface CurveSpreadFigure {
  id: string;
  /** Long minus short, percentage points. */
  value: number | null;
  change1d: number | null;
  /** Midrank percentile among the trailing year's sessions; null when the source has no history. */
  percentile1y: number | null;
}

export interface CurveData {
  curve: CurveId;
  requestedDate: string;
  basis: CurveBasis;
  couponsPerYear: number;
  points: YieldPoint[];
  /** Null for the FRED fallback, whose look-backs load on their own after the curve. */
  lookbacks: YieldLookbackCurves | null;
  /** Null for the FRED fallback: its spreads follow from the points and look-backs. */
  spreads: CurveSpreadFigure[] | null;
}

type CurveClient = Pick<typeof apiClient, "getCloudCurve" | "getCloudYieldCurve" | "getCloudFredSeries">;

function pointsAt(points: readonly CloudCurvePoint[], asOf: string | null): YieldPoint[] {
  return points.map((point) => ({
    maturity: point.tenor, maturityYears: point.years, yield: point.yield,
    asOf: point.yield != null && isYieldObservationDate(asOf) ? asOf : null,
  }));
}

export function curveDataFromView(view: CloudCurveView, requestedDate: string): CurveData {
  return {
    curve: view.curve.id,
    requestedDate,
    basis: view.curve.basis,
    couponsPerYear: view.curve.couponsPerYear,
    points: pointsAt(view.points, view.asOf),
    lookbacks: Object.fromEntries(view.lookbacks.map((lookback) => [lookback.id,
      lookback.points ? pointsAt(lookback.points, lookback.asOf) : null])),
    spreads: view.spreads.map(({ id, value, change1d, percentile1y }) => ({ id, value, change1d, percentile1y })),
  };
}

/**
 * The FRED constant-maturity curve, a session behind Treasury's own; what GC
 * shows for Treasuries when the stored curve cannot be read.
 */
async function loadFredCurve(requestedDate: string, client: CurveClient): Promise<CurveData> {
  const points = completeYieldCurve(requestedDate
    ? await loadHistoricalYieldCurve(requestedDate, (id, options) => client.getCloudFredSeries(id, options))
    : await loadYieldCurve(() => client.getCloudYieldCurve()));
  return { curve: "us", requestedDate, basis: "par", couponsPerYear: 2, points, lookbacks: null, spreads: null };
}

/** The spreads GC shows: the stored curve's, or for FRED's curve its own with no percentile. */
export function curveSpreadFigures(data: CurveData | null, lookbacks: YieldLookbackCurves): CurveSpreadFigure[] {
  if (!data) return [];
  return data.spreads ?? yieldSpreads(data.points, lookbacks)
    .map(({ id, spread, change1d }) => ({ id, value: spread, change1d, percentile1y: null }));
}

/**
 * A curve on the requested date (its last session on or before it) or its
 * latest. Treasuries fall back to FRED when the stored curve cannot be read,
 * which also covers dates before Treasury's files begin.
 */
export async function loadCurveData(curve: CurveId, requestedDate: string, client: CurveClient = apiClient): Promise<CurveData> {
  try {
    return curveDataFromView(await client.getCloudCurve(curve, requestedDate || null), requestedDate);
  } catch (error) {
    if (curve !== "us") throw error;
    return loadFredCurve(requestedDate, client);
  }
}

/** The compare curve: its session on or before the date. */
export async function loadComparePoints(curve: CurveId, date: string, client: CurveClient = apiClient): Promise<YieldPoint[]> {
  try {
    const view = await client.getCloudCurve(curve, date);
    return pointsAt(view.points, view.asOf);
  } catch (error) {
    if (curve !== "us") throw error;
    return completeYieldCurve(await loadHistoricalYieldCurve(date, (id, options) => client.getCloudFredSeries(id, options)));
  }
}

const RELATIVE = /^(\d{1,2})([WMY])$/i;

/**
 * What the compare field accepts: a date, or a span back from the curve's
 * session (1W, 3M, 1Y). Empty turns comparing off.
 */
export function parseCompareInput(value: string, now = new Date()): string {
  const text = value.trim();
  if (!text) return "";
  if (RELATIVE.test(text)) return text.toUpperCase();
  const date = yieldCurveDate(text, now);
  if (!date) throw new Error("Compare with a date in YYYY-MM-DD format or a span such as 1W, 3M or 1Y.");
  return date;
}

/** The date a compare input asks for, given the session shown. */
export function compareDate(input: string, asOf: string): string {
  const match = input.match(RELATIVE);
  if (!match) return input;
  const count = Number(match[1]);
  const unit = match[2]!.toUpperCase();
  const [year, month, day] = asOf.split("-").map(Number) as [number, number, number];
  if (unit === "W") return new Date(Date.UTC(year, month - 1, day - 7 * count)).toISOString().slice(0, 10);
  const months = unit === "M" ? count : count * 12;
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}
