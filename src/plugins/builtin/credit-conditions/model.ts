import type { CloudFredSeriesPayload } from "../../../api-client";
import { historyStatistics } from "../../../components/chart/curve/model";
import { fredHistoryLimitNotice } from "../../../time-series/economic";
import { ICE_SPREAD_SERIES, type IceCreditSeries } from "../../../time-series/ice-credit";

export type CreditSeriesDefinition = Pick<IceCreditSeries, "seriesId" | "label" | "region">;

/** US investment grade and high yield by rating, euro high yield, then emerging markets corporates by grade and region. */
export const CREDIT_SERIES: readonly CreditSeriesDefinition[] = ICE_SPREAD_SERIES
  .map(({ seriesId, label, region }) => ({ seriesId, label, region }));

const CREDIT_REGIONS = ["all", "us", "euro", "em", "asia"] as const;
type CreditRegion = typeof CREDIT_REGIONS[number];

/** The regions to list, from a setting or `--region` (one, or a comma list such as `asia,us`); every one when none is known. */
export function creditRegion(value: unknown): readonly CreditRegion[] {
  const regions = typeof value === "string"
    ? [...new Set(value.split(",").map((part) => part.trim().toLowerCase()))].filter((part): part is CreditRegion => CREDIT_REGIONS.includes(part as CreditRegion))
    : [];
  return regions.length === 0 || regions.includes("all") ? ["all"] : regions;
}

/** The series in the regions, in the board's order: emerging markets take in Asia, its biggest region. */
export function creditSeriesIn(regions: readonly CreditRegion[]): readonly CreditSeriesDefinition[] {
  if (regions.includes("all")) return CREDIT_SERIES;
  return CREDIT_SERIES.filter((series) => regions.includes(series.region) || (series.region === "asia" && regions.includes("em")));
}

export interface CreditConditionRow {
  seriesId: string;
  label: string;
  region: IceCreditSeries["region"];
  title: string;
  units: string;
  frequency: string;
  oasBp: number;
  dailyChangeBp: number | null;
  date: string;
  stale: boolean;
  /** The publisher's cap on how far back the series goes, when FRED states one. */
  historyLimit: string | null;
  /** Observations in the year to `date`, in basis points, oldest first. */
  history: Array<{ date: string; valueBp: number }>;
  /** Midrank of the latest spread within that year. */
  percentile1Y: number | null;
  rangeLowBp: number | null;
  rangeHighBp: number | null;
}

const YEAR_DAYS = 365;

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

export function normalizeCreditSeries(
  definition: CreditSeriesDefinition,
  payload: CloudFredSeriesPayload,
  stale = false,
): CreditConditionRow {
  const info = payload.info;
  if (!info
    || info.id?.trim().toUpperCase() !== definition.seriesId
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
  const oasBp = roundTenth(latest.value * 100);
  const windowStart = new Date(Date.parse(`${latest.date}T00:00:00Z`) - YEAR_DAYS * 86_400_000).toISOString().slice(0, 10);
  const history = observations
    .filter((observation) => observation.date >= windowStart)
    .map((observation) => ({ date: observation.date, valueBp: roundTenth(observation.value * 100) }));
  const year = historyStatistics(history.map((point) => ({ date: point.date, value: point.valueBp })), oasBp,
    { asOf: latest.date, windowDays: YEAR_DAYS });

  return {
    ...definition,
    title: info.title,
    units: info.units,
    frequency: info.frequency,
    oasBp,
    dailyChangeBp: previous ? roundTenth((latest.value - previous.value) * 100) : null,
    date: latest.date,
    stale,
    historyLimit: fredHistoryLimitNotice(definition.seriesId, info),
    history,
    // One observation ranks nothing.
    percentile1Y: year.count >= 2 ? year.percentile : null,
    rangeLowBp: year.min,
    rangeHighBp: year.max,
  };
}
