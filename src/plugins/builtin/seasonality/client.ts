import { unavailableText } from "../../../components/ui/status";
import { markSavedCopy } from "../../../data/saved-copies";
import { getSharedMarketDataCoordinator, MarketDataCoordinator, resolveEntryValue } from "../../../market-data/coordinator";
import { isContinuousFuture, rollAdjustedHistory } from "../../../market-data/futures-roll-returns";
import type { ChartRequest, InstrumentRef } from "../../../market-data/request-types";
import type { ManualChartResolution } from "../../../time-series/resolution";
import type { DataProvider } from "../../../types/data-provider";
import type { PricePoint } from "../../../types/financials";
import { abortable, abortError } from "../../../utils/async-deadline";
import { errorMessage } from "../../../utils/errors";
import { logFailure } from "../../../utils/log-failure";
import { settledClose, type SettledClose } from "./model";

export interface SeasonalityHistory {
  history: PricePoint[];
  stale: boolean;
  error: string | null;
  fetchedAt: number;
  /** A continuous future's returns, read within one contract at each roll: "rolls back-adjusted" (rollAdjustedHistory). */
  rollNote?: string;
  /**
   * The bars as served and their size, what a capture hands the pane to read
   * again: a continuous future's daily bars before their rolls were closed,
   * anything else's `history` itself, and beside monthly bars the daily ones
   * that name the running month's close (`lastClose`).
   */
  served: { points: PricePoint[]; resolution: ManualChartResolution; daily?: PricePoint[] };
  /**
   * Monthly cadence: the latest session close that had settled when the
   * history was read, which the running month and the year to date run to
   * (`projectSeasonality`). Null when no daily bars could be read.
   */
  lastClose?: SettledClose | null;
}

/** Monthly closes for the Returns and Overlay tabs, daily closes for Weekdays. */
export type SeasonalityCadence = "monthly" | "daily";

const CANCELLED = "Seasonality history load was cancelled";
/** The cadence each tab reads, and so the cadence a screenshot of it captures. */
const SEASONALITY_HISTORY_RESOLUTION: Record<SeasonalityCadence, ManualChartResolution> = { monthly: "1mo", daily: "1d" };
/** Daily history is served to five years; a longer request can come back as weekly bars. */
const BUFFER_RANGE = { monthly: "ALL", daily: "5Y" } as const;

/**
 * The daily bars that date the running month (`settledClose`): a month is
 * enough to hold the latest settled session, and a new month's first days.
 */
function lastCloseRequest(instrument: InstrumentRef): ChartRequest {
  return { instrument, bufferRange: "1M", granularity: "resolution", resolution: "1d" };
}

/**
 * The bars a tab reads: monthly or daily ones, and for a continuous future
 * (NG=F) daily ones either way, the newest a read returns (all of NG=F's,
 * from August 2000), whose rolls are back-adjusted before the months are
 * taken. A lookback reaching before them says where they start
 * (SeasonalityModel.historyStart).
 */
function seasonalityRequest(instrument: InstrumentRef, cadence: SeasonalityCadence): ChartRequest {
  if (isContinuousFuture(instrument.symbol)) {
    return { instrument, bufferRange: "ALL", granularity: "resolution", resolution: "1d", newestBars: true };
  }
  return { instrument, bufferRange: BUFFER_RANGE[cadence], granularity: "resolution", resolution: SEASONALITY_HISTORY_RESOLUTION[cadence] };
}

/**
 * A continuous future's daily bars with every roll back-adjusted, as the tab
 * reads them: the Weekdays tab the last five years of sessions, the others
 * each month's last close dated by the month's first day, as monthly bars
 * are. Anything else as served.
 */
function seasonalitySeries(
  bars: readonly PricePoint[], instrument: InstrumentRef, cadence: SeasonalityCadence, fetchedAt: number,
): Pick<SeasonalityHistory, "history" | "rollNote" | "served" | "lastClose"> {
  const symbol = instrument.symbol;
  if (!isContinuousFuture(symbol)) {
    return { history: [...bars], served: { points: [...bars], resolution: SEASONALITY_HISTORY_RESOLUTION[cadence] } };
  }
  const adjusted = rollAdjustedHistory(bars, symbol);
  const note = { served: { points: [...bars], resolution: "1d" as const }, ...adjusted.note ? { rollNote: adjusted.note } : {} };
  if (cadence === "daily") {
    const from = new Date(adjusted.points.at(-1)?.date ?? 0);
    from.setUTCFullYear(from.getUTCFullYear() - 5);
    return { history: adjusted.points.filter((point) => new Date(point.date).getTime() > from.getTime()), ...note };
  }
  const months = new Map<string, PricePoint>();
  for (const point of adjusted.points) {
    const day = new Date(point.date).toISOString();
    months.set(day.slice(0, 7), { date: new Date(`${day.slice(0, 7)}-01T00:00:00Z`), close: point.close });
  }
  // Its daily bars already hold the latest settled session, on the same roll-adjusted level as its months.
  return { history: [...months.values()], ...note, lastClose: settledClose(adjusted.points, { symbol, exchange: instrument.exchange, fetchedAt }) };
}

/** The settled close in daily bars read beside the monthly ones; null when they could not be read. */
function lastCloseOf(entry: { fetchedAt?: number | null } | null, bars: readonly PricePoint[] | null | undefined, instrument: InstrumentRef, now: number) {
  return entry && bars?.length ? settledClose(bars, { symbol: instrument.symbol, exchange: instrument.exchange, fetchedAt: entry.fetchedAt ?? now }) : null;
}

export function cachedSeasonalityHistory(
  request: { instrument: InstrumentRef; cadence?: SeasonalityCadence },
): SeasonalityHistory | null {
  const coordinator = getSharedMarketDataCoordinator();
  if (!coordinator) return null;
  const cadence = request.cadence ?? "monthly";
  const entry = coordinator.getChartEntry(seasonalityRequest(request.instrument, cadence));
  const served = resolveEntryValue(entry);
  if (!served?.length) return null;
  const now = Date.now();
  const series = seasonalitySeries(served, request.instrument, cadence, entry.fetchedAt ?? now);
  const daily = cadence === "monthly" && !isContinuousFuture(request.instrument.symbol) ? coordinator.getChartEntry(lastCloseRequest(request.instrument)) : null;
  const data = {
    ...series,
    ...(daily ? { lastClose: lastCloseOf(daily, resolveEntryValue(daily), request.instrument, now) } : {}),
    stale: !!entry.error || (entry.staleAt != null && entry.staleAt <= now),
    error: entry.error?.message ?? null,
    fetchedAt: entry.fetchedAt ?? now,
  };
  const savedAt = entry.savedCopyAt ?? (data.stale ? entry.fetchedAt : null);
  return savedAt == null ? data : markSavedCopy(data, savedAt);
}

/**
 * Every month on record: the lookback is cut in the model, so changing it never
 * refetches. Monthly bars, because daily history is only served to 5Y where
 * provider support is not known yet, and a longer daily request comes back as
 * Monday-stamped weeks that file a week's close under the wrong month. The
 * Weekdays tab needs sessions, so it reads those five years of daily bars. A
 * continuous future reads the newest daily bars a request returns for every
 * tab, so its rolls can be back-adjusted (seasonalitySeries).
 */
export async function loadSeasonalityHistory(
  request: { instrument: InstrumentRef; cadence?: SeasonalityCadence; signal?: AbortSignal; forceRefresh?: boolean },
  marketData?: DataProvider,
): Promise<SeasonalityHistory> {
  if (request.signal?.aborted) throw abortError(CANCELLED);
  const cadence = request.cadence ?? "monthly";
  const now = Date.now();
  const coordinator = marketData ? new MarketDataCoordinator(marketData) : getSharedMarketDataCoordinator();
  try {
    if (!coordinator) throw new Error("Market data coordinator unavailable");
    // A month's bar is dated by its first day and its close can be the latest price or one days old: daily bars,
    // read beside it, name the session close the running month runs to. Without them it keeps its own close.
    const dated = cadence === "monthly" && !isContinuousFuture(request.instrument.symbol);
    const [entry, daily] = await Promise.all([
      abortable(coordinator.loadChart(seasonalityRequest(request.instrument, cadence), { forceRefresh: request.forceRefresh }), request.signal, CANCELLED),
      dated ? abortable(coordinator.loadChart(lastCloseRequest(request.instrument), { forceRefresh: request.forceRefresh }), request.signal, CANCELLED)
        .catch(logFailure("seasonality.client", "Load the daily closes that date the running month failed", null)) : null,
    ]);
    const series = seasonalitySeries(resolveEntryValue(entry) ?? [], request.instrument, cadence, entry.fetchedAt ?? now);
    const history = series.history;
    const dailyBars = daily ? resolveEntryValue(daily) ?? [] : [];
    const data = { ...series,
      ...(dated ? { lastClose: lastCloseOf(daily, dailyBars, request.instrument, now), served: { ...series.served, daily: [...dailyBars] } } : {}),
      stale: !!entry.error || (entry.staleAt != null && entry.staleAt <= now),
      error: entry.error?.message ?? (history.length ? null : unavailableText(cadence === "daily" ? "Daily price history" : "Monthly price history")),
      fetchedAt: entry.fetchedAt ?? now };
    return entry.savedCopyAt == null ? data : markSavedCopy(data, entry.savedCopyAt);
  } catch (error) {
    if (request.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw abortError(CANCELLED);
    return { history: [], stale: false, error: errorMessage(error), fetchedAt: now,
      served: { points: [], resolution: SEASONALITY_HISTORY_RESOLUTION[cadence] } };
  }
}
