import { surfaceSheetSnapshot, surfaceSheetTenors, type SurfaceExpiry, type SurfaceSnapshot } from "./model";

/** In session, while visible, a real-time surface reloads at this cadence. */
export const SURFACE_LIVE_RELOAD_MS = 15_000;

export type SurfaceSheetTenors = ReadonlyArray<{ label: string; years: number }>;

/** The rows the 3D sheet drew for one settled set of listed expiries. */
export interface SurfaceSheetAxes {
  identity: string;
  expirations: readonly number[];
  /** Constant maturities of a delta sheet; null draws the listed expiries. */
  tenors: SurfaceSheetTenors | null;
}

export interface StableSurfaceSheet<T extends SurfaceSnapshot> {
  snapshot: T;
  omitted: SurfaceExpiry[];
  tenors: SurfaceSheetTenors | null;
  /** Axes to hold for the next reload; null while the snapshot is still loading. */
  axes: SurfaceSheetAxes | null;
}

function sheetIdentity(snapshot: SurfaceSnapshot): string {
  return `${snapshot.symbol}|${snapshot.expiries.map((entry) => entry.expiration).join(",")}`;
}

/**
 * The 3D sheet's rows and constant maturities. A reload over the same listed
 * expiries keeps the rows and tenors it drew before, even when one smile's fit
 * falls back or moves the edge of the supported range, so the renderer can
 * morph the sheet instead of swapping it. Another underlying, a different set
 * of expiries or a snapshot still loading chooses afresh.
 */
export function stableSurfaceSheet<T extends SurfaceSnapshot>(snapshot: T, previous: SurfaceSheetAxes | null): StableSurfaceSheet<T> {
  const settled = snapshot.loaded >= snapshot.requested;
  const identity = sheetIdentity(snapshot);
  if (settled && previous?.identity === identity) {
    const kept = new Set(previous.expirations);
    return {
      snapshot: { ...snapshot, expiries: snapshot.expiries.filter((entry) => kept.has(entry.expiration)) },
      omitted: snapshot.expiries.filter((entry) => !kept.has(entry.expiration) && entry.fit != null && entry.fit.method !== "svi"),
      tenors: previous.tenors,
      axes: previous,
    };
  }
  const sheet = surfaceSheetSnapshot(snapshot);
  const tenors = surfaceSheetTenors(sheet.snapshot);
  return { ...sheet, tenors,
    axes: settled ? { identity, expirations: sheet.snapshot.expiries.map((entry) => entry.expiration), tenors } : null };
}

const UTC_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

/**
 * What the surface's quotes are and when they were observed: the oldest
 * loaded expiry sets the as-of, so a slow slice is never passed off as fresh.
 * Real-time only when every loaded slice is; nothing here says "live".
 */
export function surfaceFreshnessLabel(snapshot: SurfaceSnapshot, defaultDelayMinutes: number): string | null {
  const loaded = snapshot.expiries.filter((entry) => entry.state !== "loading");
  if (!loaded.length) return null;
  const realtime = loaded.filter((entry) => entry.dataSource === "live").length;
  const delay = Math.max(0, ...loaded.map((entry) => entry.dataSource === "live" ? 0 : entry.delayMinutes ?? 0)) || defaultDelayMinutes;
  const basis = realtime === loaded.length ? "real-time" : realtime > 0 ? "mixed real-time and delayed" : `${delay}m delayed`;
  const observed = loaded.map((entry) => entry.asOf ? Date.parse(entry.asOf) : Number.NaN).filter(Number.isFinite);
  return observed.length ? `${basis} · as of ${UTC_TIME.format(Math.min(...observed))} UTC` : basis;
}
