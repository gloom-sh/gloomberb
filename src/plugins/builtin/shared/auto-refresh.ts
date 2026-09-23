import { useEffect, useRef, useState } from "react";
import { usePaneVisible } from "../../../state/app/activity";
import { useAppSelector } from "../../../state/app/context";
import { formatRelativeAge } from "../../../utils/relative-time";

/** The label only changes once a minute, so a coarse tick is enough. */
export const AGE_TICK_MS = 30_000;

/**
 * How old a pane's data is, as a footer-ready label that keeps ageing on its
 * own. Returns null before the first successful load so callers can leave the
 * footer empty instead of claiming a freshness they do not have. The clock
 * rests while the pane cannot be seen and catches up when it can.
 */
export function useUpdatedAgo(lastUpdated: number | null): string | null {
  const visible = usePaneVisible();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!lastUpdated || !visible) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [lastUpdated, visible]);

  return lastUpdated ? formatRelativeAge(lastUpdated, now) : null;
}

export interface AutoRefreshOptions {
  /**
   * Cadence for a pane whose data moves faster than research data, such as a
   * delayed curve during its session. Omitted, or not a positive number, the
   * pane follows the refresh interval the user configured.
   */
  intervalMs?: number | null;
}

/**
 * When the next automatic refresh is due: one interval after the newer of the
 * last good data and the last attempt this hook made. Counting from the last
 * attempt is what stops a dead endpoint from turning into a retry storm.
 */
function nextAutoRefreshAt(
  lastUpdated: number | null,
  lastAttemptAt: number,
  intervalMs: number,
): number {
  return Math.max(lastUpdated ?? Number.NEGATIVE_INFINITY, lastAttemptAt) + intervalMs;
}

/**
 * Re-pull a pane once its data is one interval old, so network panes follow
 * the one cadence the user already configured instead of each hardcoding its
 * own. Callers that know their data moves faster pass `intervalMs`.
 *
 * Each refresh is scheduled from `lastUpdated` rather than on a free-running
 * timer, so data never ages to twice the interval. The clock rests while the
 * pane cannot be seen (the app is hidden or the pane is covered) and, once it
 * can, data that came due meanwhile refreshes at once. Pass `null` for data
 * that has never loaded or that the pane already treats as stale: the hook
 * then retries one interval after its last attempt. Mounting counts as an
 * attempt, because a pane loads its data on mount.
 */
export function useAutoRefresh(
  lastUpdated: number | null,
  refresh: () => void,
  options: AutoRefreshOptions = {},
): void {
  const intervalMinutes = useAppSelector((state) => state.config.refreshIntervalMinutes);
  const visible = usePaneVisible();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const lastAttemptRef = useRef(Date.now());
  const intervalMs = options.intervalMs != null && options.intervalMs > 0
    ? options.intervalMs
    : intervalMinutes > 0 ? intervalMinutes * 60_000 : 0;

  useEffect(() => {
    if (!(intervalMs > 0) || !visible) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      const delay = nextAutoRefreshAt(lastUpdated, lastAttemptRef.current, intervalMs) - Date.now();
      timer = setTimeout(() => {
        timer = null;
        lastAttemptRef.current = Date.now();
        refreshRef.current();
        // A successful load moves `lastUpdated` and reschedules through the
        // effect; a failed one waits a full interval from this attempt.
        schedule();
      }, Math.max(0, delay));
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs, lastUpdated, visible]);
}
