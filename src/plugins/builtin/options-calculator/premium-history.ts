import { apiClient } from "../../../api-client";
import { scalarPoint, staticSeries } from "../../../components/chart/static/series";
import type { ResolvedSeries } from "../../../time-series/types";
import { OPTIONS_QUOTE_EXCHANGE } from "../options/live-quotes";

/** Daily closes for one listed contract. A typed premium has no contract to chart. */
export async function loadContractPremiumHistory(
  contractSymbol: string,
  signal?: AbortSignal,
): Promise<{ date: string; close: number }[]> {
  const response = await apiClient.getCloudHistory(contractSymbol, OPTIONS_QUOTE_EXCHANGE, {
    interval: "1day",
    outputsize: 400,
  }, signal ? { signal } : {});
  const rows = response.data ?? [];
  return rows.flatMap((row) => {
    const close = row.close;
    if (!row.date || !Number.isFinite(close) || close < 0) return [];
    const time = Date.parse(row.date);
    if (!Number.isFinite(time)) return [];
    return [{ date: row.date, close }];
  });
}

export function premiumSeries(
  rows: readonly { date: string; close: number }[],
  color: string,
): ResolvedSeries[] {
  if (rows.length < 2) return [];
  return [staticSeries(
    rows.map((row) => scalarPoint(new Date(row.date), row.close)),
    { id: "premium", label: "Premium", color, calendarSpaced: true },
  )];
}
