import type { DataProvider } from "../../../types/data-provider";
import { loadCpiBoard } from "../cpi/client";
import { loadEarningsCalendar } from "../earnings/data/cache";
import { loadRatePath } from "../rate-path/client";
import type { ScheduledEventSources } from "./scheduled";

/**
 * The next event dates from the data the app already shows: the earnings
 * calendar ERN reads, the CPI board's release calendar and the FOMC meetings
 * WIRP prices, each through its own cache.
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
  };
}
