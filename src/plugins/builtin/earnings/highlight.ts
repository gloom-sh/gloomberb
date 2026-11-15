import type { DataProvider } from "../../../types/data-provider";
import { boardKey, historyListing, type BoardReport } from "./board-model";
import { loadEarningsHistory, noHistoryAbroad } from "./client";
import { loadEarningsCalendar } from "./data/cache";
import { historyRows } from "./history-model";

export async function loadEarningsHighlight(symbol: string, today: string, provider: DataProvider | null, force: boolean, accessKey: string): Promise<BoardReport | null> {
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
      key: `${key}:${row.date}`, symbol: key, name: payload?.name ?? event?.name ?? key,
      date: row.date, timing: row.timing, expectedTiming: row.expectedTiming, dateStatus: row.dateStatus,
      marketCap: source?.marketCap ?? null,
      epsEstimate: row.epsEstimate, epsAnalysts: row.epsAnalysts, epsActual: row.epsActual,
      provisional: row.provisional, epsBasis: row.epsBasis, epsSurprise: row.epsSurprise,
      revenueEstimate: row.revenueEstimate, impliedMove: row.implied, averageMove: null,
      owned: null, currency: row.currency ?? "USD",
    };
  }
  if (history.status === "rejected") throw history.reason;
  if (upcoming.status === "rejected") throw upcoming.reason;
  if (upcoming.value.refreshError) throw new Error(upcoming.value.refreshError);
  return null;
}
