export const SWAP_TENORS = ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"] as const;
export type SwapTenor = typeof SWAP_TENORS[number];
type SwapQuality = "ok" | "thin" | "missing";

export interface SwapPoint {
  tenor: SwapTenor;
  years: number;
  /** Percentage rate: 4.5 means 4.5%. */
  rate: number | null;
  changeBp: number | null;
  spreadBp: number | null;
  treasuryRate: number | null;
  tradeCount: number;
  candidateCount: number;
  excludedCount: number;
  notionalUsd: number;
  quality: SwapQuality;
}

export interface SwapCurvePayload {
  source: "DTCC PPD";
  currency: "USD";
  benchmark: "SOFR";
  asOf: string | null;
  fetchedAt: string | null;
  stale: boolean;
  previousDate: string | null;
  treasuryDate: string | null;
  points: SwapPoint[];
  comparisons: Record<"week" | "month", { date: string | null; points: SwapPoint[] }>;
  history: {
    tenor: SwapTenor;
    points: Array<{ date: string; rate: number | null; spreadBp: number | null; tradeCount: number; quality: SwapQuality }>;
  };
}
