/** Daily outstanding fails are separate settlement snapshots, never additive through time. */
interface FailsToDeliverObservation {
  date: string;
  cusip: string;
  quantity: number;
  price: number | null;
  description: string;
  sourceUrl: string;
}

/** ATS share is a percentage of published off-exchange shares, not total market volume. */
interface OtcVolumeObservation {
  weekStart: string;
  atsShares: number | null;
  nonAtsShares: number | null;
  totalShares: number | null;
  atsTrades: number | null;
  nonAtsTrades: number | null;
  atsSharePercent: number | null;
  sourceUrl: string;
}

export interface ShortSidePublication<T> {
  symbol: string;
  status: "available" | "partial" | "unavailable";
  asOf: string | null;
  sourceAsOf: string | null;
  fetchedAt: string;
  loadedAt: string | null;
  source: { name: string; url: string; cadence: string };
  warnings: string[];
  history: T[];
  coverage: { from: string; to: string; publications: number };
}

export type FailsToDeliverPayload = ShortSidePublication<FailsToDeliverObservation>;
export type OtcVolumePayload = ShortSidePublication<OtcVolumeObservation>;
