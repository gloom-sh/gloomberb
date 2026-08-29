export type SeriesProvenance = "fred" | "fred-csv" | "yahoo";

export interface DatedObservation {
  date: string;
  value: number | null;
}

export interface DatedSeries {
  seriesId: string;
  observations: DatedObservation[];
  provenance: SeriesProvenance;
}
