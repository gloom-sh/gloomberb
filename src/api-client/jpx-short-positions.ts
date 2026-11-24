export interface JpxShortPositions {
  symbol: string;
  exchange: "JPX";
  source: string;
  page: string;
  reportsReviewed: number;
  newestReport: string | null;
  points: {
    day: string;
    calculated: string;
    line: number;
    name: string;
    seller: string;
    contractor: string | null;
    fund: string | null;
    shares: number;
    percent: number;
    priorDate: string | null;
    priorPercent: number | null;
    notes: string | null;
    sourceUrl: string;
    observedAt: string;
  }[];
}
