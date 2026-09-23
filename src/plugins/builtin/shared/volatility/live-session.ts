import { useEffect, useRef, useState } from "react";
import { getPublishedUsEquitySession } from "../../../../market-data/published-us-sessions";
import { useAppVisible } from "../../../../state/app/activity";
import { zonedWallClockToUtcMs } from "../../../../utils/zoned-date-time";

/**
 * Listed US options trade only the regular equity session: there is no
 * extended-hours options market, so a chain or surface can only move between
 * the open and the close (13:00 on published early closes).
 */
export interface OptionsSessionState {
  open: boolean;
  /** The next open or close, used to re-evaluate exactly at the boundary. */
  nextChangeAt: number | null;
}

const NEW_YORK = "America/New_York";
const DAY_MS = 86_400_000;
const NEW_YORK_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: NEW_YORK, year: "numeric", month: "2-digit", day: "2-digit" });
/** Timers longer than this re-check instead of trusting a multi-day wait. */
const MAX_BOUNDARY_WAIT_MS = 6 * 60 * 60_000;

function newYorkDate(time: number): string {
  return NEW_YORK_DATE.format(time);
}

/** Published NYSE hours where covered; outside that range, weekdays 09:30 to 16:00 New York. */
function regularSession(date: string): { open: number; close: number } | null {
  const published = getPublishedUsEquitySession("NYSE", date);
  if (published) return published.kind === "session" ? { open: published.open, close: published.close } : null;
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (weekday === 0 || weekday === 6) return null;
  return {
    open: zonedWallClockToUtcMs(NEW_YORK, year, month, day, 9, 30, 0),
    close: zonedWallClockToUtcMs(NEW_YORK, year, month, day, 16, 0, 0),
  };
}

export function usOptionsSession(now: number): OptionsSessionState {
  if (!Number.isFinite(now)) return { open: false, nextChangeAt: null };
  const date = newYorkDate(now);
  const today = regularSession(date);
  if (today && now >= today.open && now < today.close) return { open: true, nextChangeAt: today.close };
  if (today && now < today.open) return { open: false, nextChangeAt: today.open };
  // Calendar-date steps, so a daylight-saving day cannot skip or repeat a date.
  const midnight = Date.parse(`${date}T00:00:00Z`);
  for (let offset = 1; offset <= 10; offset += 1) {
    const next = regularSession(new Date(midnight + offset * DAY_MS).toISOString().slice(0, 10));
    if (next && next.open > now) return { open: false, nextChangeAt: next.open };
  }
  return { open: false, nextChangeAt: null };
}

/**
 * Whether the US options market is in its regular session. Re-evaluated at the
 * next open or close while the app is visible; a hidden app keeps its last answer.
 */
export function useOptionsSessionOpen(enabled = true): boolean {
  const visible = useAppVisible();
  const [state, setState] = useState(() => usOptionsSession(Date.now()));
  useEffect(() => {
    if (!enabled || !visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = () => {
      const now = Date.now();
      const next = usOptionsSession(now);
      setState((current) => current.open === next.open && current.nextChangeAt === next.nextChangeAt ? current : next);
      const wait = next.nextChangeAt == null ? MAX_BOUNDARY_WAIT_MS
        : Math.min(MAX_BOUNDARY_WAIT_MS, Math.max(1_000, next.nextChangeAt - now + 250));
      timer = setTimeout(update, wait);
    };
    update();
    return () => { if (timer) clearTimeout(timer); };
  }, [enabled, visible]);
  // An answer from before its own boundary is recomputed rather than trusted.
  return state.nextChangeAt != null && Date.now() >= state.nextChangeAt ? usOptionsSession(Date.now()).open : state.open;
}

/**
 * Calls `refresh` every `intervalMs` while enabled, the app is visible and the
 * options market is open. It never fires on mount, since the caller already
 * loads once; returning after a hidden stretch longer than the interval fires
 * straight away. A refresh still in flight is never overlapped by the next.
 * Returns whether the refresh cycle is running, which is what "live" means.
 */
export function useLiveSessionRefresh(
  refresh: () => void | Promise<unknown>,
  intervalMs: number,
  enabled: boolean,
): boolean {
  const visible = useAppVisible();
  const open = useOptionsSessionOpen(enabled);
  const active = enabled && visible && open;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const lastRef = useRef(Date.now());
  useEffect(() => {
    if (!active) return;
    let inFlight = false;
    let cancelled = false;
    const run = () => {
      if (inFlight || cancelled) return;
      lastRef.current = Date.now();
      let pending: void | Promise<unknown>;
      try { pending = refreshRef.current(); } catch { return; }
      if (pending && typeof (pending as Promise<unknown>).then === "function") {
        inFlight = true;
        void (pending as Promise<unknown>).catch(() => {}).finally(() => { inFlight = false; });
      }
    };
    if (Date.now() - lastRef.current >= intervalMs) run();
    const timer = setInterval(run, intervalMs);
    return () => { cancelled = true; clearInterval(timer); };
  }, [active, intervalMs]);
  return active;
}

/**
 * The latest value, published at most once per `intervalMs`. The trailing value
 * is never dropped, and a new `resetKey` (another contract, expiry or ticker)
 * publishes immediately so a selection change never waits on the throttle.
 */
export function useThrottledValue<T>(value: T, intervalMs: number, resetKey?: unknown): T {
  const [state, setState] = useState(() => ({ value, key: resetKey }));
  const appliedAtRef = useRef(Date.now());
  const latestRef = useRef(value);
  latestRef.current = value;
  const keyChanged = !Object.is(state.key, resetKey);
  useEffect(() => {
    if (Object.is(state.value, value) && !keyChanged) return;
    const wait = keyChanged ? 0 : appliedAtRef.current + intervalMs - Date.now();
    const apply = () => {
      appliedAtRef.current = Date.now();
      setState({ value: latestRef.current, key: resetKey });
    };
    if (wait <= 0) { apply(); return; }
    const timer = setTimeout(apply, wait);
    return () => clearTimeout(timer);
  }, [value, resetKey, intervalMs, keyChanged, state.value]);
  return keyChanged ? value : state.value;
}
