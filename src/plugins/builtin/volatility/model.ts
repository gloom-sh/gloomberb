import type {
  CloudFredObservationPayload,
  CloudFredSeriesInfoPayload,
} from "../../../api-client";

export const VOLATILITY_SERIES = [
  { seriesId: "VIXCLS", label: "VIX", tenor: "30D" },
  { seriesId: "VXVCLS", label: "VIX 3M", tenor: "3M" },
] as const;

export type VolatilitySeriesId = typeof VOLATILITY_SERIES[number]["seriesId"];
export type TermState = "normal" | "inverted" | "flat" | "partial";

export interface VolatilitySeriesInput {
  observations: CloudFredObservationPayload[];
  info: CloudFredSeriesInfoPayload | null;
}

export interface VolatilityMetric {
  seriesId: VolatilitySeriesId;
  label: string;
  tenor: string;
  title: string;
  value: number | null;
  date: string | null;
  history: Array<{ date: string; value: number }>;
}

export interface VolatilityData {
  metrics: VolatilityMetric[];
  termPoints: Array<{
    seriesId: VolatilitySeriesId;
    label: string;
    tenor: string;
    value: number | null;
  }>;
  termDate: string | null;
  ratio: number | null;
  slope: number | null;
  ratioHistory: Array<{ date: string; value: number }>;
  termState: TermState;
}

function normalizeObservations(
  observations: CloudFredObservationPayload[],
): Array<{ date: string; value: number }> {
  return observations
    .filter((observation): observation is { date: string; value: number } =>
      /^\d{4}-\d{2}-\d{2}$/.test(observation.date)
      && observation.value != null
      && Number.isFinite(observation.value),
    )
    .sort((left, right) => left.date.localeCompare(right.date));
}

function metricFor(
  definition: typeof VOLATILITY_SERIES[number],
  input: VolatilitySeriesInput | undefined,
): VolatilityMetric {
  const history = normalizeObservations(input?.observations ?? []);
  const latest = history.at(-1);
  return {
    ...definition,
    title: input?.info?.title ?? definition.label,
    value: latest?.value ?? null,
    date: latest?.date ?? null,
    history: history.slice(-60),
  };
}

export function classifyTermState(
  spot: number | null,
  threeMonth: number | null,
): TermState {
  if (spot == null || threeMonth == null || spot === 0) return "partial";
  if (threeMonth > spot) return "normal";
  if (threeMonth < spot) return "inverted";
  return "flat";
}

export function buildVolatilityData(
  inputs: Partial<Record<VolatilitySeriesId, VolatilitySeriesInput>>,
): VolatilityData {
  const metrics = VOLATILITY_SERIES.map((definition) =>
    metricFor(definition, inputs[definition.seriesId]),
  );
  const spotByDate = new Map(metrics[0]!.history.map((point) => [point.date, point.value]));
  const ratioHistory = metrics[1]!.history.flatMap((point) => {
    const spot = spotByDate.get(point.date);
    return spot == null || spot === 0
      ? []
      : [{ date: point.date, value: point.value / spot }];
  });
  const latestRatio = ratioHistory.at(-1);
  const termDate = latestRatio?.date ?? null;
  const spot = termDate == null ? null : spotByDate.get(termDate) ?? null;
  const threeMonth = termDate == null
    ? null
    : metrics[1]!.history.find((point) => point.date === termDate)?.value ?? null;

  return {
    metrics,
    termPoints: [
      { ...VOLATILITY_SERIES[0], value: spot },
      { ...VOLATILITY_SERIES[1], value: threeMonth },
    ],
    termDate,
    ratio: latestRatio?.value ?? null,
    slope: spot == null || threeMonth == null ? null : threeMonth - spot,
    ratioHistory,
    termState: classifyTermState(spot, threeMonth),
  };
}
