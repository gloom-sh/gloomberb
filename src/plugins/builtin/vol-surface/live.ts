import { surfaceSheetSnapshot, surfaceSheetTenors, type SurfaceExpiry, type SurfaceSnapshot } from "./model";

/** In session, while visible, a real-time surface reloads at this cadence. */
export const SURFACE_LIVE_RELOAD_MS = 15_000;

export type SurfaceSheetTenors = ReadonlyArray<{ label: string; years: number }>;

/** The constant maturities the 3D sheet drew for one settled set of listed expiries. */
export interface SurfaceSheetAxes {
  identity: string;
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
 * The 3D sheet's rows and constant maturities. Rows are always the smiles the
 * sheet rule accepts, so a fit that falls back never draws a hole or a wall.
 * A reload over the same listed expiries keeps the constant maturities it drew
 * before, even when an edge smile drops out, so a delta sheet keeps its shape
 * and the renderer can morph it; listed rows change only when a fit does.
 * Another underlying, a different set of expiries or a snapshot still loading
 * chooses afresh.
 */
export function stableSurfaceSheet<T extends SurfaceSnapshot>(snapshot: T, previous: SurfaceSheetAxes | null): StableSurfaceSheet<T> {
  const settled = snapshot.loaded >= snapshot.requested;
  const identity = sheetIdentity(snapshot);
  const sheet = surfaceSheetSnapshot(snapshot);
  const held = settled && previous?.identity === identity ? previous : null;
  const tenors = held ? held.tenors : surfaceSheetTenors(sheet.snapshot);
  return { ...sheet, tenors, axes: held ?? (settled ? { identity, tenors } : null) };
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
