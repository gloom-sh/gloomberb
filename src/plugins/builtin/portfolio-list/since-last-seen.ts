import { useCallback, useEffect, useRef, useState } from "react";
import { priceColor, toneTintBg } from "../../../theme/colors";

/** How long the pane must be out of sight before coming back recaps what moved. */
export type SinceLastSeenAfter = "off" | "30s" | "2m" | "10m";

const AFTER_MS: Record<Exclude<SinceLastSeenAfter, "off">, number> = {
  "30s": 30_000,
  "2m": 120_000,
  "10m": 600_000,
};

export function sinceLastSeenAfterMs(after: SinceLastSeenAfter): number | null {
  return after === "off" ? null : AFTER_MS[after];
}

/** How long LAST stays tinted, and the lighter tail at its end before the tint clears. */
const RECAP_MS = 6_000;
const RECAP_FADE_MS = 1_500;

/** The tint behind LAST for a row's move: a ticker badge's tint in the move's tone, lighter in the tail. */
export function sinceLastSeenTint(move: number, fading: boolean): string {
  return toneTintBg(priceColor(move), fading ? 0.5 : 1);
}

/**
 * Each row's percent move from `before` to `after`. A row missing from either
 * side, or whose move rounds to 0.00%, is left out, so only what moved shows.
 */
function movesSince(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): Map<string, number> {
  const moves = new Map<string, number>();
  for (const [symbol, previous] of before) {
    const current = after.get(symbol);
    if (current == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) continue;
    const percent = ((current - previous) / Math.abs(previous)) * 100;
    if (Math.abs(percent) >= 0.005) moves.set(symbol, percent);
  }
  return moves;
}

interface Departure {
  at: number;
  prices: ReadonlyMap<string, number>;
}

// By pane instance, outside React, so a pane unmounted while its layout tab is
// hidden still finds what it showed when it comes back. Nothing is persisted.
const departures = new Map<string, Departure>();

function noteDeparture(paneKey: string, at: number, prices: ReadonlyMap<string, number>): void {
  departures.set(paneKey, { at, prices });
}

/**
 * A pane back in sight draws the prices it last had until fresh quotes land:
 * one remounted from a hidden layout tab, or an app that was hidden, has had
 * none while away. Prices that arrive this soon after coming back still count
 * toward the moves; later ones are ticks the user watched.
 */
const RETURN_SETTLE_MS = 3_000;

interface ReturnWindow {
  /** What LAST showed when the pane went out of sight. */
  prices: ReadonlyMap<string, number>;
  /** Until when prices still count toward the moves. */
  until: number;
}

/**
 * Coming back at `at`: the departure to read the moves against, or null when
 * the pane was away for less than `afterMs` or it is off (null). The departure
 * is used up either way: a short glance counts as having looked.
 */
function takeReturn(paneKey: string, at: number, afterMs: number | null): ReturnWindow | null {
  const departure = departures.get(paneKey);
  departures.delete(paneKey);
  if (!departure || afterMs == null || at - departure.at < afterMs) return null;
  return { prices: departure.prices, until: at + RETURN_SETTLE_MS };
}

/**
 * The moves since the departure at `at`: the rows already `shown`, each kept at
 * its first move so a tick in the first moments back never flips a tint, and
 * any row that has moved since. Null while nothing new moved, and once the
 * window has passed.
 */
function returnMoves(
  back: ReturnWindow,
  at: number,
  prices: ReadonlyMap<string, number>,
  shown?: ReadonlyMap<string, number>,
): Map<string, number> | null {
  if (at > back.until) return null;
  const moves = new Map(shown);
  for (const [symbol, move] of movesSince(back.prices, prices)) {
    if (!moves.has(symbol)) moves.set(symbol, move);
  }
  return moves.size > (shown?.size ?? 0) ? moves : null;
}

export interface SinceLastSeenRecap {
  /** Each row's move since the user left, in percent. LAST is tinted by its sign. */
  moves: ReadonlyMap<string, number>;
  fading: boolean;
}

/**
 * Snapshots the prices when the pane goes out of sight and, on coming back
 * after `afterMs`, returns each row's move since then for a few seconds. Out
 * of sight is the pane's own visibility (another layout tab, covered,
 * unmounted) or the app's (in the background), never which pane has focus: a
 * table on screen beside the focused pane is still being watched. `dismiss`
 * ends it early (a key or a click in the table); otherwise it ends by itself.
 */
export function useSinceLastSeen({
  paneKey,
  present,
  afterMs,
  readPrices,
  pricesVersion,
  resetKey,
}: {
  paneKey: string | undefined;
  /** The pane is on screen in an app the user is in. */
  present: boolean;
  /** Null turns it off; a departure is still used up on coming back. */
  afterMs: number | null;
  readPrices: () => ReadonlyMap<string, number>;
  /** Changes when the prices `readPrices` reads do. */
  pricesVersion: unknown;
  /** What the rows are (the collection, the view): a change ends the recap. */
  resetKey?: unknown;
}): { recap: SinceLastSeenRecap | null; dismiss: () => void } {
  const [recap, setRecap] = useState<SinceLastSeenRecap | null>(null);
  const readPricesRef = useRef(readPrices);
  readPricesRef.current = readPrices;
  const afterMsRef = useRef(afterMs);
  afterMsRef.current = afterMs;
  const returnRef = useRef<ReturnWindow | null>(null);
  const shownRef = useRef<ReadonlyMap<string, number> | undefined>(undefined);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const dismiss = useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
    returnRef.current = null;
    shownRef.current = undefined;
    setRecap((current) => (current ? null : current));
  }, []);

  const showMoves = useCallback(() => {
    const back = returnRef.current;
    if (!back) return;
    const now = Date.now();
    if (now > back.until) {
      returnRef.current = null;
      return;
    }
    const moves = returnMoves(back, now, readPricesRef.current(), shownRef.current);
    if (!moves) return;
    shownRef.current = moves;
    setRecap((current) => ({ moves, fading: current?.fading ?? false }));
    if (timersRef.current.length > 0) return;
    timersRef.current = [
      setTimeout(() => setRecap((current) => current && { ...current, fading: true }), RECAP_MS - RECAP_FADE_MS),
      setTimeout(dismiss, RECAP_MS),
    ];
  }, [dismiss]);

  // Only coming into sight and going out of it count: changing the setting or
  // the view while looking is neither.
  useEffect(() => {
    if (!paneKey || !present) return;
    returnRef.current = takeReturn(paneKey, Date.now(), afterMsRef.current);
    showMoves();
    return () => {
      dismiss();
      noteDeparture(paneKey, Date.now(), readPricesRef.current());
    };
  }, [dismiss, paneKey, present, showMoves]);

  useEffect(() => {
    showMoves();
  }, [pricesVersion, showMoves]);

  const resetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (Object.is(resetKeyRef.current, resetKey)) return;
    resetKeyRef.current = resetKey;
    dismiss();
  }, [dismiss, resetKey]);

  return { recap, dismiss };
}
