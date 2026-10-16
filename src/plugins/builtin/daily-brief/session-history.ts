import { fetchHistoryResult } from "../../../sources/history-result";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { FUTURES_CONTRACTS } from "../../../market-data/futures-board";
import { BRIEF_FUTURES } from "./model";

const MARK_SYMBOLS = [...BRIEF_FUTURES, "^VIX"] as const;

export interface SessionMark {
  last: number;
  changePercent: number | null;
}

/** Last print in the window, and the move from its first print. */
export function markFromCloses(closes: readonly number[]): SessionMark | null {
  const finite = closes.filter((close) => Number.isFinite(close));
  const first = finite[0];
  const last = finite.at(-1);
  if (first == null || last == null) return null;
  if (finite.length < 2 || first === 0) return { last, changePercent: null };
  return { last, changePercent: ((last - first) / Math.abs(first)) * 100 };
}

function markExchanges(symbol: string): string[] {
  const venue = FUTURES_CONTRACTS.find((contract) => contract.symbol === symbol)?.venue;
  return venue ? ["", venue] : [""];
}

/**
 * Session bars for one symbol. An empty exchange is tried first, then the
 * listing venue, which is the other way these contracts resolve.
 */
export async function loadSessionPoints(
  provider: DataProvider,
  symbol: string,
  exchanges: readonly string[],
  start: number,
  end: number,
): Promise<PricePoint[]> {
  for (const exchange of exchanges) {
    try {
      const result = await fetchHistoryResult(provider, symbol, exchange, {
        kind: "detail",
        start: new Date(start),
        end: new Date(end),
        interval: "5m",
      });
      const points = (result?.points ?? []).flatMap((point) => {
        const date = point.date instanceof Date ? point.date : new Date(point.date as unknown as string);
        const time = date.getTime();
        return time >= start && time <= end && Number.isFinite(point.close) ? [{ ...point, date }] : [];
      });
      if (points.length > 0) return points;
    } catch {
      // The next exchange is the other listing for this symbol.
    }
  }
  return [];
}

/** Lasts from the same session history the chart draws, for a symbol whose quote did not arrive. */
export async function loadBriefMarks(
  provider: DataProvider,
  start: number,
  end: number,
): Promise<Map<string, SessionMark>> {
  const loaded = await Promise.all(MARK_SYMBOLS.map(async (symbol) => {
    const points = await loadSessionPoints(provider, symbol, markExchanges(symbol), start, end);
    const mark = markFromCloses(points.map((point) => point.close));
    return mark ? [symbol, mark] as const : null;
  }));
  return new Map(loaded.filter((entry) => entry != null));
}
