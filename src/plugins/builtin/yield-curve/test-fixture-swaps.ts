import { SWAP_TENORS, type SwapCurvePayload, type SwapPoint, type SwapTenor } from "../../../api-client/swap-curve";

export function swapFixture(tenor: SwapTenor = "10Y"): SwapCurvePayload {
  const points = SWAP_TENORS.map((tenor, index): SwapPoint => ({
    tenor, years: Number.parseInt(tenor), rate: 3.5 + index / 10, changeBp: 1.2,
    spreadBp: tenor === "15Y" ? null : -20.5, treasuryRate: tenor === "15Y" ? null : 3.705 + index / 10,
    tradeCount: 10, candidateCount: 11, excludedCount: 1, notionalUsd: 100_000_000, quality: "ok",
  }));
  points[3] = { ...points[3]!, rate: null, changeBp: null, spreadBp: null, tradeCount: 2, quality: "missing" };
  points[8] = { ...points[8]!, tradeCount: 3, quality: "thin" };
  return {
    source: "DTCC PPD", currency: "USD", benchmark: "SOFR", asOf: "2026-10-20", fetchedAt: "2026-10-21T04:00:00Z",
    stale: false, previousDate: "2026-10-19", treasuryDate: "2026-10-20", points,
    comparisons: {
      week: { date: "2026-10-13", points: points.map((point) => ({ ...point, rate: point.rate == null ? null : point.rate - 0.02 })) },
      month: { date: null, points: [] },
    },
    history: { tenor, points: [
      { date: "2026-10-16", rate: 3.95, spreadBp: tenor === "15Y" ? null : -20, tradeCount: 5, quality: "ok" },
      { date: "2026-10-19", rate: null, spreadBp: null, tradeCount: 2, quality: "missing" },
      { date: "2026-10-20", rate: 4, spreadBp: tenor === "15Y" ? null : -20.5, tradeCount: 10, quality: "ok" },
    ] },
  };
}
