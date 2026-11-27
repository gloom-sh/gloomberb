import type { PricePoint } from "../types/financials";
import type { TimeSeriesPoint } from "./types";
import { valuationPriceAtOrBefore } from "./valuation-price";
import { regularSessionCloseOn } from "../market-data/market/freshness";
import { financialAvailabilityTime } from "../utils/financial-statements";

export interface DailyValuationBasis {
  /** ISO publication date or timestamp. A date without a time takes effect after that session. */
  availableAt?: string;
  /** An undated, unusable statement invalidates the old basis from its period end. */
  observedAt: Date;
  atPrice: (price: number) => number | null;
  periodLabel?: string;
}

/** Reprice a stepped financial figure at each source daily close. */
export function dailyValuationHistory(
  history: readonly PricePoint[],
  bases: readonly DailyValuationBasis[],
  exchange?: string,
  closesKnownBy?: number,
): TimeSeriesPoint[] {
  const byDate = new Map<number, PricePoint[]>();
  for (const bar of history) {
    const time = bar.date instanceof Date ? bar.date.getTime() : Date.parse(bar.date);
    if (!Number.isFinite(time) || bar.partial) continue;
    byDate.set(time, [...byDate.get(time) ?? [], bar]);
  }
  const effectiveTime = (basis: DailyValuationBasis) => basis.availableAt
    ? financialAvailabilityTime(basis.availableAt)
    : basis.observedAt.getTime();
  const releases = [...bases].sort((a, b) => effectiveTime(a) - effectiveTime(b)
    || a.observedAt.getTime() - b.observedAt.getTime());
  let next = 0;
  let active: DailyValuationBasis | undefined;
  const points: TimeSeriesPoint[] = [];
  const closes = [...byDate].flatMap(([time, bars]) => {
    // Daily bars name their session at midnight. A timed report belongs to
    // that close only if it was already public, including on early closes.
    const day = new Date(time).toISOString().slice(0, 10);
    const closeTime = closesKnownBy === undefined ? regularSessionCloseOn(exchange, day) ?? time
      : time % 86_400_000 === 0 ? regularSessionCloseOn(exchange, day) : time;
    return closeTime === null ? [] : [{ time, bars, closeTime, pointTime: closesKnownBy === undefined ? time : closeTime }];
  });
  for (const { time, bars, closeTime, pointTime } of closes.sort((left, right) => left.pointTime - right.pointTime || left.time - right.time)) {
    if (closesKnownBy !== undefined && closeTime > closesKnownBy) continue;
    while (next < releases.length && effectiveTime(releases[next]!) <= closeTime) {
      const release = releases[next++]!;
      if (!active || release.observedAt >= active.observedAt) active = release;
    }
    const observedAt = new Date(time);
    const date = pointTime === time ? observedAt : new Date(pointTime);
    const price = valuationPriceAtOrBefore(bars, observedAt.toISOString());
    const value = active && price?.price != null ? active.atPrice(price.price) : null;
    points.push({
      date,
      observedAt,
      availableAt: active?.availableAt ? new Date(closesKnownBy === undefined ? active.availableAt : closeTime) : undefined,
      value: value !== null && Number.isFinite(value) ? value : null,
      periodLabel: active?.periodLabel,
      provenance: {
        quality: "derived",
        ...(price?.integrity ? { priceHistoryIntegrity: price.integrity } : {}),
        ...(price?.issue ? { valuationPriceIssues: [{ ...price.issue, affectedAt: date.toISOString() }] } : {}),
      },
    });
  }
  return points;
}
