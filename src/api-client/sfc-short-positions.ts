interface SfcPosition {
  day: string;
  name: string;
  shares: number;
  valueHkd: number | null;
  observedAt: string;
  sourceModifiedAt: string | null;
  sourceUrl: string;
}

export interface SfcShortPositions {
  symbol: string;
  exchange: "HKEX";
  source: string;
  page: string;
  reportsReviewed: number;
  newestReport: string | null;
  points: SfcPosition[];
}
