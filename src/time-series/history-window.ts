import { subtractTimeRange } from "./date-window";
import type { TimeRange } from "./range";
import type { PricePoint } from "../types/financials";
import { getPricePointTimestamp } from "../utils/price-history";

export function clipPriceHistoryToRange(points: PricePoint[], range: TimeRange): PricePoint[] {
  if (range === "ALL" || points.length === 0) return points;
  const dated = points.flatMap((point) => {
    const timestamp = getPricePointTimestamp(point);
    return Number.isFinite(timestamp) ? [{ point, timestamp }] : [];
  });
  const endTimestamp = dated.reduce<number | null>((latest, entry) => (
    latest == null || entry.timestamp > latest ? entry.timestamp : latest
  ), null);
  if (endTimestamp == null) return [];
  const end = new Date(endTimestamp);
  const start = subtractTimeRange(end, range);
  return dated
    .filter(({ timestamp }) => timestamp >= start.getTime() && timestamp <= endTimestamp)
    .map(({ point }) => point);
}
