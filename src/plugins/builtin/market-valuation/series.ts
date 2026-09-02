export type SeriesProvenance = "fred" | "market" | "shiller";

export interface DatedObservation {
  date: string;
  value: number | null;
}

export interface DatedSeries {
  seriesId: string;
  observations: DatedObservation[];
  provenance: SeriesProvenance;
}
