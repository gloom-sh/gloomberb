import type { SeriesCacheMetadata, SeriesProviderMetadata } from "../shared/series-cache";

type SeriesProvenance = "fred" | "market" | "shiller";

export interface DatedObservation {
  date: string;
  value: number | null;
}

export type ValuationSourceMetadata = Partial<SeriesCacheMetadata> & { provenance: SeriesProvenance; provider?: SeriesProviderMetadata };

export interface DatedSeries extends Partial<SeriesCacheMetadata> {
  seriesId: string;
  observations: DatedObservation[];
  provider?: SeriesProviderMetadata;
  provenance: SeriesProvenance;
}

/** FRED/Shiller observations are calendar dates, not permissive JS timestamps. */
export function validateObservationDates(observations: readonly DatedObservation[]): void {
  for (const observation of observations) {
    const { date } = observation;
    const time = typeof date === "string" ? Date.parse(date) : Number.NaN;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time)
      || new Date(time).toISOString().slice(0, 10) !== date) {
      throw new Error(`Invalid observation date: ${date}`);
    }
  }
}
