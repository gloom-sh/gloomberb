import { useEffect, useRef, useState } from "react";
import { useAppSelector } from "../../../state/app/context";
import { formatRelativeAge } from "../../../utils/relative-time";

/** The label only changes once a minute, so a coarse tick is enough. */
const AGE_TICK_MS = 30_000;

/**
 * How old a pane's data is, as a footer-ready label that keeps ageing on its
 * own. Returns null before the first successful load so callers can leave the
 * footer empty instead of claiming a freshness they do not have.
 */
export function useUpdatedAgo(lastUpdated: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!lastUpdated) return;
    const timer = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(timer);
  }, [lastUpdated]);

  return lastUpdated ? formatRelativeAge(lastUpdated, now) : null;
}

/**
 * Re-pull a pane once its data is older than the global refresh interval, so
 * network panes follow the one cadence the user already configured instead of
 * each hardcoding its own.
 *
 * The timer runs on the interval itself rather than a faster poll: a load that
 * failed is retried on the next tick, and a load that succeeded early is left
 * alone, so a dead endpoint can never turn into a retry storm.
 */
export function useAutoRefresh(lastUpdated: number | null, refresh: () => void): void {
  const intervalMinutes = useAppSelector((state) => state.config.refreshIntervalMinutes);
  const refreshRef = useRef(refresh);
  const lastUpdatedRef = useRef(lastUpdated);
  refreshRef.current = refresh;
  lastUpdatedRef.current = lastUpdated;

  useEffect(() => {
    if (!(intervalMinutes > 0)) return;
    const intervalMs = intervalMinutes * 60_000;
    const timer = setInterval(() => {
      const previous = lastUpdatedRef.current;
      if (previous && Date.now() - previous < intervalMs) return;
      refreshRef.current();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMinutes]);
}
