import type { ProjectedChartPoint } from "../../../components/chart/core/data";

const CNN_FEAR_GREED_GRAPH_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata";
const CNN_REFERER = "https://www.cnn.com/markets/fear-and-greed";
const CNN_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type FearGreedRating = "extreme fear" | "fear" | "neutral" | "greed" | "extreme greed";

type CnnGraphKey =
  | "fear_and_greed"
  | "fear_and_greed_historical"
  | "market_momentum_sp500"
  | "market_momentum_sp125"
  | "stock_price_strength"
  | "stock_price_breadth"
  | "put_call_options"
  | "market_volatility_vix"
  | "market_volatility_vix_50"
  | "safe_haven_demand"
  | "junk_bond_demand";

interface CnnPoint {
  x?: unknown;
  y?: unknown;
  rating?: unknown;
}

interface CnnSeries {
  timestamp?: unknown;
  score?: unknown;
  rating?: unknown;
  previous_close?: unknown;
  previous_1_week?: unknown;
  previous_1_month?: unknown;
  previous_1_year?: unknown;
  data?: unknown;
}

export type CnnFearGreedGraphData = Partial<Record<CnnGraphKey, CnnSeries>>;

interface NormalizedRawPoint {
  x: number;
  y: number;
  rating: FearGreedRating | null;
}

interface FearGreedOverall {
  score: number;
  rating: FearGreedRating;
  updatedAt: Date | null;
  previousClose: number | null;
  previousWeek: number | null;
  previousMonth: number | null;
  previousYear: number | null;
  history: ProjectedChartPoint[];
}

export type FearGreedValueFormat = "score" | "number" | "percent" | "ratio";

interface FearGreedIndicatorDefinition {
  id: string;
  title: string;
  subtitle: string;
  primaryKey: CnnGraphKey;
  primaryLabel: string;
  secondaryKey?: CnnGraphKey;
  secondaryLabel?: string;
  valueFormat: FearGreedValueFormat;
}

/** A secondary reading aligned to the primary series by observation index. */
interface OverlayPoint {
  index: number;
  value: number;
}

export interface FearGreedIndicator {
  definition: FearGreedIndicatorDefinition;
  score: number | null;
  rating: FearGreedRating;
  updatedAt: Date | null;
  points: ProjectedChartPoint[];
  secondaryPoints: OverlayPoint[];
  latestValue: number | null;
  latestSecondaryValue: number | null;
}

export interface FearGreedData {
  overall: FearGreedOverall;
  indicators: FearGreedIndicator[];
}

const FEAR_GREED_INDICATORS: FearGreedIndicatorDefinition[] = [
  {
    id: "market-momentum",
    title: "Market Momentum",
    subtitle: "S&P 500 and its 125-day moving average",
    primaryKey: "market_momentum_sp500",
    primaryLabel: "S&P 500",
    secondaryKey: "market_momentum_sp125",
    secondaryLabel: "125-day moving average",
    valueFormat: "number",
  },
  {
    id: "stock-price-strength",
    title: "Stock Price Strength",
    subtitle: "Net new 52-week highs and lows on the NYSE",
    primaryKey: "stock_price_strength",
    primaryLabel: "Net highs/lows",
    valueFormat: "percent",
  },
  {
    id: "stock-price-breadth",
    title: "Stock Price Breadth",
    subtitle: "McClellan Volume Summation Index",
    primaryKey: "stock_price_breadth",
    primaryLabel: "McClellan index",
    valueFormat: "number",
  },
  {
    id: "put-call-options",
    title: "Put and Call Options",
    subtitle: "5-day average put/call ratio",
    primaryKey: "put_call_options",
    primaryLabel: "Put/call ratio",
    valueFormat: "ratio",
  },
  {
    id: "market-volatility",
    title: "Market Volatility",
    subtitle: "VIX and its 50-day moving average",
    primaryKey: "market_volatility_vix",
    primaryLabel: "VIX",
    secondaryKey: "market_volatility_vix_50",
    secondaryLabel: "50-day moving average",
    valueFormat: "number",
  },
  {
    id: "safe-haven-demand",
    title: "Safe Haven Demand",
    subtitle: "Difference in 20-day stock and bond returns",
    primaryKey: "safe_haven_demand",
    primaryLabel: "Stocks vs. bonds",
    valueFormat: "percent",
  },
  {
    id: "junk-bond-demand",
    title: "Junk Bond Demand",
    subtitle: "Yield spread: junk bonds vs. investment grade",
    primaryKey: "junk_bond_demand",
    primaryLabel: "Yield spread",
    valueFormat: "percent",
  },
];

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeRating(value: unknown): FearGreedRating | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "extreme fear":
    case "fear":
    case "neutral":
    case "greed":
    case "extreme greed":
      return normalized;
    default:
      return null;
  }
}

function fallbackRatingForScore(score: number | null): FearGreedRating {
  if (score == null) return "neutral";
  if (score < 25) return "extreme fear";
  if (score < 45) return "fear";
  if (score <= 55) return "neutral";
  if (score <= 75) return "greed";
  return "extreme greed";
}

function parseTimestamp(value: unknown): Date | null {
  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const millis = finiteNumber(value);
  if (millis == null) return null;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeRawPoints(series: CnnSeries | undefined): NormalizedRawPoint[] {
  if (!series || !Array.isArray(series.data)) return [];
  const points: NormalizedRawPoint[] = [];
  for (const item of series.data) {
    if (!isObject(item)) continue;
    const point = item as CnnPoint;
    const x = finiteNumber(point.x);
    const y = finiteNumber(point.y);
    if (x == null || y == null) continue;
    points.push({ x, y, rating: normalizeRating(point.rating) });
  }
  return points.sort((left, right) => left.x - right.x);
}

function toProjectedPoints(points: NormalizedRawPoint[]): ProjectedChartPoint[] {
  return points.map((point) => ({
    date: new Date(point.x),
    open: point.y,
    high: point.y,
    low: point.y,
    close: point.y,
    volume: 0,
  }));
}

function toSecondaryOverlay(primaryPoints: NormalizedRawPoint[], secondaryPoints: NormalizedRawPoint[]): OverlayPoint[] {
  const indexByTimestamp = new Map(primaryPoints.map((point, index) => [point.x, index] as const));
  const overlay: OverlayPoint[] = [];
  for (let index = 0; index < secondaryPoints.length; index += 1) {
    const point = secondaryPoints[index]!;
    const matchedIndex = indexByTimestamp.get(point.x) ?? (index < primaryPoints.length ? index : null);
    if (matchedIndex == null) continue;
    overlay.push({ index: matchedIndex, value: point.y });
  }
  return overlay;
}

function latestValue(points: NormalizedRawPoint[]): number | null {
  return points.length > 0 ? points[points.length - 1]!.y : null;
}

function latestRating(series: CnnSeries | undefined, points: NormalizedRawPoint[], score: number | null): FearGreedRating {
  return normalizeRating(series?.rating)
    ?? (points.length > 0 ? points[points.length - 1]!.rating : null)
    ?? fallbackRatingForScore(score);
}

function latestTimestamp(series: CnnSeries | undefined, points: NormalizedRawPoint[]): Date | null {
  return parseTimestamp(series?.timestamp)
    ?? (points.length > 0 ? new Date(points[points.length - 1]!.x) : null);
}

export function normalizeFearGreedData(
  charts: CnnFearGreedGraphData,
  latest: CnnFearGreedGraphData = charts,
): FearGreedData {
  const latestOverallSeries = latest.fear_and_greed ?? charts.fear_and_greed;
  const historySeries = charts.fear_and_greed_historical ?? latest.fear_and_greed_historical;
  const historyRawPoints = normalizeRawPoints(historySeries);
  const latestScore = finiteNumber(latestOverallSeries?.score)
    ?? finiteNumber(historySeries?.score)
    ?? latestValue(historyRawPoints);

  if (latestScore == null) {
    throw new Error("CNN Fear & Greed response did not include an index score");
  }

  const overall: FearGreedOverall = {
    score: latestScore,
    rating: normalizeRating(latestOverallSeries?.rating) ?? fallbackRatingForScore(latestScore),
    updatedAt: parseTimestamp(latestOverallSeries?.timestamp) ?? latestTimestamp(historySeries, historyRawPoints),
    previousClose: finiteNumber(latestOverallSeries?.previous_close),
    previousWeek: finiteNumber(latestOverallSeries?.previous_1_week),
    previousMonth: finiteNumber(latestOverallSeries?.previous_1_month),
    previousYear: finiteNumber(latestOverallSeries?.previous_1_year),
    history: toProjectedPoints(historyRawPoints),
  };

  const indicators = FEAR_GREED_INDICATORS.flatMap((definition): FearGreedIndicator[] => {
    const series = charts[definition.primaryKey] ?? latest[definition.primaryKey];
    const primaryPoints = normalizeRawPoints(series);
    if (primaryPoints.length === 0) return [];

    const secondarySeries = definition.secondaryKey
      ? (charts[definition.secondaryKey] ?? latest[definition.secondaryKey])
      : undefined;
    const secondaryRawPoints = normalizeRawPoints(secondarySeries);
    const score = finiteNumber(series?.score);

    return [{
      definition,
      score,
      rating: latestRating(series, primaryPoints, score),
      updatedAt: latestTimestamp(series, primaryPoints),
      points: toProjectedPoints(primaryPoints),
      secondaryPoints: toSecondaryOverlay(primaryPoints, secondaryRawPoints),
      latestValue: latestValue(primaryPoints),
      latestSecondaryValue: latestValue(secondaryRawPoints),
    }];
  });

  return { overall, indicators };
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function isDomRuntime(): boolean {
  return typeof (globalThis as { document?: unknown }).document !== "undefined";
}

function cnnFetchHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    Accept: "application/json,text/plain,*/*",
  };

  if (!isDomRuntime()) {
    headers["User-Agent"] = CNN_USER_AGENT;
    headers.Referer = CNN_REFERER;
  }

  return headers;
}

async function fetchCnnGraphData(url: string, fetcher: typeof fetch): Promise<CnnFearGreedGraphData> {
  const response = await fetcher(url, { headers: cnnFetchHeaders() });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`CNN Fear & Greed request failed (${response.status}): ${body.slice(0, 120)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`CNN Fear & Greed returned non-JSON data: ${body.slice(0, 120)}`);
  }

  if (!isObject(parsed)) {
    throw new Error("CNN Fear & Greed response was not an object");
  }

  return parsed as CnnFearGreedGraphData;
}

export async function fetchFearGreedData(options: {
  date?: Date;
  fetcher?: typeof fetch;
} = {}): Promise<FearGreedData> {
  const fetcher = options.fetcher ?? fetch;
  const date = options.date ?? new Date();
  const latestUrl = `${CNN_FEAR_GREED_GRAPH_URL}/${formatLocalDate(date)}`;

  const [chartsResult, latestResult] = await Promise.allSettled([
    fetchCnnGraphData(CNN_FEAR_GREED_GRAPH_URL, fetcher),
    fetchCnnGraphData(latestUrl, fetcher),
  ]);

  const charts = chartsResult.status === "fulfilled" ? chartsResult.value : null;
  const latest = latestResult.status === "fulfilled" ? latestResult.value : null;

  if (!charts && !latest) {
    const reason = chartsResult.status === "rejected"
      ? chartsResult.reason
      : latestResult.status === "rejected"
        ? latestResult.reason
        : "CNN Fear & Greed returned no data";
    throw reason instanceof Error ? reason : new Error(String(reason));
  }

  return normalizeFearGreedData(charts ?? latest!, latest ?? charts ?? undefined);
}
