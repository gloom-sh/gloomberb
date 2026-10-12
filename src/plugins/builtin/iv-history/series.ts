import type { SeriesDefinition } from "../../../series/types";
import { loadIvHistory, type IvPoint } from "./client";

const TENORS: ReadonlyArray<readonly [key: "iv30" | "iv90" | "iv365", label: string]> = [
  ["iv30", "30-day"],
  ["iv90", "90-day"],
  ["iv365", "1-year"],
];

/** A ticker's at-the-money implied volatility by tenor, one close per session. */
export const IV_SERIES: readonly SeriesDefinition[] = TENORS.map(([key, label]): SeriesDefinition => ({
  id: `implied-vol:${key}`,
  name: `${label} implied volatility`,
  unit: "%",
  frequency: "daily",
  group: "Volatility",
  tags: ["IV", "implied volatility", "options", key],
  input: "ticker",
  load: async ({ ticker, signal }) => {
    const payload = await loadIvHistory(ticker!, { ...(signal ? { signal } : {}) });
    return {
      points: payload.series.map((point: IvPoint) => ({
        date: point.sessionDate,
        value: point[key] == null ? null : point[key]! * 100,
      })),
      ...(payload.warnings.length ? { warning: payload.warnings.join("; ") } : {}),
    };
  },
}));
