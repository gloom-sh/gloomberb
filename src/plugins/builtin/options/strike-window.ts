import type { OptionsChain } from "../../../types/financials";
import { calculateOptionGreeks, solveChainVolatilities } from "./analytics";
import { findNearestStrikeIndex, formatStrikeLabel } from "./table";

/**
 * Which strikes of an expiry the chain lists. Every strike by default, as
 * layouts saved before the setting existed showed; or a count either side of
 * the money; or the strikes whose call or put delta falls in a band, which
 * reaches deep in-the-money LEAPS without scrolling past the wings.
 */
export type StrikeWindow =
  | { kind: "all" }
  | { kind: "around"; count: number }
  | { kind: "delta"; min: number; max: number };

/** The pane setting, and the `fn OMON --strikes` option that sets it. */
export const STRIKE_WINDOW_SETTING = "strikes";
export const ALL_STRIKES = "all";
const MAX_STRIKES_AROUND = 200;

const ALL: StrikeWindow = { kind: "all" };

/** Choices the query bar and the settings dialog offer; the CLI takes any count or band. */
export const STRIKE_WINDOW_PRESETS: ReadonlyArray<{ value: string; label: string; short: string; description: string }> = [
  { value: ALL_STRIKES, label: "All strikes", short: "All", description: "Every listed strike." },
  { value: "10", label: "10 either side of the money", short: "±10", description: "The strike nearest spot and 10 on each side." },
  { value: "20", label: "20 either side of the money", short: "±20", description: "The strike nearest spot and 20 on each side." },
  { value: "40", label: "40 either side of the money", short: "±40", description: "The strike nearest spot and 40 on each side." },
  { value: "0.70-0.90", label: "Delta .70 to .90", short: "Δ .70-.90", description: "In the money: calls below spot, puts above. A stock replacement band." },
  { value: "0.40-0.60", label: "Delta .40 to .60", short: "Δ .40-.60", description: "Near the money." },
  { value: "0.10-0.30", label: "Delta .10 to .30", short: "Δ .10-.30", description: "Out of the money on both wings." },
];

const BAND = /^(-?\d*\.?\d+)(?:-|to|,|:|\.\.)(-?\d*\.?\d+)$/;

/**
 * A band of absolute deltas as typed: `0.70-0.90`, `.7-.9`, `70-90` (read as
 * percent), `-0.9--0.7` (a put's signed deltas). Null when it is not one.
 */
export function parseDeltaBand(raw: string): { min: number; max: number } | null {
  const band = BAND.exec(raw.trim().toLowerCase().replace(/\s+/g, "").replace(/^(?:δ|delta:?)/, ""));
  if (!band) return null;
  let [low, high] = [Math.abs(Number(band[1])), Math.abs(Number(band[2]))];
  // 70-90 reads as a percent band, the way traders say it.
  if (low > 1 || high > 1) [low, high] = [low / 100, high / 100];
  if (!Number.isFinite(low) || !Number.isFinite(high) || low > 1 || high > 1) return null;
  return low <= high ? { min: low, max: high } : { min: high, max: low };
}

function parseWindowText(raw: string): StrikeWindow | null {
  const text = raw.trim().toLowerCase().replace(/\s+/g, "");
  if (text === ALL_STRIKES) return ALL;
  if (/^\d+$/.test(text)) {
    const count = Number(text);
    return count >= 1 && count <= MAX_STRIKES_AROUND ? { kind: "around", count } : null;
  }
  const band = parseDeltaBand(text);
  return band ? { kind: "delta", ...band } : null;
}

/** The window a pane setting holds; a missing or unreadable one is every strike. */
export function resolveStrikeWindow(value: unknown): StrikeWindow {
  return typeof value === "string" || typeof value === "number" ? parseWindowText(String(value)) ?? ALL : ALL;
}

/** The setting's stored text: `all`, `10`, `0.70-0.90`. */
export function strikeWindowValue(window: StrikeWindow): string {
  if (window.kind === "all") return ALL_STRIKES;
  if (window.kind === "around") return String(window.count);
  return `${window.min.toFixed(2)}-${window.max.toFixed(2)}`;
}

/** `fn OMON --strikes`: the window as typed, checked, in the setting's text. */
export function normalizeStrikeWindowOption(raw: string): string {
  const window = parseWindowText(raw);
  if (!window) {
    throw new Error(
      `Invalid strike window "${raw}". Use all, a count of strikes either side of the money (1 to ${MAX_STRIKES_AROUND}), `
      + "or a call or put delta band such as 0.70-0.90.",
    );
  }
  return strikeWindowValue(window);
}

const deltaText = (value: number) => value.toFixed(2).replace(/^0\./, ".");

/** The window on the query bar chip: All, ±10, Δ .70-.90. */
export function strikeWindowShortLabel(window: StrikeWindow): string {
  if (window.kind === "all") return "All";
  if (window.kind === "around") return `±${window.count}`;
  return `Δ ${deltaText(window.min)}-${deltaText(window.max)}`;
}

/** The absolute call and put delta at each strike, where the chain values them. */
export type StrikeDeltas = ReadonlyMap<number, { call?: number; put?: number }>;

/**
 * Deltas from the same solver and Greeks the chain shows, against one spot.
 * A strike without a two-sided quote on a side has no delta there.
 */
export function chainDeltasByStrike(
  chain: OptionsChain,
  spot: number | undefined,
  dividendYield: number | undefined,
  now: number = Date.now(),
): StrikeDeltas {
  const deltas = new Map<number, { call?: number; put?: number }>();
  if (spot == null) return deltas;
  const volatilities = solveChainVolatilities(chain, spot, dividendYield, now);
  for (const [side, contracts] of [["call", chain.calls], ["put", chain.puts]] as const) {
    for (const contract of contracts) {
      const delta = calculateOptionGreeks(contract, side, spot, dividendYield, volatilities)?.delta;
      if (delta == null || !Number.isFinite(delta)) continue;
      deltas.set(contract.strike, { ...deltas.get(contract.strike), [side]: Math.abs(delta) });
    }
  }
  return deltas;
}

export interface StrikeWindowResult {
  /** The strikes the chain lists, ascending. */
  strikes: number[];
  /** Strikes the expiry has. */
  total: number;
  /** Why the window could not be applied, so every strike is listed instead. */
  fallback: "no-price" | "no-delta" | null;
}

// Displayed deltas round to three places; a strike that reads .700 is in a .70 band.
const DELTA_TOLERANCE = 5e-4;

/**
 * The strikes a window keeps. `center` is the price the money is read at (the
 * held strike, else spot); `keep` is a strike that always stays, the held
 * contract's. A window that cannot be read without a price or deltas lists
 * every strike and says why.
 */
export function applyStrikeWindow(
  strikes: readonly number[],
  window: StrikeWindow,
  { center = null, deltas = null, keep = null }: {
    center?: number | null;
    deltas?: StrikeDeltas | null;
    keep?: number | null;
  } = {},
): StrikeWindowResult {
  const total = strikes.length;
  const every = (fallback: StrikeWindowResult["fallback"]): StrikeWindowResult => ({ strikes: [...strikes], total, fallback });
  if (window.kind === "all" || total === 0) return every(null);
  const kept = new Set<number>();
  if (window.kind === "around") {
    if (center == null || !Number.isFinite(center)) return every("no-price");
    const index = findNearestStrikeIndex([...strikes], center);
    for (const strike of strikes.slice(Math.max(0, index - window.count), index + window.count + 1)) kept.add(strike);
  } else {
    if (!deltas || deltas.size === 0) return every("no-delta");
    const inBand = (value: number | undefined) => value != null
      && value >= window.min - DELTA_TOLERANCE && value <= window.max + DELTA_TOLERANCE;
    for (const strike of strikes) {
      const delta = deltas.get(strike);
      if (inBand(delta?.call) || inBand(delta?.put)) kept.add(strike);
    }
  }
  if (keep != null && strikes.includes(keep)) kept.add(keep);
  return { strikes: strikes.filter((strike) => kept.has(strike)), total, fallback: null };
}

/**
 * What a report says about the strikes it lists: how many of how many, and
 * the window that chose them.
 */
export function strikeWindowNotice(window: StrikeWindow, result: StrikeWindowResult): string {
  const { strikes, total } = result;
  const range = strikes.length > 0 ? ` (${formatStrikeLabel(strikes[0]!)} to ${formatStrikeLabel(strikes.at(-1)!)})` : "";
  const more = " --strikes all lists every strike.";
  if (result.fallback === "no-price") return `All ${total} strikes${range}: no price to centre the window on.`;
  if (result.fallback === "no-delta") return `All ${total} strikes${range}: a delta band needs a current underlying quote.`;
  if (window.kind === "all") return `All ${total} strikes${range}.`;
  if (window.kind === "around") {
    return `${strikes.length} of ${total} strikes, ${window.count} either side of the money${range}.${more}`;
  }
  return `${strikes.length} of ${total} strikes with a call or put delta of ${window.min.toFixed(2)} to ${window.max.toFixed(2)}${range}.${more}`;
}
