export type ShortVolumeScope = "nms" | "otc";

export interface ShortVolumeObservation {
  date: string;
  shortVolume: string | null;
  shortExemptVolume: string | null;
  totalVolume: string | null;
  ratioPercent: number | null;
  markets: string[];
  fetchedAt: string | null;
  sourceUrl: string;
  refreshFailed: boolean;
  unavailableReason: "missing_file" | "not_reported" | "zero_volume" | null;
}

export interface ShortVolumePayload {
  version: 1;
  symbol: string;
  finraSymbol: string;
  scope: ShortVolumeScope;
  status: "available" | "partial" | "unavailable";
  fetchedAt: string;
  asOf: string | null;
  sourceAsOf: string | null;
  source: { name: string; url: string; cadence: string };
  latest: (ShortVolumeObservation & {
    changePp: number | null;
    previousDate: string | null;
    percentile: {
      value: number | null;
      rank: number | null;
      sampleCount: number;
      windowStart: string;
      windowEnd: string;
      historyStart: string | null;
      historyEnd: string | null;
      completeWindow: boolean;
      min: number | null;
      max: number | null;
      mean: number | null;
    };
  }) | null;
  coverage: {
    windowStart: string;
    windowEnd: string;
    expectedFiles: number;
    ingestedFiles: number;
    missingFiles: number;
    expectedMonths: number;
    discoveredMonths: number;
    completeWindow: boolean;
  };
  history: ShortVolumeObservation[];
  warnings: string[];
}
