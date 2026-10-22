import type { DataProvider } from "../../../types/data-provider";
import { loadCpiBoard } from "../cpi/client";
import { loadEarningsBoard } from "../earnings/client";
import { loadEarningsCalendar } from "../earnings/data/cache";
import { loadRatePath } from "../rate-path/client";
import type { ScheduledEventSources } from "./scheduled";

/**
 * The next event dates from the data the app already shows: the earnings
 * calendar ERN reads, the CPI board's release calendar and the FOMC meetings
 * WIRP prices, each through its own cache. Results come from ERN's board,
 * where a report's actual EPS lands, and from the per-ticker calendar when
 * the board cannot be read.
 */
export function scheduledEventSources(marketData: DataProvider | null | undefined): ScheduledEventSources {
  return {
    async earnings(symbols) {
      if (!marketData?.getEarningsCalendar) throw new Error("Earnings dates are not available.");
      return (await loadEarningsCalendar(marketData, symbols)).events;
    },
    async cpi() {
      return (await loadCpiBoard()).payload;
    },
    async fomc() {
      return (await loadRatePath()).meetings;
    },
    async results(symbols, from, to) {
      try {
        const board = await loadEarningsBoard({ from, to, perDay: 0, symbols });
        return board.payload.reports.map((report) => ({
          symbol: report.symbol, date: report.date, epsActual: report.epsActual, epsEstimate: report.epsEstimate,
        }));
      } catch (error) {
        if (!marketData?.getEarningsCalendar) throw error;
        return (await loadEarningsCalendar(marketData, symbols)).events.map((event) => ({
          symbol: event.symbol,
          date: event.earningsDate.toISOString().slice(0, 10),
          epsActual: event.epsActual,
          epsEstimate: event.epsEstimate,
        }));
      }
    },
  };
}
