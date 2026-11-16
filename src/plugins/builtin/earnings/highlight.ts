import type { DataProvider } from "../../../types/data-provider";
import { boardKey, historyListing, type BoardReport } from "./board-model";
import { loadEarningsHistory, noHistoryAbroad } from "./client";
import { loadEarningsCalendar } from "./data/cache";
import { historyRows } from "./history-model";

interface EarningsHighlight {
  report: BoardReport;
  stale: boolean;
  refreshError: string | null;
}

export async function loadEarningsHighlight(symbol: string, today: string, provider: DataProvider | null, force: boolean, accessKey: string): Promise<EarningsHighlight | null> {
  const { listing, abroad, ownAbroad } = historyListing(symbol);
  const [history, upcoming] = await Promise.allSettled([
    abroad ? Promise.resolve(null)
      : ownAbroad ? loadEarningsHistory(listing, force, undefined, accessKey).catch(noHistoryAbroad)
        : loadEarningsHistory(listing, force),
    loadEarningsCalendar(provider, [symbol], { force }),
  ]);
  const payload = history.status === "fulfilled" ? history.value?.payload ?? null : null;
  const event = upcoming.status === "fulfilled" ? upcoming.value.events[0] ?? null : null;
  const rows = historyRows(payload, today, event, { abroad: ownAbroad });
  const row = rows.find((candidate) => candidate.upcoming) ?? rows[0];
  if (row) {
    const key = boardKey(symbol);
    const source = payload?.reports.find((report) => report.date === row.date);
    return {
      report: {
        key: `${key}:${row.date}`, symbol: key, name: payload?.name ?? event?.name ?? key,
        date: row.date, timing: row.timing, expectedTiming: row.expectedTiming, dateStatus: row.dateStatus,
        marketCap: source?.marketCap ?? null,
        epsEstimate: row.epsEstimate, epsAnalysts: row.epsAnalysts, epsActual: row.epsActual,
        provisional: row.provisional, epsBasis: row.epsBasis, epsSurprise: row.epsSurprise,
        revenueEstimate: row.revenueEstimate, impliedMove: row.implied, averageMove: null, realizedMove: row.move,
        owned: null, currency: row.currency ?? "USD",
      },
      stale: (history.status === "fulfilled" && !!history.value?.stale) || (upcoming.status === "fulfilled" && upcoming.value.stale),
      refreshError: history.status === "rejected" ? (history.reason instanceof Error ? history.reason.message : String(history.reason))
        : history.value?.refreshError ?? (upcoming.status === "rejected" ? (upcoming.reason instanceof Error ? upcoming.reason.message : String(upcoming.reason)) : upcoming.value.refreshError) ?? null,
    };
  }
  if (history.status === "rejected") throw history.reason;
  if (upcoming.status === "rejected") throw upcoming.reason;
  if (upcoming.value.refreshError) throw new Error(upcoming.value.refreshError);
  return null;
}
