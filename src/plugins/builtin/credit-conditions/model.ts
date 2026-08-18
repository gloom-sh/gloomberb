import type { CloudFredSeriesPayload } from "../../../api-client";

export const CREDIT_SERIES = [
  { seriesId: "BAMLC0A0CM", label: "US IG" },
  { seriesId: "BAMLC0A1CAAA", label: "AAA" },
  { seriesId: "BAMLC0A2CAA", label: "AA" },
  { seriesId: "BAMLC0A3CA", label: "A" },
  { seriesId: "BAMLC0A4CBBB", label: "BBB" },
  { seriesId: "BAMLH0A0HYM2", label: "US HY" },
] as const;

export type CreditSeriesId = typeof CREDIT_SERIES[number]["seriesId"];

export interface CreditConditionRow {
  seriesId: CreditSeriesId;
  label: string;
  title: string;
  units: string;
  frequency: string;
  oasBp: number;
  dailyChangeBp: number | null;
  date: string;
  stale: boolean;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function normalizeCreditSeries(
  definition: typeof CREDIT_SERIES[number],
  payload: CloudFredSeriesPayload,
  stale = false,
): CreditConditionRow {
  const info = payload.info;
  if (!info
    || info.units.toLowerCase() !== "percent"
    || !info.frequency.toLowerCase().startsWith("daily")
    || !info.title.toLowerCase().includes("option-adjusted spread")) {
    throw new Error(`${definition.seriesId}: unexpected FRED metadata`);
  }

  const observations = payload.observations
    .filter((observation): observation is { date: string; value: number } =>
      /^\d{4}-\d{2}-\d{2}$/.test(observation.date)
      && observation.value != null
      && Number.isFinite(observation.value),
    )
    .sort((left, right) => left.date.localeCompare(right.date));
  const latest = observations.at(-1);
  if (!latest) throw new Error(`${definition.seriesId}: no observations`);
  const previous = observations.at(-2);

  return {
    ...definition,
    title: info.title,
    units: info.units,
    frequency: info.frequency,
    oasBp: roundTenth(latest.value * 100),
    dailyChangeBp: previous ? roundTenth((latest.value - previous.value) * 100) : null,
    date: latest.date,
    stale,
  };
}
